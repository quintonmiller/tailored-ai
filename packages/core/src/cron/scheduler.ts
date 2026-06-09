import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { resolveAgent } from "../agent/agents.js";
import { executeHooks } from "../agent/hooks.js";
import { runAgentLoop } from "../agent/loop.js";
import { findOrCreateSession, resetSession } from "../agent/session.js";
import { getDiscordConfig } from "../channels/discord-config.js";
import type { CronJobConfig } from "../config.js";
import { saveMessage } from "../db/queries.js";
import type { ProjectRef } from "../projects/resolve.js";
import { expandPrompt } from "../prompts/expand.js";
import type { AgentRuntime } from "../runtime.js";
import type { WorkflowEngine } from "../workflows/engine.js";
import { compileSchedule } from "./schedule-dsl.js";

export interface CronSchedulerOptions {
  runtime: AgentRuntime;
  workflowEngine?: WorkflowEngine;
}

export class CronScheduler {
  private timers: Cron[] = [];
  private runtime: AgentRuntime;
  private workflowEngine: WorkflowEngine | undefined;

  constructor(opts: CronSchedulerOptions) {
    this.runtime = opts.runtime;
    this.workflowEngine = opts.workflowEngine;
  }

  setWorkflowEngine(engine: WorkflowEngine | undefined): void {
    this.workflowEngine = engine;
  }

  start(): void {
    const config = this.runtime.getConfig();
    if (!config.cron.enabled) return;
    const jobs = config.cron.jobs;
    if (!jobs.length) return;

    for (const job of jobs) {
      const jobEnabled = job.enabled !== false;
      this.upsertJobRow(job);

      if (!jobEnabled) {
        console.log(`[cron] Skipping disabled job "${job.name}"`);
        continue;
      }

      let compiledCron: string;
      try {
        compiledCron = compileSchedule(job.schedule).cron;
      } catch (err) {
        console.error(`[cron] Skipping "${job.name}": ${(err as Error).message}`);
        continue;
      }

      const timer = new Cron(compiledCron, () => {
        this.runJob(job).catch((err) => {
          console.error(`[cron] Error running job "${job.name}":`, err);
        });
      });

      this.timers.push(timer);
      const friendly = compiledCron === job.schedule ? job.schedule : `${job.schedule} → ${compiledCron}`;
      console.log(`[cron] Scheduled "${job.name}" (${friendly})`);
    }
  }

  stop(): void {
    for (const timer of this.timers) {
      timer.stop();
    }
    this.timers = [];
    console.log("[cron] Stopped all jobs");
  }

  restart(): void {
    this.stop();
    this.start();
  }

  triggerJob(name: string): void {
    const config = this.runtime.getConfig();
    const job = config.cron.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`Unknown job: ${name}`);
    this.runJob(job).catch((err) => {
      console.error(`[cron] Error running triggered job "${name}":`, err);
    });
  }

  /** Build the shared template variables for a job. */
  private buildTemplateVars(job: CronJobConfig, extras?: Record<string, string>): Record<string, string> {
    const vars: Record<string, string> = { ...extras };

    const row = this.runtime.db.prepare("SELECT last_run FROM cron_jobs WHERE name = ?").get(job.name) as
      | { last_run: string | null }
      | undefined;

    const lastRunStr = row?.last_run;
    const lastRunDate = lastRunStr ? new Date(`${lastRunStr}Z`) : null;
    const effectiveDate = lastRunDate ?? new Date(Date.now() - 3600_000);

    vars.last_run = effectiveDate.toISOString();
    vars.last_run_epoch = String(Math.floor(effectiveDate.getTime() / 1000));

    // last_response — look up the most recent assistant message in this job's session
    const sk = job.sessionKey ?? `cron:${job.name}`;
    const sessionRow = this.runtime.db.prepare("SELECT id FROM sessions WHERE key = ?").get(sk) as
      | { id: string }
      | undefined;
    let lastResponse = "";
    if (sessionRow) {
      const msgRow = this.runtime.db
        .prepare(
          "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND content IS NOT NULL ORDER BY id DESC LIMIT 1",
        )
        .get(sessionRow.id) as { content: string } | undefined;
      if (msgRow) lastResponse = `Your last response was:\n${msgRow.content}`;
    }
    vars.last_response = lastResponse;

    // next_task — read from agent's next_task.md (entire file = the task)
    let nextTask =
      "Create a new custom tool with admin(action=update_config, path='custom_tools.TOOLNAME', value={description:'...', parameters:{}, command:'...'}).";
    const jobAgent = job.agent ?? job.profile;
    if (jobAgent) {
      try {
        const agentDir = join(this.runtime.contextDir, "agents", jobAgent);
        const content = readFileSync(join(agentDir, "next_task.md"), "utf-8").trim();
        if (content) nextTask = content;
      } catch {
        // next_task.md doesn't exist yet — use default task
      }
    }
    vars.next_task = nextTask;

    return vars;
  }

  /**
   * Resolve the per-job project context.
   *
   * Priority:
   *   1. job.project — explicit binding in config.yaml
   *   2. runtime.getActiveProject() — if the job came from an active project's overlay,
   *      the runtime is already scoped to it, so no extra work needed
   *
   * Returns null when the job is global. Returns null (with a warning) if `job.project`
   * names a project that doesn't exist or has no path.
   */
  private resolveJobProject(job: CronJobConfig): ProjectRef | null {
    if (!job.project) return null;
    const ref = this.runtime.getProjectByName(job.project);
    if (!ref) {
      console.warn(
        `[cron] "${job.name}" references unknown project "${job.project}" (unregistered or no path) — running global`,
      );
      return null;
    }
    return ref;
  }

  private async resolvePrompt(job: CronJobConfig, vars?: Record<string, string>): Promise<string> {
    const templateVars = vars ?? this.buildTemplateVars(job);
    return expandPrompt(job.prompt, templateVars, this.runtime.getConfig().prompts);
  }

  private async runWorkflowJob(job: CronJobConfig): Promise<void> {
    if (!this.workflowEngine) {
      console.warn(`[cron] "${job.name}" references workflow "${job.workflow}" but no engine is configured`);
      return;
    }
    const reg = this.runtime.getWorkflows().get(job.workflow!);
    if (!reg) {
      console.warn(`[cron] "${job.name}" references unknown workflow "${job.workflow}"`);
      return;
    }
    const templateVars = this.buildTemplateVars(job);
    const prompt = await this.resolvePrompt(job, templateVars);
    const input = {
      prompt,
      job_name: job.name,
      agent: job.agent ?? job.profile,
      ...templateVars,
    };
    console.log(`[cron] Running "${job.name}" -> workflow:${job.workflow}`);
    try {
      const run = await this.workflowEngine.runWorkflow(job.workflow!, input, "cron");
      this.updateLastRun(job.name);
      if (run.status === "failed") {
        console.warn(`[cron] workflow ${run.workflow_name} failed: ${run.error}`);
      }
    } catch (err) {
      console.error(`[cron] workflow ${job.workflow} threw: ${(err as Error).message}`);
    }
  }

  private async runJob(job: CronJobConfig): Promise<void> {
    if (job.workflow) {
      await this.runWorkflowJob(job);
      return;
    }
    const wakeAgent = job.wakeAgent !== false; // default true
    const projectCtx = this.resolveJobProject(job);
    const projectId = projectCtx?.id ?? null;
    const sessionKey = job.sessionKey ?? (projectId ? `cron:${projectId}:${job.name}` : `cron:${job.name}`);
    const resolved = resolveAgent(
      job.agent ?? job.profile,
      this.runtime.getConfig(),
      this.runtime.getTools(),
      job.model,
      this.runtime.contextDir,
    );

    console.log(`[cron] Running "${job.name}" (${wakeAgent ? "wake" : "note"} mode)`);

    if (!wakeAgent) {
      await this.addNote(job, sessionKey, resolved.model);
      this.updateLastRun(job.name);
      return;
    }

    const session = job.newSession
      ? resetSession(this.runtime.db, sessionKey, resolved.model, resolved.provider, projectId)
      : findOrCreateSession(this.runtime.db, sessionKey, resolved.model, resolved.provider, projectId);

    const templateVars = this.buildTemplateVars(job);
    const hooks = this.runtime.resolveHooks({ agentName: job.agent ?? job.profile, overrideHooks: job.hooks });
    const logPrefix = `[cron] [${job.name}]`;
    const allTools = this.runtime.getTools();

    // --- beforeRun hooks ---
    if (hooks.beforeRun.length > 0) {
      const { outputs, skipped } = await executeHooks(
        hooks.beforeRun,
        allTools,
        templateVars,
        session.id,
        logPrefix,
        this.runtime.getConfig().prompts,
      );
      if (skipped) {
        console.log(`[cron] "${job.name}" skipped by beforeRun hook`);
        this.updateLastRun(job.name);
        return;
      }
      // Prepend non-empty hook outputs to the prompt as context
      const hookContext = outputs.filter((o) => o.trim()).join("\n\n---\n\n");
      if (hookContext) {
        templateVars._hook_context = hookContext;
      }
    }

    let prompt = await this.resolvePrompt(job, templateVars);
    if (templateVars._hook_context) {
      prompt = `${templateVars._hook_context}\n\n---\n\n${prompt}`;
    }

    const response = await runAgentLoop(prompt, {
      ...this.runtime.buildLoopOptions({
        session,
        agentName: job.agent ?? job.profile,
        modelOverride: job.model,
        project: projectCtx,
      }),
      onToolCall: (name, args) => {
        console.log(`[cron] [${job.name}] tool: ${name}(${JSON.stringify(args)})`);
      },
    });

    this.updateLastRun(job.name);

    // --- afterRun hooks ---
    if (hooks.afterRun.length > 0) {
      const afterVars = { ...templateVars, response: response ?? "" };
      await executeHooks(hooks.afterRun, allTools, afterVars, session.id, logPrefix, this.runtime.getConfig().prompts);
    }

    if (response && !response.trim().toUpperCase().includes("NO_ACTION")) {
      await this.deliver(job, response);
    } else {
      console.log(`[cron] "${job.name}" returned NO_ACTION, skipping delivery`);
    }
  }

  private async addNote(job: CronJobConfig, sessionKey: string, jobModel: string): Promise<void> {
    const config = this.runtime.getConfig();
    const session = findOrCreateSession(this.runtime.db, sessionKey, jobModel, config.agent.defaultProvider);

    const prompt = await this.resolvePrompt(job);
    saveMessage(this.runtime.db, session.id, {
      role: "user",
      content: prompt,
    });

    console.log(`[cron] Added note to session "${sessionKey}": "${prompt.slice(0, 80)}"`);
  }

  private async deliver(job: CronJobConfig, response: string): Promise<void> {
    const channel = job.delivery?.channel ?? "log";

    if (channel === "discord") {
      const target = job.delivery?.target;
      if (!target) {
        console.error(`[cron] Job "${job.name}" has discord delivery but no target channel ID`);
        return;
      }
      // The "discord"/"discord-dm" routing keys stay for back-compat; the live
      // sink is now resolved by channel id from the runtime's outbound registry
      // (#66) instead of a notifier hand-injected at construction.
      const out = this.runtime.getOutbound("discord");
      if (!out) {
        console.error(`[cron] Job "${job.name}" wants discord delivery but Discord is not connected`);
        return;
      }
      await out.send(target, response);
      console.log(`[cron] Delivered "${job.name}" response to Discord channel ${target}`);
      return;
    }

    if (channel === "discord-dm") {
      const target = job.delivery?.target ?? getDiscordConfig(this.runtime.getConfig())?.owner;
      if (!target) {
        console.error(
          `[cron] Job "${job.name}" has discord-dm delivery but no target user ID or discord owner configured`,
        );
        return;
      }
      const out = this.runtime.getOutbound("discord");
      if (!out) {
        console.error(`[cron] Job "${job.name}" wants discord-dm delivery but Discord is not connected`);
        return;
      }
      await out.sendDM(target, response);
      console.log(`[cron] Delivered "${job.name}" response as DM to user ${target}`);
      return;
    }

    // Default: log
    console.log(`[cron] [${job.name}] ${response}`);
  }

  private upsertJobRow(job: CronJobConfig): void {
    const projectId = job.project ?? null;
    const sessionKey = job.sessionKey ?? (projectId ? `cron:${projectId}:${job.name}` : `cron:${job.name}`);
    const enabled = job.enabled !== false ? 1 : 0;
    const existing = this.runtime.db.prepare("SELECT id FROM cron_jobs WHERE name = ?").get(job.name) as
      | { id: string }
      | undefined;

    if (existing) {
      this.runtime.db
        .prepare(
          "UPDATE cron_jobs SET schedule = ?, task = ?, model = ?, session_key = ?, project_id = ?, enabled = ? WHERE name = ?",
        )
        .run(job.schedule, job.prompt, job.model ?? null, sessionKey, projectId, enabled, job.name);
    } else {
      this.runtime.db
        .prepare(
          "INSERT INTO cron_jobs (id, name, schedule, task, model, session_key, project_id, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), job.name, job.schedule, job.prompt, job.model ?? null, sessionKey, projectId, enabled);
    }
  }

  private updateLastRun(name: string): void {
    this.runtime.db.prepare("UPDATE cron_jobs SET last_run = datetime('now') WHERE name = ?").run(name);
  }
}
