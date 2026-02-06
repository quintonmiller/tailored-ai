import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { AgentConfig } from './config.js';
import type { AIProvider } from './providers/interface.js';
import type { Tool } from './tools/interface.js';
import { listSessions, getSessionMessages } from './db/queries.js';
import { findOrCreateSession } from './agent/session.js';
import { runAgentLoop } from './agent/loop.js';

export interface ServerOptions {
  config: AgentConfig;
  configPath: string;
  db: Database.Database;
  provider: AIProvider;
  model: string;
  tools: Tool[];
  contextDir: string;
}

const startTime = Date.now();

export function createServer(opts: ServerOptions) {
  const { config, configPath, db, provider, model, tools, contextDir } = opts;

  const app = new Hono();

  // --- API routes ---

  app.get('/api/health', (c) => {
    return c.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      provider: provider.name,
      model,
      tools: tools.length,
    });
  });

  app.get('/api/sessions', (c) => {
    const sessions = listSessions(db);
    return c.json(sessions);
  });

  app.get('/api/sessions/:id/messages', (c) => {
    const { id } = c.req.param();
    const messages = getSessionMessages(db, id);
    return c.json(messages);
  });

  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{ message: string; sessionKey?: string }>();
    const { message, sessionKey } = body;

    if (!message?.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }

    const key = sessionKey ?? `web:${Date.now()}`;
    const session = findOrCreateSession(db, key, model, config.agent.defaultProvider);

    return streamSSE(c, async (stream) => {
      try {
        const response = await runAgentLoop(message, {
          provider,
          session,
          db,
          tools,
          extraInstructions: config.agent.extraInstructions,
          maxToolRounds: config.agent.maxToolRounds,
          temperature: config.agent.temperature,
          contextDir,
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

  // --- Config endpoints ---

  app.get('/api/config', (c) => {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8');
      return c.json({ path: configPath, content: raw });
    }
    return c.json({ path: configPath, content: '' });
  });

  app.put('/api/config', async (c) => {
    const body = await c.req.json<{ content: string }>();
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400);
    }
    try {
      writeFileSync(configPath, body.content, 'utf-8');
      return c.json({ ok: true, message: 'Config saved. Restart the server for changes to take effect.' });
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
    const port = config.server.port;
    const hostname = config.server.host;
    const server = serve({ fetch: app.fetch, port, hostname }, () => {
      console.log(`[server] HTTP listening on http://${hostname}:${port}`);
    });
    return server;
  }

  return { app, start };
}
