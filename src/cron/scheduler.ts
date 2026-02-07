import { Cron } from 'croner';
import { randomUUID } from 'node:crypto';
import type { CronJobConfig } from '../config.js';
import type { DiscordChannel } from '../channels/discord.js';
import type { AgentRuntime } from '../runtime.js';
import { findOrCreateSession } from '../agent/session.js';
import { resolveProfile } from '../agent/profiles.js';
import { runAgentLoop } from '../agent/loop.js';
import { saveMessage } from '../db/queries.js';

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
    console.log('[cron] Stopped all jobs');
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

  private resolvePrompt(job: CronJobConfig): string {
    let prompt = job.prompt;
    if (!prompt.includes('{{')) return prompt;

    const row = this.runtime.db
      .prepare('SELECT last_run FROM cron_jobs WHERE name = ?')
      .get(job.name) as { last_run: string | null } | undefined;

    // SQLite datetime('now') stores as 'YYYY-MM-DD HH:MM:SS' in UTC
    const lastRunStr = row?.last_run;
    const lastRunDate = lastRunStr ? new Date(lastRunStr + 'Z') : null;

    // For first run, default to 1 hour ago
    const effectiveDate = lastRunDate ?? new Date(Date.now() - 3600_000);
    const isoString = effectiveDate.toISOString();
    const epochSeconds = Math.floor(effectiveDate.getTime() / 1000);

    prompt = prompt.replaceAll('{{last_run}}', isoString);
    prompt = prompt.replaceAll('{{last_run_epoch}}', String(epochSeconds));
    return prompt;
  }

  private async runJob(job: CronJobConfig): Promise<void> {
    const wakeAgent = job.wakeAgent !== false; // default true
    const sessionKey = job.sessionKey ?? `cron:${job.name}`;
    const config = this.runtime.getConfig();
    const tools = this.runtime.getTools();
    const resolved = resolveProfile(job.profile, config, tools, job.model, this.runtime.contextDir);

    console.log(`[cron] Running "${job.name}" (${wakeAgent ? 'wake' : 'note'} mode)`);

    if (!wakeAgent) {
      this.addNote(job, sessionKey, resolved.model);
      this.updateLastRun(job.name);
      return;
    }

    const session = findOrCreateSession(
      this.runtime.db,
      sessionKey,
      resolved.model,
      resolved.provider
    );

    const prompt = this.resolvePrompt(job);
    const response = await runAgentLoop(prompt, {
      provider: this.runtime.getProvider(),
      session,
      db: this.runtime.db,
      tools: resolved.tools,
      extraInstructions: resolved.instructions,
      maxToolRounds: resolved.maxToolRounds,
      maxHistoryTokens: config.agent.maxHistoryTokens,
      temperature: resolved.temperature,
      contextDir: this.runtime.contextDir,
      profileContextDir: resolved.contextDir,
      getTools: () => this.runtime.getTools(),
      getProvider: () => this.runtime.getProvider(),
      onToolCall: (name, args) => {
        console.log(`[cron] [${job.name}] tool: ${name}(${JSON.stringify(args)})`);
      },
    });

    this.updateLastRun(job.name);

    if (response && !response.trim().toUpperCase().includes('NO_ACTION')) {
      await this.deliver(job, response);
    } else {
      console.log(`[cron] "${job.name}" returned NO_ACTION, skipping delivery`);
    }
  }

  private addNote(job: CronJobConfig, sessionKey: string, jobModel: string): void {
    const config = this.runtime.getConfig();
    const session = findOrCreateSession(
      this.runtime.db,
      sessionKey,
      jobModel,
      config.agent.defaultProvider
    );

    const prompt = this.resolvePrompt(job);
    saveMessage(this.runtime.db, session.id, {
      role: 'user',
      content: prompt,
    });

    console.log(`[cron] Added note to session "${sessionKey}": "${prompt.slice(0, 80)}"`);
  }

  private async deliver(job: CronJobConfig, response: string): Promise<void> {
    const channel = job.delivery?.channel ?? 'log';

    if (channel === 'discord') {
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

    if (channel === 'discord-dm') {
      const target = job.delivery?.target ?? this.runtime.getConfig().channels.discord?.owner;
      if (!target) {
        console.error(`[cron] Job "${job.name}" has discord-dm delivery but no target user ID or discord owner configured`);
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
    const existing = this.runtime.db
      .prepare('SELECT id FROM cron_jobs WHERE name = ?')
      .get(job.name) as { id: string } | undefined;

    if (existing) {
      this.runtime.db.prepare(
        'UPDATE cron_jobs SET schedule = ?, task = ?, model = ?, session_key = ?, enabled = ? WHERE name = ?'
      ).run(job.schedule, job.prompt, job.model ?? null, sessionKey, enabled, job.name);
    } else {
      this.runtime.db.prepare(
        'INSERT INTO cron_jobs (id, name, schedule, task, model, session_key, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(randomUUID(), job.name, job.schedule, job.prompt, job.model ?? null, sessionKey, enabled);
    }
  }

  private updateLastRun(name: string): void {
    this.runtime.db.prepare(
      "UPDATE cron_jobs SET last_run = datetime('now') WHERE name = ?"
    ).run(name);
  }
}
