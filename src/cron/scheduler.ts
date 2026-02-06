import { Cron } from 'croner';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AIProvider } from '../providers/interface.js';
import type { Tool } from '../tools/interface.js';
import type { AgentConfig, CronJobConfig } from '../config.js';
import type { DiscordChannel } from '../channels/discord.js';
import { findOrCreateSession } from '../agent/session.js';
import { runAgentLoop } from '../agent/loop.js';
import { saveMessage } from '../db/queries.js';

export interface CronSchedulerOptions {
  config: AgentConfig;
  db: Database.Database;
  provider: AIProvider;
  model: string;
  tools: Tool[];
  contextDir: string;
  discord?: DiscordChannel;
}

export class CronScheduler {
  private timers: Cron[] = [];
  private config: AgentConfig;
  private db: Database.Database;
  private provider: AIProvider;
  private model: string;
  private tools: Tool[];
  private contextDir: string;
  private discord?: DiscordChannel;

  constructor(opts: CronSchedulerOptions) {
    this.config = opts.config;
    this.db = opts.db;
    this.provider = opts.provider;
    this.model = opts.model;
    this.tools = opts.tools;
    this.contextDir = opts.contextDir;
    this.discord = opts.discord;
  }

  start(): void {
    const jobs = this.config.cron.jobs;
    if (!jobs.length) return;

    for (const job of jobs) {
      this.upsertJobRow(job);

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

  private async runJob(job: CronJobConfig): Promise<void> {
    const wakeAgent = job.wakeAgent !== false; // default true
    const sessionKey = job.sessionKey ?? `cron:${job.name}`;
    const jobModel = job.model ?? this.model;

    console.log(`[cron] Running "${job.name}" (${wakeAgent ? 'wake' : 'note'} mode)`);

    if (!wakeAgent) {
      this.addNote(job, sessionKey, jobModel);
      this.updateLastRun(job.name);
      return;
    }

    const session = findOrCreateSession(
      this.db,
      sessionKey,
      jobModel,
      this.config.agent.defaultProvider
    );

    const response = await runAgentLoop(job.prompt, {
      provider: this.provider,
      session,
      db: this.db,
      tools: this.tools,
      extraInstructions: this.config.agent.extraInstructions,
      maxToolRounds: this.config.agent.maxToolRounds,
      temperature: this.config.agent.temperature,
      contextDir: this.contextDir,
      onToolCall: (name, args) => {
        console.log(`[cron] [${job.name}] tool: ${name}(${JSON.stringify(args)})`);
      },
    });

    this.updateLastRun(job.name);

    if (response) {
      await this.deliver(job, response);
    }
  }

  private addNote(job: CronJobConfig, sessionKey: string, jobModel: string): void {
    const session = findOrCreateSession(
      this.db,
      sessionKey,
      jobModel,
      this.config.agent.defaultProvider
    );

    saveMessage(this.db, session.id, {
      role: 'user',
      content: job.prompt,
    });

    console.log(`[cron] Added note to session "${sessionKey}": "${job.prompt.slice(0, 80)}"`);
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

    // Default: log
    console.log(`[cron] [${job.name}] ${response}`);
  }

  private upsertJobRow(job: CronJobConfig): void {
    const sessionKey = job.sessionKey ?? `cron:${job.name}`;
    const existing = this.db
      .prepare('SELECT id FROM cron_jobs WHERE name = ?')
      .get(job.name) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        'UPDATE cron_jobs SET schedule = ?, task = ?, model = ?, session_key = ?, enabled = 1 WHERE name = ?'
      ).run(job.schedule, job.prompt, job.model ?? null, sessionKey, job.name);
    } else {
      this.db.prepare(
        'INSERT INTO cron_jobs (id, name, schedule, task, model, session_key, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)'
      ).run(randomUUID(), job.name, job.schedule, job.prompt, job.model ?? null, sessionKey);
    }
  }

  private updateLastRun(name: string): void {
    this.db.prepare(
      "UPDATE cron_jobs SET last_run = datetime('now') WHERE name = ?"
    ).run(name);
  }
}
