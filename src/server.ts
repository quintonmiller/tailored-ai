import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import YAML from 'yaml';
import type { AgentRuntime } from './runtime.js';
import type { CronScheduler } from './cron/scheduler.js';
import { listSessions, getSessionMessages } from './db/queries.js';
import { findOrCreateSession, resetSession } from './agent/session.js';
import { runAgentLoop } from './agent/loop.js';
import { listTasks } from './agent/tasks.js';
import { isCommand, executeCommand } from './commands.js';

export interface ServerOptions {
  runtime: AgentRuntime;
  scheduler?: CronScheduler;
}

export function createServer(opts: ServerOptions) {
  const startTime = Date.now();
  const { runtime } = opts;

  const app = new Hono();

  // --- Auth middleware: protect mutating endpoints when server.apiKey is set ---
  app.use('/api/*', async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next();
    }
    const apiKey = runtime.getConfig().server.apiKey;
    if (!apiKey) return next();

    const auth = c.req.header('Authorization');
    if (auth !== `Bearer ${apiKey}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  // --- API routes ---

  app.get('/api/health', (c) => {
    return c.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      provider: runtime.getProvider().name,
      model: runtime.getModel(),
      tools: runtime.getTools().length,
      generation: runtime.generation,
    });
  });

  app.get('/api/sessions', (c) => {
    const sessions = listSessions(runtime.db);
    return c.json(sessions);
  });

  app.get('/api/sessions/:id/messages', (c) => {
    const { id } = c.req.param();
    const messages = getSessionMessages(runtime.db, id);
    return c.json(messages);
  });

  app.post('/api/sessions/new', async (c) => {
    const body = await c.req.json<{ sessionKey: string }>();
    const { sessionKey } = body;

    if (!sessionKey?.trim()) {
      return c.json({ error: 'sessionKey is required' }, 400);
    }

    const config = runtime.getConfig();
    const model = runtime.getModel();
    const session = resetSession(runtime.db, sessionKey, model, config.agent.defaultProvider);
    return c.json({ sessionId: session.id, sessionKey });
  });

  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{ message: string; sessionKey?: string }>();
    const { message, sessionKey } = body;

    if (!message?.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }

    const config = runtime.getConfig();
    const model = runtime.getModel();
    const key = sessionKey ?? `web:${Date.now()}`;
    const session = findOrCreateSession(runtime.db, key, model, config.agent.defaultProvider);

    return streamSSE(c, async (stream) => {
      try {
        const response = await runAgentLoop(message, {
          ...runtime.buildLoopOptions({ session }),
          onToolCall: (name, args) => {
            stream.writeSSE({
              event: 'tool_call',
              data: JSON.stringify({ name, args }),
            });
          },
          onToolResult: (name, output) => {
            stream.writeSSE({
              event: 'tool_result',
              data: JSON.stringify({ name, output: output.slice(0, 1000) }),
            });
          },
        });

        await stream.writeSSE({
          event: 'response',
          data: JSON.stringify({ content: response, sessionId: session.id, sessionKey: key }),
        });
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: (err as Error).message }),
        });
      }
    });
  });

  // --- Read-only data endpoints ---

  app.get('/api/tools', (c) => {
    const tools = runtime.getTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    return c.json(tools);
  });

  app.get('/api/profiles', (c) => {
    return c.json(runtime.getConfig().profiles);
  });

  app.get('/api/cron', (c) => {
    const config = runtime.getConfig();
    const rows = runtime.db
      .prepare('SELECT id, name, schedule, task, model, session_key, enabled, last_run FROM cron_jobs ORDER BY name')
      .all() as { id: string; name: string; schedule: string; task: string; model: string | null; session_key: string | null; enabled: number; last_run: string | null }[];
    return c.json({
      enabled: config.cron.enabled,
      jobs: rows,
    });
  });

  app.patch('/api/cron/:name', async (c) => {
    const { name } = c.req.param();
    const body = await c.req.json<{ enabled: boolean }>();
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: '"enabled" (boolean) is required' }, 400);
    }

    try {
      return await runtime.withConfigLock(() => {
        const raw = readFileSync(runtime.configPath, 'utf-8');
        const doc = (YAML.parse(raw) as Record<string, unknown>) ?? {};
        const cron = doc.cron as Record<string, unknown> | undefined;
        const jobs = (cron?.jobs as Record<string, unknown>[]) ?? [];
        const job = jobs.find((j) => j.name === name);
        if (!job) {
          return c.json({ error: `Job "${name}" not found in config` }, 404);
        }

        if (body.enabled) {
          delete job.enabled; // default is true, keep config clean
        } else {
          job.enabled = false;
        }

        writeFileSync(runtime.configPath, YAML.stringify(doc), 'utf-8');
        runtime.reload();
        return c.json({ ok: true });
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/cron/:name/run', (c) => {
    if (!opts.scheduler) return c.json({ error: 'Scheduler not available' }, 503);
    const { name } = c.req.param();
    try {
      opts.scheduler.triggerJob(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.get('/api/tasks', (c) => {
    return c.json(listTasks());
  });

  // --- Command endpoints ---

  app.get('/api/commands', (c) => {
    const config = runtime.getConfig();
    const builtins = [
      { name: 'new', description: 'Start a new session', builtin: true },
      { name: 'agent', description: 'Switch to a named profile (usage: /agent <name>)', builtin: true },
      { name: 'help', description: 'List available commands', builtin: true },
    ];
    const custom = Object.entries(config.commands).map(([name, cmd]) => ({
      name,
      description: cmd.description,
      builtin: false,
      hasCommand: !!cmd.command,
      hasPrompt: !!cmd.prompt,
      profile: cmd.profile,
      newSession: cmd.new_session,
    }));
    return c.json([...builtins, ...custom]);
  });

  app.post('/api/command', async (c) => {
    const body = await c.req.json<{ input: string; sessionKey?: string }>();
    const { input, sessionKey } = body;

    if (!input?.trim()) {
      return c.json({ error: 'input is required' }, 400);
    }

    if (!isCommand(input)) {
      return c.json({ error: 'Input must start with /' }, 400);
    }

    const config = runtime.getConfig();
    const result = await executeCommand(input, { config });

    switch (result.type) {
      case 'new_session': {
        const model = runtime.getModel();
        const key = sessionKey ?? `web:${Date.now()}`;
        const session = resetSession(runtime.db, key, model, config.agent.defaultProvider);
        return c.json({ type: 'new_session', sessionId: session.id, sessionKey: key });
      }
      case 'switch_profile':
        return c.json({ type: 'switch_profile', profile: result.profile });
      case 'help':
        return c.json({ type: 'help', text: result.text });
      case 'shell_output':
        return c.json({ type: 'shell_output', output: result.output });
      case 'error':
        return c.json({ type: 'error', message: result.message }, 400);
      case 'unknown_command':
        return c.json({ type: 'error', message: `Unknown command "/${result.name}"` }, 404);
      case 'agent_prompt':
      case 'shell_then_prompt': {
        // Send through agent loop via SSE
        const model = runtime.getModel();
        const key = sessionKey ?? `web:${Date.now()}`;

        if (result.newSession) {
          resetSession(runtime.db, key, model, config.agent.defaultProvider);
        }

        const session = findOrCreateSession(runtime.db, key, model, config.agent.defaultProvider);

        return streamSSE(c, async (stream) => {
          try {
            if (result.type === 'shell_then_prompt') {
              await stream.writeSSE({
                event: 'shell_output',
                data: JSON.stringify({ output: result.output }),
              });
            }

            const response = await runAgentLoop(result.prompt, {
              ...runtime.buildLoopOptions({ session, profileName: result.profile }),
              onToolCall: (name, args) => {
                stream.writeSSE({
                  event: 'tool_call',
                  data: JSON.stringify({ name, args }),
                });
              },
              onToolResult: (name, output) => {
                stream.writeSSE({
                  event: 'tool_result',
                  data: JSON.stringify({ name, output: output.slice(0, 1000) }),
                });
              },
            });

            await stream.writeSSE({
              event: 'response',
              data: JSON.stringify({ content: response, sessionId: session.id, sessionKey: key }),
            });
          } catch (err) {
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ message: (err as Error).message }),
            });
          }
        });
      }
      default:
        return c.json({ type: 'error', message: 'Unexpected result' }, 500);
    }
  });

  app.get('/api/context', async (c) => {
    const dir = runtime.contextDir;
    const globalDir = resolve(dir, 'global');
    const profilesDir = resolve(dir, 'profiles');

    const readMdFiles = async (d: string) => {
      try {
        const entries = await readdir(d);
        return await Promise.all(
          entries
            .filter((f) => f.endsWith('.md'))
            .sort()
            .map(async (name) => {
              const content = await readFile(resolve(d, name), 'utf-8');
              return { name, content };
            }),
        );
      } catch {
        return [];
      }
    };

    const globalFiles = await readMdFiles(globalDir);

    const profiles: Record<string, { name: string; content: string }[]> = {};
    try {
      const profileDirs = await readdir(profilesDir);
      for (const pName of profileDirs) {
        const pDir = resolve(profilesDir, pName);
        const files = await readMdFiles(pDir);
        if (files.length > 0) {
          profiles[pName] = files;
        }
      }
    } catch {
      // profiles dir may not exist
    }

    return c.json({ directory: dir, global: globalFiles, profiles });
  });

  // --- Config endpoints ---

  app.get('/api/config', (c) => {
    if (existsSync(runtime.configPath)) {
      const raw = readFileSync(runtime.configPath, 'utf-8');
      return c.json({ path: runtime.configPath, content: raw });
    }
    return c.json({ path: runtime.configPath, content: '' });
  });

  app.put('/api/config', async (c) => {
    const body = await c.req.json<{ content: string }>();
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400);
    }
    try {
      return await runtime.withConfigLock(() => {
        writeFileSync(runtime.configPath, body.content, 'utf-8');
        runtime.reload();
        return c.json({ ok: true, message: 'Config saved and reloaded.' });
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- Static file serving (production build) ---

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const uiDist = resolve(__dirname, '..', 'ui', 'dist');

  if (existsSync(uiDist)) {
    app.use('/*', serveStatic({ root: './ui/dist' }));
  }

  function start() {
    const config = runtime.getConfig();
    const port = config.server.port;
    const hostname = config.server.host;
    const server = serve({ fetch: app.fetch, port, hostname }, () => {
      console.log(`[server] HTTP listening on http://${hostname}:${port}`);
    });
    return server;
  }

  return { app, start };
}
