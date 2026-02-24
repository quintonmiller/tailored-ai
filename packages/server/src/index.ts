import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import YAML from "yaml";
import {
  compactSession,
  formatCompactResult,
  executeHooks,
  runAgentLoop,
  findOrCreateSession,
  resetSession,
  listTasks,
  executeCommand,
  isCommand,
  getSessionMessages,
  listSessions,
  createProjectTask,
  getProjectTask,
  updateProjectTask,
  deleteProjectTask,
  addTaskComment,
  queryProjectTasks,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  queryProjects,
  getDefaultProjectId,
  createDocument,
  getDocument,
  updateDocument,
  deleteDocument,
  listDocuments,
  type CronScheduler,
  type AgentRuntime,
  type TaskWatcher,
  type TaskQueryFilter,
  type ProjectQueryFilter,
} from "@agent/core";
import {
  HttpApprovalHandler,
  registerHandler,
  unregisterHandler,
  getAllPendingApprovals,
  resolveApprovalById,
} from "./approval.js";

export interface ServerOptions {
  runtime: AgentRuntime;
  scheduler?: CronScheduler;
  taskWatcher?: TaskWatcher;
  uiDistPath?: string;
}

interface SessionActivity {
  sessionId: string;
  agentName?: string;
  status: "idle" | "active";
  description?: string;
  startedAt: Date;
  lastActivity: Date;
}

const activityRegistry = new Map<string, SessionActivity>();

export function createServer(opts: ServerOptions) {
  const startTime = Date.now();
  const { runtime } = opts;

  const app = new Hono();

  // --- Auth middleware: protect mutating endpoints when server.apiKey is set ---
  app.use("/api/*", async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }
    const apiKey = runtime.getConfig().server.apiKey;
    if (!apiKey) return next();

    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${apiKey}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  // --- API routes ---

  app.get("/api/health", (c) => {
    return c.json({
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      provider: runtime.getProvider().name,
      model: runtime.getModel(),
      tools: runtime.getTools().length,
      generation: runtime.generation,
    });
  });

  app.get("/api/sessions", (c) => {
    const sessions = listSessions(runtime.db);
    return c.json(sessions);
  });

  app.get("/api/sessions/:id/messages", (c) => {
    const { id } = c.req.param();
    const messages = getSessionMessages(runtime.db, id);
    return c.json(messages);
  });

  app.post("/api/sessions/new", async (c) => {
    const body = await c.req.json<{ sessionKey: string }>();
    const { sessionKey } = body;

    if (!sessionKey?.trim()) {
      return c.json({ error: "sessionKey is required" }, 400);
    }

    const config = runtime.getConfig();
    const model = runtime.getModel();
    const session = resetSession(runtime.db, sessionKey, model, config.agent.defaultProvider);
    return c.json({ sessionId: session.id, sessionKey });
  });

  app.post("/api/chat", async (c) => {
    const body = await c.req.json<{ message: string; sessionKey?: string; agent?: string; profile?: string }>();
    const { message, sessionKey, agent, profile } = body;
    const agentName = agent ?? profile;

    if (!message?.trim()) {
      return c.json({ error: "message is required" }, 400);
    }

    const config = runtime.getConfig();
    const model = runtime.getModel();
    const key = sessionKey ?? `web:${Date.now()}`;
    const session = findOrCreateSession(runtime.db, key, model, config.agent.defaultProvider);
    const hooks = runtime.resolveHooks({ agentName });

    // Create per-stream approval handler
    const approvalHandler = new HttpApprovalHandler();
    const handlerKey = `chat:${key}:${Date.now()}`;

    return streamSSE(c, async (stream) => {
      approvalHandler.setEmitter((event, data) => {
        stream.writeSSE({ event, data: JSON.stringify(data) });
      });
      registerHandler(handlerKey, approvalHandler);

      try {
        // Register session as active
        activityRegistry.set(session.id, {
          sessionId: session.id,
          agentName: agentName ?? undefined,
          status: "active",
          startedAt: new Date(),
          lastActivity: new Date(),
        });

        // --- beforeRun hooks ---
        if (hooks.beforeRun.length > 0) {
          const { skipped } = await executeHooks(hooks.beforeRun, runtime.getTools(), {}, session.id, "[api/chat]");
          if (skipped) {
            await stream.writeSSE({
              event: "response",
              data: JSON.stringify({ content: null, sessionId: session.id, sessionKey: key, skipped: true }),
            });
            return;
          }
        }

        const response = await runAgentLoop(message, {
          ...runtime.buildLoopOptions({ session, agentName }),
          approvalHandler,
          onToolCall: (name, args) => {
            stream.writeSSE({
              event: "tool_call",
              data: JSON.stringify({ name, args }),
            });
          },
          onToolResult: (name, output) => {
            stream.writeSSE({
              event: "tool_result",
              data: JSON.stringify({ name, output: output.slice(0, 1000) }),
            });
          },
          onActivity: (desc) => {
            const prev = activityRegistry.get(session.id);
            activityRegistry.set(session.id, {
              ...(prev ?? { sessionId: session.id, agentName: agentName ?? undefined, startedAt: new Date() }),
              status: desc ? "active" : "idle",
              description: desc ?? undefined,
              lastActivity: new Date(),
            });
            stream.writeSSE({
              event: "activity",
              data: JSON.stringify({ status: desc ? "active" : "idle", description: desc }),
            });
          },
        });

        // --- afterRun hooks ---
        if (hooks.afterRun.length > 0) {
          await executeHooks(
            hooks.afterRun,
            runtime.getTools(),
            { response: response ?? "" },
            session.id,
            "[api/chat]",
          );
        }

        await stream.writeSSE({
          event: "response",
          data: JSON.stringify({ content: response, sessionId: session.id, sessionKey: key }),
        });
      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: (err as Error).message }),
        });
      } finally {
        unregisterHandler(handlerKey);
        approvalHandler.rejectAll("stream closed");
      }
    });
  });

  // --- Read-only data endpoints ---

  app.get("/api/tools", (c) => {
    const tools = runtime.getTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    return c.json(tools);
  });

  app.get("/api/agents", (c) => {
    return c.json(runtime.getConfig().agents);
  });

  app.get("/api/cron", (c) => {
    const config = runtime.getConfig();
    const dbRows = runtime.db
      .prepare("SELECT id, name, schedule, task, model, session_key, enabled, last_run FROM cron_jobs ORDER BY name")
      .all() as {
      id: string;
      name: string;
      schedule: string;
      task: string;
      model: string | null;
      session_key: string | null;
      enabled: number;
      last_run: string | null;
    }[];

    const dbByName = new Map(dbRows.map((r) => [r.name, r]));

    // Merge config jobs with DB rows — config is the source of truth for definitions,
    // DB provides runtime state (last_run, enabled overrides)
    const jobs = config.cron.jobs.map((job) => {
      const dbRow = dbByName.get(job.name);
      return {
        name: job.name,
        schedule: job.schedule,
        task: job.prompt,
        model: job.model ?? null,
        agent: job.agent ?? job.profile ?? null,
        enabled: dbRow ? dbRow.enabled : job.enabled !== false ? 1 : 0,
        last_run: dbRow?.last_run ?? null,
        delivery: job.delivery ?? null,
        in_db: !!dbRow,
      };
    });

    // Also include any DB-only jobs (orphaned rows not in config)
    for (const row of dbRows) {
      if (!config.cron.jobs.some((j) => j.name === row.name)) {
        jobs.push({
          name: row.name,
          schedule: row.schedule,
          task: row.task,
          model: row.model,
          agent: null,
          enabled: row.enabled,
          last_run: row.last_run,
          delivery: null,
          in_db: true,
        });
      }
    }

    return c.json({
      enabled: config.cron.enabled,
      jobs,
    });
  });

  app.patch("/api/cron/:name", async (c) => {
    const { name } = c.req.param();
    const body = await c.req.json<{ enabled: boolean }>();
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: '"enabled" (boolean) is required' }, 400);
    }

    try {
      return await runtime.withConfigLock(() => {
        const raw = readFileSync(runtime.configPath, "utf-8");
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

        writeFileSync(runtime.configPath, YAML.stringify(doc), "utf-8");
        runtime.reload();
        return c.json({ ok: true });
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/cron/:name/run", (c) => {
    if (!opts.scheduler) return c.json({ error: "Scheduler not available" }, 503);
    const { name } = c.req.param();
    try {
      opts.scheduler.triggerJob(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  // --- Approval endpoints ---

  app.get("/api/approvals", (c) => {
    return c.json(getAllPendingApprovals());
  });

  app.post("/api/approvals/:id", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json<{ approved: boolean; reason?: string }>();

    if (typeof body.approved !== "boolean") {
      return c.json({ error: '"approved" (boolean) is required' }, 400);
    }

    const resolved = resolveApprovalById(id, body.approved, body.reason);
    if (!resolved) {
      return c.json({ error: `No pending approval with id "${id}"` }, 404);
    }

    return c.json({ ok: true });
  });

  app.get("/api/background-tasks", (c) => {
    return c.json(listTasks());
  });

  app.get("/api/activity", (c) => {
    const config = runtime.getConfig();

    // Find the most recent activity entry per agent (null = default/no agent)
    const activeByAgent = new Map<string | null, SessionActivity>();
    for (const act of activityRegistry.values()) {
      const key = act.agentName ?? null;
      const existing = activeByAgent.get(key);
      if (!existing || act.lastActivity.getTime() > existing.lastActivity.getTime()) {
        activeByAgent.set(key, act);
      }
    }

    // One entry per agent: default first, then named agents
    const rows: { agentName: string | null; status: string; description?: string; lastActivity: string | null }[] = [];

    const defAct = activeByAgent.get(null);
    rows.push({
      agentName: null,
      status: defAct?.status ?? "idle",
      description: defAct?.description,
      lastActivity: defAct?.lastActivity.toISOString() ?? null,
    });

    for (const name of Object.keys(config.agents)) {
      const act = activeByAgent.get(name);
      rows.push({
        agentName: name,
        status: act?.status ?? "idle",
        description: act?.description,
        lastActivity: act?.lastActivity.toISOString() ?? null,
      });
    }

    return c.json(rows);
  });

  // --- Project Tasks ---

  app.get("/api/project-tasks", (c) => {
    const filter: TaskQueryFilter = {};
    const status = c.req.query("status");
    if (status) {
      const arr = status.split(",").map((s) => s.trim()).filter(Boolean);
      filter.status = arr.length === 1 ? arr[0] : arr;
    }
    const author = c.req.query("author");
    if (author) filter.author = author;
    const tags = c.req.query("tags");
    if (tags) filter.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
    const updatedAfter = c.req.query("updated_after");
    if (updatedAfter) filter.updatedAfter = updatedAfter;
    const search = c.req.query("search");
    if (search) filter.search = search;
    const projectId = c.req.query("project_id");
    if (projectId) filter.project_id = projectId;
    const limit = c.req.query("limit");
    if (limit) filter.limit = Number.parseInt(limit, 10);
    const offset = c.req.query("offset");
    if (offset) filter.offset = Number.parseInt(offset, 10);

    return c.json(queryProjectTasks(runtime.db, filter));
  });

  app.get("/api/project-tasks/:id", (c) => {
    const { id } = c.req.param();
    const task = getProjectTask(runtime.db, id);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(task);
  });

  app.post("/api/project-tasks", async (c) => {
    const body = await c.req.json<{
      title: string;
      description?: string;
      author?: string;
      tags?: string[];
      status?: string;
      project_id?: string;
    }>();

    if (!body.title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    try {
      const projectId = body.project_id ?? getDefaultProjectId(runtime.db);
      const task = createProjectTask(runtime.db, { ...body, project_id: projectId });
      opts.taskWatcher?.notify({ action: "created", task });
      return c.json(task, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch("/api/project-tasks/:id", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json<{
      title?: string;
      description?: string;
      status?: string;
      author?: string;
      tags?: string[];
    }>();

    try {
      const task = updateProjectTask(runtime.db, id, body);
      if (!task) return c.json({ error: "Task not found" }, 404);
      opts.taskWatcher?.notify({ action: "updated", task });
      return c.json(task);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.delete("/api/project-tasks/:id", (c) => {
    const { id } = c.req.param();
    const deleted = deleteProjectTask(runtime.db, id);
    if (!deleted) return c.json({ error: "Task not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/project-tasks/:id/comments", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json<{ content: string; author?: string }>();

    if (!body.content?.trim()) {
      return c.json({ error: "content is required" }, 400);
    }

    const comment = addTaskComment(runtime.db, id, body);
    if (!comment) return c.json({ error: "Task not found" }, 404);

    if (opts.taskWatcher) {
      const task = getProjectTask(runtime.db, id);
      if (task) opts.taskWatcher.notify({ action: "commented", task });
    }

    return c.json(comment, 201);
  });

  // --- Projects ---

  app.get("/api/projects", (c) => {
    const filter: ProjectQueryFilter = {};
    const status = c.req.query("status");
    if (status) {
      const arr = status.split(",").map((s) => s.trim()).filter(Boolean);
      filter.status = arr.length === 1 ? arr[0] : arr;
    }
    const search = c.req.query("search");
    if (search) filter.search = search;
    const limit = c.req.query("limit");
    if (limit) filter.limit = Number.parseInt(limit, 10);
    const offset = c.req.query("offset");
    if (offset) filter.offset = Number.parseInt(offset, 10);

    return c.json(queryProjects(runtime.db, filter));
  });

  app.get("/api/projects/default", (c) => {
    try {
      const id = getDefaultProjectId(runtime.db);
      return c.json({ id });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.get("/api/projects/:id", (c) => {
    const { id } = c.req.param();
    const project = getProject(runtime.db, id);
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json(project);
  });

  app.post("/api/projects", async (c) => {
    const body = await c.req.json<{
      title: string;
      description?: string;
      due_date?: string;
    }>();

    if (!body.title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    try {
      const project = createProject(runtime.db, body);
      return c.json(project, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch("/api/projects/:id", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json<{
      title?: string;
      description?: string;
      status?: string;
      due_date?: string | null;
    }>();

    try {
      const project = updateProject(runtime.db, id, body);
      if (!project) return c.json({ error: "Project not found" }, 404);
      return c.json(project);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.delete("/api/projects/:id", (c) => {
    const { id } = c.req.param();
    const deleted = deleteProject(runtime.db, id);
    if (!deleted) return c.json({ error: "Project not found" }, 404);
    return c.json({ ok: true });
  });

  // --- Documents ---

  app.get("/api/projects/:pid/documents", (c) => {
    const { pid } = c.req.param();
    const search = c.req.query("search");
    const docs = listDocuments(runtime.db, pid, search || undefined);
    return c.json(docs);
  });

  app.post("/api/projects/:pid/documents", async (c) => {
    const { pid } = c.req.param();
    const body = await c.req.json<{
      title: string;
      content?: string;
    }>();

    if (!body.title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    // Verify project exists
    const project = getProject(runtime.db, pid);
    if (!project) return c.json({ error: "Project not found" }, 404);

    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { resolve } = await import("node:path");

      const projectsDir = resolve(runtime.getConfig().tools.projects?.directory ?? "./data/projects");
      const filename = `${body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)}.md`;
      const dir = join(projectsDir, pid);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, filename), body.content ?? "", "utf-8");

      const doc = createDocument(runtime.db, { project_id: pid, title: body.title, filename });
      return c.json(doc, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get("/api/projects/:pid/documents/:did", async (c) => {
    const { did } = c.req.param();
    const doc = getDocument(runtime.db, did);
    if (!doc) return c.json({ error: "Document not found" }, 404);

    try {
      const { existsSync, readFileSync } = await import("node:fs");
      const { join, resolve } = await import("node:path");

      const projectsDir = resolve(runtime.getConfig().tools.projects?.directory ?? "./data/projects");
      const fp = join(projectsDir, doc.project_id, doc.filename);
      const content = existsSync(fp) ? readFileSync(fp, "utf-8") : "";

      return c.json({ ...doc, content });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.patch("/api/projects/:pid/documents/:did", async (c) => {
    const { did } = c.req.param();
    const body = await c.req.json<{
      title?: string;
      content?: string;
    }>();

    const doc = getDocument(runtime.db, did);
    if (!doc) return c.json({ error: "Document not found" }, 404);

    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join, resolve } = await import("node:path");

      if (body.content !== undefined) {
        const projectsDir = resolve(runtime.getConfig().tools.projects?.directory ?? "./data/projects");
        const dir = join(projectsDir, doc.project_id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, doc.filename), body.content, "utf-8");
      }

      const updated = updateDocument(runtime.db, did, { title: body.title });
      if (!updated) return c.json({ error: "Document not found" }, 404);
      return c.json(updated);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.delete("/api/projects/:pid/documents/:did", async (c) => {
    const { did } = c.req.param();
    const doc = getDocument(runtime.db, did);
    if (!doc) return c.json({ error: "Document not found" }, 404);

    try {
      const { existsSync, rmSync } = await import("node:fs");
      const { join, resolve } = await import("node:path");

      const projectsDir = resolve(runtime.getConfig().tools.projects?.directory ?? "./data/projects");
      const fp = join(projectsDir, doc.project_id, doc.filename);
      if (existsSync(fp)) rmSync(fp);

      deleteDocument(runtime.db, did);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- Command endpoints ---

  app.get("/api/commands", (c) => {
    const config = runtime.getConfig();
    const builtins = [
      { name: "new", description: "Start a new session", builtin: true },
      { name: "compact", description: "Summarize conversation to free context space", builtin: true },
      { name: "agent", description: "Switch to a named profile (usage: /agent <name>)", builtin: true },
      { name: "help", description: "List available commands", builtin: true },
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

  app.post("/api/command", async (c) => {
    const body = await c.req.json<{ input: string; sessionKey?: string }>();
    const { input, sessionKey } = body;

    if (!input?.trim()) {
      return c.json({ error: "input is required" }, 400);
    }

    if (!isCommand(input)) {
      return c.json({ error: "Input must start with /" }, 400);
    }

    const config = runtime.getConfig();
    const result = await executeCommand(input, { config });

    switch (result.type) {
      case "new_session": {
        const model = runtime.getModel();
        const key = sessionKey ?? `web:${Date.now()}`;
        const session = resetSession(runtime.db, key, model, config.agent.defaultProvider);
        return c.json({ type: "new_session", sessionId: session.id, sessionKey: key });
      }
      case "compact": {
        const model = runtime.getModel();
        const key = sessionKey ?? `web:${Date.now()}`;
        const session = findOrCreateSession(runtime.db, key, model, config.agent.defaultProvider);
        try {
          const compactResult = await compactSession(runtime.db, session.id, runtime.getProvider(), model);
          return c.json({ type: "compact", ...compactResult, message: formatCompactResult(compactResult) });
        } catch (err) {
          return c.json({ type: "error", message: (err as Error).message }, 500);
        }
      }
      case "switch_profile":
        return c.json({ type: "switch_profile", profile: result.profile });
      case "help":
        return c.json({ type: "help", text: result.text });
      case "shell_output":
        return c.json({ type: "shell_output", output: result.output });
      case "error":
        return c.json({ type: "error", message: result.message }, 400);
      case "unknown_command":
        return c.json({ type: "error", message: `Unknown command "/${result.name}"` }, 404);
      case "agent_prompt":
      case "shell_then_prompt": {
        // Send through agent loop via SSE
        const model = runtime.getModel();
        const key = sessionKey ?? `web:${Date.now()}`;

        if (result.newSession) {
          resetSession(runtime.db, key, model, config.agent.defaultProvider);
        }

        const session = findOrCreateSession(runtime.db, key, model, config.agent.defaultProvider);
        const cmdHooks = runtime.resolveHooks({ agentName: result.profile });

        // Create per-stream approval handler
        const cmdApprovalHandler = new HttpApprovalHandler();
        const cmdHandlerKey = `cmd:${key}:${Date.now()}`;

        return streamSSE(c, async (stream) => {
          cmdApprovalHandler.setEmitter((event, data) => {
            stream.writeSSE({ event, data: JSON.stringify(data) });
          });
          registerHandler(cmdHandlerKey, cmdApprovalHandler);

          try {
            if (result.type === "shell_then_prompt") {
              await stream.writeSSE({
                event: "shell_output",
                data: JSON.stringify({ output: result.output }),
              });
            }

            // --- beforeRun hooks ---
            if (cmdHooks.beforeRun.length > 0) {
              const { skipped } = await executeHooks(
                cmdHooks.beforeRun,
                runtime.getTools(),
                {},
                session.id,
                "[api/command]",
              );
              if (skipped) {
                await stream.writeSSE({
                  event: "response",
                  data: JSON.stringify({ content: null, sessionId: session.id, sessionKey: key, skipped: true }),
                });
                return;
              }
            }

            const response = await runAgentLoop(result.prompt, {
              ...runtime.buildLoopOptions({ session, agentName: result.profile }),
              approvalHandler: cmdApprovalHandler,
              onToolCall: (name, args) => {
                stream.writeSSE({
                  event: "tool_call",
                  data: JSON.stringify({ name, args }),
                });
              },
              onToolResult: (name, output) => {
                stream.writeSSE({
                  event: "tool_result",
                  data: JSON.stringify({ name, output: output.slice(0, 1000) }),
                });
              },
            });

            // --- afterRun hooks ---
            if (cmdHooks.afterRun.length > 0) {
              await executeHooks(
                cmdHooks.afterRun,
                runtime.getTools(),
                { response: response ?? "" },
                session.id,
                "[api/command]",
              );
            }

            await stream.writeSSE({
              event: "response",
              data: JSON.stringify({ content: response, sessionId: session.id, sessionKey: key }),
            });
          } catch (err) {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ message: (err as Error).message }),
            });
          } finally {
            unregisterHandler(cmdHandlerKey);
            cmdApprovalHandler.rejectAll("stream closed");
          }
        });
      }
      default:
        return c.json({ type: "error", message: "Unexpected result" }, 500);
    }
  });

  app.get("/api/context", async (c) => {
    const dir = runtime.contextDir;
    const globalDir = resolve(dir, "global");
    const agentsDir = resolve(dir, "agents");

    const listMdFiles = async (d: string): Promise<string[]> => {
      try {
        const entries = await readdir(d);
        return entries.filter((f) => f.endsWith(".md")).sort();
      } catch {
        return [];
      }
    };

    const globalFiles = await listMdFiles(globalDir);

    const agents: Record<string, string[]> = {};
    try {
      const agentDirs = await readdir(agentsDir);
      for (const aName of agentDirs) {
        const aDir = resolve(agentsDir, aName);
        const files = await listMdFiles(aDir);
        if (files.length > 0) {
          agents[aName] = files;
        }
      }
    } catch {
      // agents dir may not exist
    }

    return c.json({ directory: dir, global: globalFiles, agents });
  });

  app.get("/api/context/file", async (c) => {
    const name = c.req.query("name");
    const scope = c.req.query("scope") ?? "global";

    if (!name) {
      return c.json({ error: "name query parameter is required" }, 400);
    }

    // Prevent path traversal
    if (name.includes("..") || name.includes("/") || name.includes("\\")) {
      return c.json({ error: "Invalid file name" }, 400);
    }

    const dir = runtime.contextDir;
    const filePath = scope === "global" ? resolve(dir, "global", name) : resolve(dir, "agents", scope, name);

    try {
      const content = await readFile(filePath, "utf-8");
      return c.json({ name, scope, content });
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
  });

  // --- Config section endpoints (generic read/write for YAML sections) ---

  const SECTION_MAP: Record<string, string[]> = {
    discord: ["channels", "discord"],
    agents: ["agents"],
    profiles: ["agents"], // deprecated alias, maps to agents
    custom_tools: ["custom_tools"],
    cron: ["cron"],
    task_watcher: ["taskWatcher"],
    webhooks: ["webhooks"],
    commands: ["commands"],
    tools: ["tools"],
    permissions: ["permissions"],
  };

  app.get("/api/config/section/:key", (c) => {
    const key = c.req.param("key");
    const path = SECTION_MAP[key];
    if (!path) {
      return c.json({ error: `Unknown section "${key}"` }, 404);
    }
    const raw = existsSync(runtime.configPath) ? readFileSync(runtime.configPath, "utf-8") : "";
    const doc = (YAML.parse(raw) as Record<string, unknown>) ?? {};
    let value: unknown = doc;
    for (const segment of path) {
      value = (value as Record<string, unknown>)?.[segment];
    }
    return c.json({ key, data: value ?? null });
  });

  app.put("/api/config/section/:key", async (c) => {
    const key = c.req.param("key");
    const path = SECTION_MAP[key];
    if (!path) {
      return c.json({ error: `Unknown section "${key}"` }, 404);
    }
    const body = await c.req.json<{ data: unknown }>();
    if (body.data === undefined) {
      return c.json({ error: "data is required" }, 400);
    }
    try {
      return await runtime.withConfigLock(() => {
        const raw = existsSync(runtime.configPath) ? readFileSync(runtime.configPath, "utf-8") : "";
        const doc = (YAML.parse(raw) as Record<string, unknown>) ?? {};

        // Navigate to parent and set the leaf key
        let parent: Record<string, unknown> = doc;
        for (let i = 0; i < path.length - 1; i++) {
          if (!parent[path[i]] || typeof parent[path[i]] !== "object") {
            parent[path[i]] = {};
          }
          parent = parent[path[i]] as Record<string, unknown>;
        }
        const leafKey = path[path.length - 1];
        if (body.data === null) {
          delete parent[leafKey];
        } else {
          parent[leafKey] = body.data;
        }

        writeFileSync(runtime.configPath, YAML.stringify(doc), "utf-8");
        runtime.reload();
        return c.json({ ok: true });
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- Config endpoints ---

  app.get("/api/config", (c) => {
    if (existsSync(runtime.configPath)) {
      const raw = readFileSync(runtime.configPath, "utf-8");
      return c.json({ path: runtime.configPath, content: raw });
    }
    return c.json({ path: runtime.configPath, content: "" });
  });

  app.put("/api/config", async (c) => {
    const body = await c.req.json<{ content: string }>();
    if (typeof body.content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }
    try {
      return await runtime.withConfigLock(() => {
        writeFileSync(runtime.configPath, body.content, "utf-8");
        runtime.reload();
        return c.json({ ok: true, message: "Config saved and reloaded." });
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- Provider config endpoints ---

  app.get("/api/config/providers", (c) => {
    const config = runtime.getConfig();

    // Dynamically iterate over all configured providers, strip defaultModel, mask apiKey
    const providers: Record<string, Record<string, string>> = {};
    for (const [name, provCfg] of Object.entries(config.providers)) {
      if (!provCfg) continue;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(provCfg)) {
        if (k === "defaultModel") continue; // strip legacy field
        if (k === "apiKey") {
          clean[k] = v ? "••••" : "";
        } else if (typeof v === "string") {
          clean[k] = v;
        }
      }
      providers[name] = clean;
    }

    // Default models: read from agent.models or synthesize from legacy fields
    let defaultModels: { provider: string; model: string }[] = [];
    if (config.agent.models && config.agent.models.length > 0) {
      defaultModels = config.agent.models;
    } else {
      const dp = config.agent.defaultProvider;
      const provCfg = config.providers[dp as keyof typeof config.providers];
      if (provCfg && "defaultModel" in provCfg && provCfg.defaultModel) {
        defaultModels = [{ provider: dp, model: provCfg.defaultModel }];
      }
    }

    // Agent models: read from agent.models or synthesize from legacy fields
    const agentModels: Record<string, { provider: string; model: string }[]> = {};
    for (const [name, agentDef] of Object.entries(config.agents)) {
      if (agentDef.models && agentDef.models.length > 0) {
        agentModels[name] = agentDef.models;
      } else if (agentDef.provider && agentDef.model) {
        agentModels[name] = [{ provider: agentDef.provider, model: agentDef.model }];
      } else if (agentDef.model) {
        // Model set but no explicit provider — use default
        agentModels[name] = [{ provider: config.agent.defaultProvider, model: agentDef.model }];
      }
      // Omit agents with no model override
    }

    return c.json({ providers, defaultModels, agentModels });
  });

  app.put("/api/config/providers", async (c) => {
    const body = await c.req.json<{
      providers: Record<string, Record<string, string> | null>;
      defaultModels: { provider: string; model: string }[];
      agentModels?: Record<string, { provider: string; model: string }[]>;
      profileModels?: Record<string, { provider: string; model: string }[]>; // deprecated alias
    }>();

    if (!body.providers || !body.defaultModels) {
      return c.json({ error: "providers and defaultModels are required" }, 400);
    }

    try {
      return await runtime.withConfigLock(() => {
        const raw = existsSync(runtime.configPath) ? readFileSync(runtime.configPath, "utf-8") : "";
        const doc = (YAML.parse(raw) as Record<string, unknown>) ?? {};

        // --- Update providers section (connection details only) ---
        const existingProviders = (doc.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
        const providers: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(body.providers)) {
          if (value) {
            const clean: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) {
              if (v === "••••") {
                // Preserve existing API key from raw YAML
                const existing = existingProviders[name];
                if (existing?.[k]) clean[k] = existing[k];
              } else if (v !== "" && v !== undefined) {
                clean[k] = v;
              }
            }
            // Preserve defaultModel from existing config for backward compat
            // (will be set from models list below)
            if (Object.keys(clean).length > 0) providers[name] = clean;
          }
        }

        // --- Derive legacy defaultModel into each provider from models lists ---
        const incomingAgentModels = body.agentModels ?? body.profileModels ?? {};
        const allModels = [...(body.defaultModels ?? []), ...Object.values(incomingAgentModels).flat()];
        for (const entry of allModels) {
          const prov = providers[entry.provider] as Record<string, unknown> | undefined;
          if (prov && !prov.defaultModel) {
            prov.defaultModel = entry.model;
          }
        }

        doc.providers = providers;

        // --- Update agent section ---
        if (!doc.agent || typeof doc.agent !== "object") doc.agent = {};
        const agent = doc.agent as Record<string, unknown>;

        // Write agent.models
        agent.models = body.defaultModels;

        // Derive legacy agent.defaultProvider from first entry
        if (body.defaultModels.length > 0) {
          agent.defaultProvider = body.defaultModels[0].provider;
        }

        // --- Update agent models ---
        if (Object.keys(incomingAgentModels).length > 0) {
          const agents = (doc.agents as Record<string, Record<string, unknown>> | undefined) ?? {};
          for (const [agentName, models] of Object.entries(incomingAgentModels)) {
            if (!agents[agentName]) continue; // Don't create agents that don't exist
            if (models.length > 0) {
              agents[agentName].models = models;
              // Derive legacy model/provider from first entry
              agents[agentName].model = models[0].model;
              agents[agentName].provider = models[0].provider;
            } else {
              // Empty array = remove override
              delete agents[agentName].models;
              delete agents[agentName].model;
              delete agents[agentName].provider;
            }
          }
          doc.agents = agents;
        }

        writeFileSync(runtime.configPath, YAML.stringify(doc), "utf-8");
        runtime.reload();
        return c.json({ ok: true, message: "Provider config saved and reloaded." });
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- List models for a provider ---

  app.get("/api/config/providers/:name/models", async (c) => {
    const providerName = c.req.param("name");
    const config = runtime.getConfig();
    const provCfg = config.providers[providerName as keyof typeof config.providers];

    if (!provCfg) {
      return c.json({ error: `Provider "${providerName}" not configured` }, 404);
    }

    try {
      let models: string[] = [];

      if (providerName === "ollama") {
        const baseUrl = (provCfg as { baseUrl: string }).baseUrl.replace(/\/$/, "");
        const resp = await fetch(`${baseUrl}/api/tags`);
        if (!resp.ok) throw new Error(`Ollama returned ${resp.status}`);
        const data = (await resp.json()) as { models?: { name: string }[] };
        models = (data.models ?? []).map((m) => m.name);
      } else if (providerName === "openai") {
        const cfg = provCfg as { apiKey: string; baseUrl?: string };
        const baseUrl = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const resp = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
        });
        if (!resp.ok) throw new Error(`OpenAI returned ${resp.status}`);
        const data = (await resp.json()) as { data?: { id: string }[] };
        models = (data.data ?? []).map((m) => m.id).sort();
      } else if (providerName === "anthropic") {
        // Anthropic has no list-models endpoint; return well-known models
        models = [
          "claude-opus-4-20250514",
          "claude-sonnet-4-20250514",
          "claude-sonnet-4-5-20250929",
          "claude-haiku-4-5-20251001",
        ];
      }

      return c.json({ provider: providerName, models });
    } catch (err) {
      return c.json({ provider: providerName, models: [], error: (err as Error).message });
    }
  });

  // --- Webhook receiver ---

  app.post("/api/webhooks/:route", async (c) => {
    const routePath = c.req.param("route");
    const config = runtime.getConfig();

    if (!config.webhooks.enabled) {
      return c.json({ error: "Webhooks are disabled" }, 503);
    }

    // Authenticate via webhook secret (separate from API key)
    if (config.webhooks.secret) {
      const auth = c.req.header("Authorization");
      if (auth !== `Bearer ${config.webhooks.secret}`) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    const route = config.webhooks.routes.find((r) => r.path === `/${routePath}` || r.path === routePath);
    if (!route) {
      return c.json({ error: `No webhook route configured for "/${routePath}"` }, 404);
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = await c.req.json();
    } catch {
      // Body may be empty or non-JSON — that's OK
    }

    // Interpolate payload fields into the message template
    const message = route.messageTemplate.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path: string) => {
      const parts = path.split(".");
      let value: unknown = payload;
      for (const part of parts) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[part];
        } else {
          return "";
        }
      }
      return value != null ? String(value) : "";
    });

    if (route.action === "log") {
      console.log(`[webhook] ${routePath}: ${message}`);
      return c.json({ ok: true, action: "log", message });
    }

    // action === 'agent' — send through agent loop
    const model = runtime.getModel();
    const sessionKey = route.sessionKey ?? `webhook:${routePath}`;

    if (route.newSession) {
      resetSession(runtime.db, sessionKey, model, config.agent.defaultProvider);
    }

    const session = findOrCreateSession(runtime.db, sessionKey, model, config.agent.defaultProvider);
    const whHooks = runtime.resolveHooks({ agentName: route.agent ?? route.profile });
    const whLogPrefix = `[webhook] [${routePath}]`;

    try {
      // --- beforeRun hooks ---
      if (whHooks.beforeRun.length > 0) {
        const { skipped } = await executeHooks(whHooks.beforeRun, runtime.getTools(), {}, session.id, whLogPrefix);
        if (skipped) {
          return c.json({ ok: true, action: "agent", skipped: true, sessionId: session.id });
        }
      }

      const response = await runAgentLoop(message, {
        ...runtime.buildLoopOptions({ session, agentName: route.agent ?? route.profile }),
      });

      // --- afterRun hooks ---
      if (whHooks.afterRun.length > 0) {
        await executeHooks(whHooks.afterRun, runtime.getTools(), { response: response ?? "" }, session.id, whLogPrefix);
      }

      return c.json({ ok: true, action: "agent", response, sessionId: session.id });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- Static file serving (production build) ---

  const uiDist = opts.uiDistPath;

  if (uiDist && existsSync(uiDist)) {
    app.use("/*", serveStatic({ root: uiDist }));

    // SPA fallback: serve index.html for non-API routes so client-side routing works
    app.get("*", (c) => {
      const indexPath = resolve(uiDist, "index.html");
      if (existsSync(indexPath)) {
        const html = readFileSync(indexPath, "utf-8");
        return c.html(html);
      }
      return c.notFound();
    });
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
