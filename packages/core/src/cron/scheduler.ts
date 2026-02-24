import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { applyTemplates, executeHooks } from "../agent/hooks.js";
import { runAgentLoop } from "../agent/loop.js";
import { resolveAgent } from "../agent/agents.js";
import { findOrCreateSession, resetSession } from "../agent/session.js";
import type { DiscordChannel } from "../channels/discord.js";
import type { CronJobConfig } from "../config.js";
import { saveMessage } from "../db/queries.js";
import type { AgentRuntime } from "../runtime.js";

export interface CronSchedulerOptions {
  runtime: AgentRuntime;
  discord?: DiscordChannel;
}

export class CronScheduler {
  private timers: Cron[] = [];
  private runtime: AgentRuntime;
  private discord?: DiscordChannel;

  constructor(opts: CronSchedulerOptions) {
    this.runtime = opts.runtime;
    this.discord = opts.discord;
  }

  setDiscord(discord: DiscordChannel | undefined): void {
    this.discord = discord;
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

      const timer = new Cron(job.schedule, () => {
        this.runJob(job).catch((err) => {
          console.error(`[cron] Error running job "${job.name}":`, err);
        });
      });

      this.timers.push(timer);
      console.log(`[cron] Scheduled "${job.name}" (${job.schedule})`);
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

  private resolvePrompt(job: CronJobConfig, vars?: Record<string, string>): string {
    const templateVars = vars ?? this.buildTemplateVars(job);
    return applyTemplates(job.prompt, templateVars);
  }

  private async runJob(job: CronJobConfig): Promise<void> {
    const wakeAgent = job.wakeAgent !== false; // default true
    const sessionKey = job.sessionKey ?? `cron:${job.name}`;
    const resolved = resolveAgent(
      job.agent ?? job.profile,
      this.runtime.getConfig(),
      this.runtime.getTools(),
      job.model,
      this.runtime.contextDir,
    );

    console.log(`[cron] Running "${job.name}" (${wakeAgent ? "wake" : "note"} mode)`);

    if (!wakeAgent) {
      this.addNote(job, sessionKey, resolved.model);
      this.updateLastRun(job.name);
      return;
    }

    const session = job.newSession
      ? resetSession(this.runtime.db, sessionKey, resolved.model, resolved.provider)
      : findOrCreateSession(this.runtime.db, sessionKey, resolved.model, resolved.provider);

    const templateVars = this.buildTemplateVars(job);
    const hooks = this.runtime.resolveHooks({ agentName: job.agent ?? job.profile, overrideHooks: job.hooks });
    const logPrefix = `[cron] [${job.name}]`;
    const allTools = this.runtime.getTools();

    // --- beforeRun hooks ---
    if (hooks.beforeRun.length > 0) {
      const { outputs, skipped } = await executeHooks(hooks.beforeRun, allTools, templateVars, session.id, logPrefix);
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

    let prompt = this.resolvePrompt(job, templateVars);
    if (templateVars._hook_context) {
      prompt = `${templateVars._hook_context}\n\n---\n\n${prompt}`;
    }

    const response = await runAgentLoop(prompt, {
      ...this.runtime.buildLoopOptions({ session, agentName: job.agent ?? job.profile, modelOverride: job.model }),
      onToolCall: (name, args) => {
        console.log(`[cron] [${job.name}] tool: ${name}(${JSON.stringify(args)})`);
      },
    });

    this.updateLastRun(job.name);

    // --- afterRun hooks ---
    if (hooks.afterRun.length > 0) {
      const afterVars = { ...templateVars, response: response ?? "" };
      await executeHooks(hooks.afterRun, allTools, afterVars, session.id, logPrefix);
    }

    if (response && !response.trim().toUpperCase().includes("NO_ACTION")) {
      await this.deliver(job, response);
    } else {
      console.log(`[cron] "${job.name}" returned NO_ACTION, skipping delivery`);
    }
  }

  private addNote(job: CronJobConfig, sessionKey: string, jobModel: string): void {
    const config = this.runtime.getConfig();
    const session = findOrCreateSession(this.runtime.db, sessionKey, jobModel, config.agent.defaultProvider);

    const prompt = this.resolvePrompt(job);
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
      if (!this.discord) {
        console.error(`[cron] Job "${job.name}" wants discord delivery but Discord is not connected`);
        return;
      }
      await this.discord.send(target, response);
      console.log(`[cron] Delivered "${job.name}" response to Discord channel ${target}`);
      return;
    }

    if (channel === "discord-dm") {
      const target = job.delivery?.target ?? this.runtime.getConfig().channels.discord?.owner;
      if (!target) {
        console.error(
          `[cron] Job "${job.name}" has discord-dm delivery but no target user ID or discord owner configured`,
        );
        return;
      }
      if (!this.discord) {
        console.error(`[cron] Job "${job.name}" wants discord-dm delivery but Discord is not connected`);
        return;
      }
      await this.discord.sendDM(target, response);
      console.log(`[cron] Delivered "${job.name}" response as DM to user ${target}`);
      return;
    }

    // Default: log
    console.log(`[cron] [${job.name}] ${response}`);
  }

  private upsertJobRow(job: CronJobConfig): void {
    const sessionKey = job.sessionKey ?? `cron:${job.name}`;
    const enabled = job.enabled !== false ? 1 : 0;
    const existing = this.runtime.db.prepare("SELECT id FROM cron_jobs WHERE name = ?").get(job.name) as
      | { id: string }
      | undefined;

    if (existing) {
      this.runtime.db
        .prepare("UPDATE cron_jobs SET schedule = ?, task = ?, model = ?, session_key = ?, enabled = ? WHERE name = ?")
        .run(job.schedule, job.prompt, job.model ?? null, sessionKey, enabled, job.name);
    } else {
      this.runtime.db
        .prepare(
          "INSERT INTO cron_jobs (id, name, schedule, task, model, session_key, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), job.name, job.schedule, job.prompt, job.model ?? null, sessionKey, enabled);
    }
  }

  private updateLastRun(name: string): void {
    this.runtime.db.prepare("UPDATE cron_jobs SET last_run = datetime('now') WHERE name = ?").run(name);
  }
}
