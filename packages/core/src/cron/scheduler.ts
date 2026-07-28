import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { resolveAgent } from "../agent/agents.js";
import { executeHooks } from "../agent/hooks.js";
import { runAgentLoop } from "../agent/loop.js";
import { findOrCreateSession, resetSession } from "../agent/session.js";
import type { CronJobConfig } from "../config.js";
import { saveMessage } from "../db/queries.js";
import { PASSTHROUGH_GATE, resolveGate } from "../notifications/dedup.js";
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

  /**
   * Run a job right now because someone asked (the UI's "Run now", the API).
   * Marked solicited, so its output bypasses repeat suppression — the user
   * asked for this specific answer and must get it even if it is unchanged.
   */
  triggerJob(name: string): void {
    const config = this.runtime.getConfig();
    const job = config.cron.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`Unknown job: ${name}`);
    this.runJob(job, { solicited: true }).catch((err) => {
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

  private async runJob(job: CronJobConfig, opts?: { solicited?: boolean }): Promise<void> {
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
      this.runtime.getResolvableTools(),
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
      const { outputs, skipped, failed, failure } = await executeHooks(
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
      // Fail closed. The hook was supposed to supply the material this job's
      // prompt talks about; without it the model is being asked to summarize
      // data that isn't there, and it will oblige by making some up.
      if (failed) {
        // Deliberately does NOT advance last_run. `{{last_run_epoch}}` is the
        // cursor hooks query from ("mail since I last looked"); moving it past
        // a window that was never processed would silently lose that window's
        // data once the hook is fixed. Scheduling comes from croner, not from
        // last_run, so leaving it alone costs nothing.
        console.error(`[cron] "${job.name}" aborted — beforeRun ${failure}`);
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

    // Anchored, not a substring search: the sentinel has to BE the response.
    // `includes()` also matched a response that merely mentioned NO_ACTION
    // ("this is not a NO_ACTION situation"), silently dropping a real summary.
    const isNoAction = /^\[?NO[_\s]?ACTION\]?[.!]?$/i.test((response ?? "").trim());
    if (response && !isNoAction) {
      await this.deliver(job, response, opts?.solicited === true);
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

  private async deliver(job: CronJobConfig, response: string, solicited = false): Promise<void> {
    const delivery = job.delivery;
    const channelId = delivery?.channel ?? "log";

    // "log" is the reserved console-only sentinel (also the default when
    // delivery is unconfigured) — no real channel delivery.
    if (channelId === "log") {
      console.log(`[cron] [${job.name}] ${response}`);
      return;
    }

    // The live sink is resolved by channel id from the runtime's outbound
    // registry (#66) instead of a notifier hand-injected at construction.
    const mode = delivery?.mode ?? "channel";
    const out = this.runtime.getOutbound(channelId);
    if (!out) {
      console.error(`[cron] Job "${job.name}" wants ${channelId} delivery but it is not connected`);
      return;
    }

    // Scheduled output is unsolicited — nobody asked for it at the moment it
    // fires — so it goes through the repeat gate. A job whose state hasn't
    // changed keeps producing the same summary; the user should hear it once.
    //
    // A run the user triggered is the opposite case: they asked for this
    // answer now, so it always goes out, unchanged or not. It still records a
    // send so the window advances.
    const gate = solicited ? PASSTHROUGH_GATE : resolveGate(() => this.runtime.getNotificationGate?.());

    if (mode === "dm") {
      const userId = delivery?.target ?? this.runtime.getOwnerId(channelId);
      if (!userId) {
        console.error(`[cron] Job "${job.name}" dm delivery has no target user id and no owner for ${channelId}`);
        return;
      }
      const decision = await gate.deliver(
        { source: `cron:${job.name}`, channel: channelId, target: userId, content: response },
        () => out.sendDM(userId, response),
        (msg) => console.log(msg),
      );
      if (decision.send) console.log(`[cron] Delivered "${job.name}" response as DM to user ${userId}`);
      return;
    }

    if (!delivery?.target) {
      console.error(`[cron] Job "${job.name}" channel delivery has no target channel id`);
      return;
    }
    const target = delivery.target;
    const decision = await gate.deliver(
      { source: `cron:${job.name}`, channel: channelId, target, content: response },
      () => out.send(target, response),
      (msg) => console.log(msg),
    );
    if (decision.send) console.log(`[cron] Delivered "${job.name}" response to ${channelId} channel ${target}`);
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
