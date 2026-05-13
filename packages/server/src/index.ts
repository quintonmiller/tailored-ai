import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  deleteSession,
  summarizeSession,
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
  upsertFact,
  findFact,
  listFacts,
  deleteFact,
  forgetFact,
  setSecret,
  listSecrets,
  deleteSecret,
  createDocument,
  getDocument,
  updateDocument,
  deleteDocument,
  listDocuments,
  checkBudget,
  getAutopilotSettings,
  getTokenUsageInWindow,
  updateAutopilotSettings,
  type AutopilotSettings,
  type AutopilotWorker,
  type CronScheduler,
  type AgentRuntime,
  type EngineEvent,
  type TaskWatcher,
  type TaskQueryFilter,
  type ProjectQueryFilter,
  type WorkflowEngine,
  type WorkflowTrigger,
  getWorkflowRun,
  listWorkflowRuns,
  listWorkflowSteps,
  listFormPending,
  globalSandboxRegistry,
  parseWorkflow,
  validateWorkflow,
  resolveWorkflowsDir,
  FileLogStore,
  type FormEvent,
  ResourceLoader,
  FileResourceSource,
  HttpResourceSource,
  GitResourceSource,
  NpmResourceSource,
  TaiRegistrySource,
  Lockfile,
  TrustStore,
  ApprovalGate,
  defaultLockfilePath,
  hashManifest,
  parseSkillMd,
  renderSkillMd,
  readSkillMd,
  type Resource,
  type ResourceKind,
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
  autopilot?: AutopilotWorker;
  workflowEngine?: WorkflowEngine;
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
    const project = c.req.query("project");
    const limit = c.req.query("limit");
    const sessions = listSessions(runtime.db, {
      projectId: project as string | "global" | undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
    return c.json(sessions);
  });

  app.get("/api/sessions/:id/messages", (c) => {
    const { id } = c.req.param();
    const messages = getSessionMessages(runtime.db, id);
    return c.json(messages);
  });

  app.delete("/api/sessions/:id", async (c) => {
    const { id } = c.req.param();
    // ?summarize=0 opts out (default on). ?force=1 re-summarizes even if a
    // prior session-summary note exists.
    const summarizeFlag = c.req.query("summarize");
    const force = c.req.query("force") === "1";
    const wantSummary = summarizeFlag !== "0";

    let noteId: string | null = null;
    if (wantSummary) {
      try {
        const result = await summarizeSession(
          runtime.db,
          id,
          runtime.getProvider(),
          runtime.getModel(),
          { force },
        );
        if (result) noteId = result.noteId;
      } catch (err) {
        console.error("[server] session summary failed:", (err as Error).message);
      }
    }

    const deleted = deleteSession(runtime.db, id);
    if (!deleted) return c.json({ error: "session not found" }, 404);
    return c.json({ deleted: true, summaryNoteId: noteId });
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
    const assignee = c.req.query("assignee");
    if (assignee) filter.assignee = assignee;
    const tags = c.req.query("tags");
    if (tags) filter.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
    const updatedAfter = c.req.query("updated_after");
    if (updatedAfter) filter.updatedAfter = updatedAfter;
    const search = c.req.query("search");
    if (search) filter.search = search;
    const projectId = c.req.query("project_id");
    if (projectId) filter.project_id = projectId;
    const orderBy = c.req.query("order_by");
    if (orderBy === "rank") filter.orderBy = "rank";
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
      assignee?: string | null;
      rank?: number;
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
      assignee?: string | null;
      rank?: number;
      blocked_reason?: string | null;
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

  // --- Facts ---

  app.get("/api/facts", (c) => {
    const projectIdRaw = c.req.query("project_id");
    const projectId = projectIdRaw === "global" || projectIdRaw == null ? null : projectIdRaw;
    const limit = c.req.query("limit");
    const facts = listFacts(runtime.db, {
      project_id: projectId,
      category: c.req.query("category"),
      entity: c.req.query("entity"),
      key: c.req.query("key"),
      search: c.req.query("search"),
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
    return c.json({ facts });
  });

  app.get("/api/facts/:category/:entity/:key", (c) => {
    const { category, entity, key } = c.req.param();
    const projectIdRaw = c.req.query("project_id");
    const projectId = projectIdRaw === "global" || projectIdRaw == null ? null : projectIdRaw;
    const fact = findFact(runtime.db, category, entity, key, projectId);
    if (!fact) return c.json({ error: "Fact not found" }, 404);
    return c.json(fact);
  });

  app.post("/api/facts", async (c) => {
    const body = await c.req.json<{
      category: string;
      entity?: string;
      key: string;
      value: string;
      asof?: string | null;
      source?: string | null;
      confidence?: number | null;
      project_id?: string | null;
    }>();
    if (!body.category || !body.key || body.value === undefined) {
      return c.json({ error: "category, key, and value are required" }, 400);
    }
    try {
      const fact = upsertFact(runtime.db, body);
      return c.json(fact, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.delete("/api/facts/:id", (c) => {
    const { id } = c.req.param();
    const ok = deleteFact(runtime.db, id);
    if (!ok) return c.json({ error: "Fact not found" }, 404);
    return c.json({ ok: true });
  });

  app.delete("/api/facts/:category/:entity/:key", (c) => {
    const { category, entity, key } = c.req.param();
    const projectIdRaw = c.req.query("project_id");
    const projectId = projectIdRaw === "global" || projectIdRaw == null ? null : projectIdRaw;
    const ok = forgetFact(runtime.db, category, entity, key, projectId);
    if (!ok) return c.json({ error: "Fact not found" }, 404);
    return c.json({ ok: true });
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
      default_assignee?: string | null;
      path?: string | null;
      config_overlay_path?: string | null;
      id?: string;
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
      default_assignee?: string | null;
      path?: string | null;
      config_overlay_path?: string | null;
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

  // --- Autopilot ---

  app.get("/api/autopilot/settings", (c) => {
    return c.json(getAutopilotSettings(runtime.db));
  });

  app.patch("/api/autopilot/settings", async (c) => {
    const body = await c.req.json<Partial<AutopilotSettings>>();
    const updated = updateAutopilotSettings(runtime.db, body);
    opts.autopilot?.syncDigestSchedule();
    return c.json(updated);
  });

  app.post("/api/autopilot/digest/run", async (c) => {
    if (!opts.autopilot) return c.json({ error: "Autopilot not available" }, 503);
    await opts.autopilot.runDigest();
    return c.json({ ok: true });
  });

  app.get("/api/autopilot/activity", (c) => {
    return c.json({ current: opts.autopilot?.getActivity() ?? null });
  });

  app.get("/api/autopilot/usage", (c) => {
    const settings = getAutopilotSettings(runtime.db);
    const usage = {
      "1h": getTokenUsageInWindow(runtime.db, 1),
      "5h": getTokenUsageInWindow(runtime.db, 5),
      "24h": getTokenUsageInWindow(runtime.db, 24),
    };
    const budget = checkBudget(runtime.db, settings);
    return c.json({ usage, budget });
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
    tasks: ["tasks"],
    workflows: ["workflows"],
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
      // Optional per-model metadata (context window, etc.). vLLM populates
      // `max_model_len`; most other servers don't advertise it.
      const modelInfo: Record<string, { maxContextTokens?: number }> = {};

      if (providerName === "openai_compatible") {
        const cfg = provCfg as { baseUrl?: string; apiKey?: string };
        if (!cfg.baseUrl) {
          return c.json({ provider: providerName, models: [], modelInfo: {} });
        }
        const baseUrl = cfg.baseUrl.replace(/\/$/, "");
        const headers: Record<string, string> = {};
        if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
        const resp = await fetch(`${baseUrl}/models`, { headers });
        if (!resp.ok) throw new Error(`Provider returned ${resp.status}`);
        const data = (await resp.json()) as { data?: { id: string; max_model_len?: number }[] };
        const entries = data.data ?? [];
        models = entries.map((m) => m.id).sort();
        for (const m of entries) {
          if (typeof m.max_model_len === "number" && m.max_model_len > 0) {
            modelInfo[m.id] = { maxContextTokens: m.max_model_len };
          }
        }
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

      return c.json({ provider: providerName, models, modelInfo });
    } catch (err) {
      return c.json({ provider: providerName, models: [], modelInfo: {}, error: (err as Error).message });
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

    if (route.action === "workflow" || route.workflow) {
      if (!opts.workflowEngine) {
        return c.json({ error: "Workflow engine not configured" }, 503);
      }
      const wfName = route.workflow;
      if (!wfName) {
        return c.json({ error: "webhook route has action 'workflow' but no 'workflow:' name set" }, 400);
      }
      if (!runtime.getWorkflows().get(wfName)) {
        return c.json({ error: `Unknown workflow "${wfName}"` }, 404);
      }
      const promise = opts.workflowEngine.runWorkflow(
        wfName,
        { message, payload, route: routePath },
        "webhook",
      );
      // Don't block the webhook on workflow completion — kick it off and report ack.
      const run = await Promise.race([
        promise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 25)),
      ]);
      if (run) return c.json({ ok: true, action: "workflow", run }, 202);
      return c.json({ ok: true, action: "workflow", workflow: wfName, status: "pending" }, 202);
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

  // --- Workflows ---

  app.get("/api/workflows", (c) => {
    const list = runtime.getWorkflows().list().map((w) => ({
      name: w.definition.name,
      description: w.definition.description,
      source: w.source,
      stepCount: w.definition.steps.length,
    }));
    return c.json({ workflows: list, errors: runtime.getWorkflows().getErrors() });
  });

  app.get("/api/workflows/:name", (c) => {
    const reg = runtime.getWorkflows().get(c.req.param("name"));
    if (!reg) return c.json({ error: "Workflow not found" }, 404);
    return c.json(reg.definition);
  });

  app.post("/api/workflows/:name/run", async (c) => {
    if (!opts.workflowEngine) {
      return c.json({ error: "Workflow engine not configured" }, 503);
    }
    const name = c.req.param("name");
    let body: { input?: unknown; trigger?: WorkflowTrigger; dryRun?: boolean } = {};
    try {
      const text = await c.req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const registered = runtime.getWorkflows().get(name);
    if (!registered) {
      return c.json({ error: `Unknown workflow "${name}"` }, 404);
    }
    // Bearer-token enforcement for webhook triggers. When a workflow declares
    // a webhook trigger with a token, every run-endpoint call must present
    // `Authorization: Bearer <token>` regardless of where it comes from.
    const webhookTrigger = registered.definition.triggers?.find((t) => t.kind === "webhook");
    if (webhookTrigger && "token" in webhookTrigger && webhookTrigger.token) {
      const auth = c.req.header("Authorization") ?? "";
      if (auth !== `Bearer ${webhookTrigger.token}`) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }
    const { validateWorkflowInputs } = await import("@agent/core");
    const validation = validateWorkflowInputs(registered.definition.inputs, body.input);
    if (validation.errors.length > 0) {
      return c.json({ error: "Invalid input", details: validation.errors }, 400);
    }
    // Fire and forget — return the runId immediately. Errors are reported
    // through the run row and SSE events.
    const promise = opts.workflowEngine.runWorkflow(
      name,
      validation.values,
      body.trigger ?? "http",
      { dryRun: body.dryRun === true },
    );
    const run = await Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 25)),
    ]);
    if (run) return c.json(run, 202);
    // Run is still in flight — fetch its current row by polling once.
    const recent = listWorkflowRuns(runtime.db, { workflow_name: name, limit: 1 });
    return c.json(recent[0] ?? { workflow_name: name, status: "pending" }, 202);
  });

  app.get("/api/workflow-runs", (c) => {
    const status = c.req.query("status") as
      | "pending"
      | "running"
      | "completed"
      | "failed"
      | "interrupted"
      | "cancelled"
      | undefined;
    const workflowName = c.req.query("workflow") || undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    const runs = listWorkflowRuns(runtime.db, { workflow_name: workflowName, status, limit });
    return c.json(runs);
  });

  app.get("/api/workflow-runs/:id", (c) => {
    const id = c.req.param("id");
    const run = getWorkflowRun(runtime.db, id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    const steps = listWorkflowSteps(runtime.db, id);
    return c.json({ run, steps });
  });

  app.post("/api/workflow-runs/:id/cancel", (c) => {
    if (!opts.workflowEngine) {
      return c.json({ error: "Workflow engine not configured" }, 503);
    }
    const id = c.req.param("id");
    const run = getWorkflowRun(runtime.db, id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    const ok = opts.workflowEngine.cancel(id);
    return c.json({ ok, runId: id });
  });

  // Pending forms for a given run — used by the run-detail page to surface
  // any human-input checkpoints the workflow has paused on.
  app.get("/api/workflow-runs/:id/forms", (c) => {
    const id = c.req.param("id");
    const run = getWorkflowRun(runtime.db, id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    const forms = listFormPending(runtime.db, { run_id: id });
    return c.json({ forms });
  });

  // Submit values for a pending form. Validates against the form's schema
  // (same validator as workflow inputs), resolves the in-process waiter, and
  // the engine resumes from the form step's completion.
  app.post("/api/workflow-runs/:id/forms/:stepName", async (c) => {
    if (!opts.workflowEngine) {
      return c.json({ error: "Workflow engine not configured" }, 503);
    }
    const id = c.req.param("id");
    const stepName = c.req.param("stepName");
    const run = getWorkflowRun(runtime.db, id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    let payload: unknown = {};
    try {
      payload = await c.req.json();
    } catch {
      // Empty body is acceptable — schema validator will surface missing
      // required fields.
    }
    const result = opts.workflowEngine.forms.submit(id, stepName, payload);
    if (!result.ok) {
      return c.json({ error: result.error, details: result.details }, result.status as 400 | 404 | 409 | 410);
    }
    return c.json({ ok: true, values: result.values });
  });

  // Global pending-forms list — handy for the home page badge ("3 forms
  // waiting") without paying for a per-run scan.
  app.get("/api/workflow-forms", (c) => {
    const forms = listFormPending(runtime.db, { status: "pending" });
    return c.json({ forms });
  });

  app.get("/api/workflow-runs/:id/events", async (c) => {
    const id = c.req.param("id");
    const engine = opts.workflowEngine;
    return streamSSE(c, async (stream) => {
      // Send the initial snapshot.
      const initial = getWorkflowRun(runtime.db, id);
      if (initial) {
        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({
            run: initial,
            steps: listWorkflowSteps(runtime.db, id),
          }),
        });
      } else {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "Run not found" }) });
        return;
      }
      if (initial.status === "completed" || initial.status === "failed" || initial.status === "cancelled") {
        return;
      }

      let closed = false;
      const onClose = () => {
        closed = true;
      };
      c.req.raw.signal.addEventListener("abort", onClose);
      let unsubscribe: (() => void) | undefined;
      let unsubscribeForms: (() => void) | undefined;
      if (engine) {
        unsubscribe = engine.onEvent((event: EngineEvent) => {
          if (closed) return;
          if (!("runId" in event) || event.runId !== id) return;
          stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {});
          if (
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.cancelled"
          ) {
            closed = true;
          }
        });
        // Forward form lifecycle events on the same channel so the UI doesn't
        // need a separate stream. Only emit events for this run.
        unsubscribeForms = engine.forms.onEvent((event: FormEvent) => {
          if (closed) return;
          if (event.runId !== id) return;
          stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {});
        });
      }
      // Keep the connection open until terminal event or client disconnect.
      while (!closed) {
        await new Promise((r) => setTimeout(r, 250));
        // Defensive poll: if the engine is in another instance, we still
        // emit progress from the DB.
        const fresh = getWorkflowRun(runtime.db, id);
        if (fresh && (fresh.status === "completed" || fresh.status === "failed" || fresh.status === "cancelled")) {
          await stream.writeSSE({ event: `run.${fresh.status}`, data: JSON.stringify({ run: fresh }) });
          closed = true;
        }
      }
      unsubscribe?.();
      unsubscribeForms?.();
    });
  });

  // Workflow YAML CRUD on the workflows/ directory.
  app.get("/api/workflows/:name/source", (c) => {
    const name = c.req.param("name");
    const dir = resolveWorkflowsDir(runtime.getConfig().workflows?.directory);
    for (const ext of [".yaml", ".yml"]) {
      const full = join(dir, `${name}${ext}`);
      if (existsSync(full)) {
        return c.json({ name, path: full, content: readFileSync(full, "utf-8") });
      }
    }
    const reg = runtime.getWorkflows().get(name);
    if (reg) {
      return c.json({ name, path: null, content: YAML.stringify(reg.definition) });
    }
    return c.json({ error: "Workflow not found" }, 404);
  });

  app.put("/api/workflows/:name", async (c) => {
    const name = c.req.param("name");
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return c.json({ error: "Invalid workflow name" }, 400);
    }
    let body: { content?: string; definition?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    let content: string;
    let parsed: unknown;
    try {
      if (typeof body.content === "string") {
        content = body.content;
        parsed = parseWorkflow(content);
      } else if (body.definition !== undefined) {
        parsed = body.definition;
        content = YAML.stringify(parsed);
      } else {
        return c.json({ error: "Either content or definition is required" }, 400);
      }
    } catch (err) {
      return c.json({ error: `Parse error: ${(err as Error).message}` }, 400);
    }

    if ((parsed as { name?: string })?.name !== name) {
      return c.json({ error: `Workflow name mismatch — body name "${(parsed as { name?: string })?.name}" does not match URL "${name}"` }, 400);
    }

    const errors = validateWorkflow(parsed);
    if (errors.length > 0) {
      return c.json({ error: "Validation failed", details: errors }, 400);
    }

    const dir = resolveWorkflowsDir(runtime.getConfig().workflows?.directory);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.yaml`);
    writeFileSync(path, content, "utf-8");
    runtime.getWorkflows().reloadFromDisk();
    // Snapshot for version history. Best-effort — surface a warning if it
    // fails but don't fail the save.
    try {
      const { recordVersion } = await import("@agent/core");
      recordVersion(runtime.db, { workflowName: name, yaml: content });
    } catch (err) {
      console.warn(`[workflow-versions] failed to record snapshot: ${(err as Error).message}`);
    }
    return c.json({ ok: true, name, path });
  });

  // --- Workflow version history ---
  app.get("/api/workflows/:name/versions", async (c) => {
    const name = c.req.param("name");
    const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
    const { listVersions } = await import("@agent/core");
    const versions = listVersions(runtime.db, name, Number.isFinite(limit) ? limit : 20);
    // Don't ship every YAML body in the list — they can be hefty. Caller
    // fetches one at a time when they want to diff or restore.
    return c.json({
      versions: versions.map((v) => ({
        version: v.version,
        saved_by: v.saved_by,
        saved_at: v.saved_at,
        bytes: v.yaml.length,
      })),
    });
  });

  app.get("/api/workflows/:name/versions/:version", async (c) => {
    const { name, version } = c.req.param();
    const { getVersion } = await import("@agent/core");
    const v = getVersion(runtime.db, name, Number(version));
    if (!v) return c.json({ error: "Version not found" }, 404);
    return c.json(v);
  });

  app.post("/api/workflows/:name/versions/:version/restore", async (c) => {
    const { name, version } = c.req.param();
    const { getVersion, recordVersion } = await import("@agent/core");
    const v = getVersion(runtime.db, name, Number(version));
    if (!v) return c.json({ error: "Version not found" }, 404);

    const dir = resolveWorkflowsDir(runtime.getConfig().workflows?.directory);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.yaml`);
    writeFileSync(path, v.yaml, "utf-8");
    runtime.getWorkflows().reloadFromDisk();
    try {
      recordVersion(runtime.db, {
        workflowName: name,
        yaml: v.yaml,
        savedBy: `restore-from-v${version}`,
      });
    } catch (err) {
      console.warn(`[workflow-versions] restore snapshot failed: ${(err as Error).message}`);
    }
    return c.json({ ok: true, restoredFrom: Number(version) });
  });

  app.delete("/api/workflows/:name", (c) => {
    const name = c.req.param("name");
    const dir = resolveWorkflowsDir(runtime.getConfig().workflows?.directory);
    let removed = false;
    for (const ext of [".yaml", ".yml"]) {
      const full = join(dir, `${name}${ext}`);
      if (existsSync(full)) {
        unlinkSync(full);
        removed = true;
      }
    }
    if (!removed) return c.json({ error: "Workflow file not found" }, 404);
    runtime.getWorkflows().reloadFromDisk();
    return c.json({ ok: true });
  });

  // --- Workflow analytics ---
  app.get("/api/workflow-analytics", async (c) => {
    const since = c.req.query("since");
    const until = c.req.query("until");
    const w = { since: since || undefined, until: until || undefined };
    const {
      summarizeWorkflowAnalytics,
      perWorkflowMetrics,
      stepHotspots,
      tokenUsageByWorkflow,
    } = await import("@agent/core");
    return c.json({
      summary: summarizeWorkflowAnalytics(runtime.db, w),
      perWorkflow: perWorkflowMetrics(runtime.db, w),
      hotspots: stepHotspots(runtime.db, w),
      tokens: tokenUsageByWorkflow(runtime.db, w),
    });
  });

  // --- Per-workflow secrets ---
  // Values are write-only — GET returns the list of keys plus timestamps,
  // never the decrypted value. Use ${secrets.NAME} in any string field to
  // reference one at run time.
  app.get("/api/workflows/:name/secrets", (c) => {
    const name = c.req.param("name");
    return c.json({ secrets: listSecrets(runtime.db, name) });
  });

  app.put("/api/workflows/:name/secrets/:key", async (c) => {
    const { name, key } = c.req.param();
    let body: { value?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body.value !== "string") {
      return c.json({ error: "value (string) is required" }, 400);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return c.json({ error: "key must be a valid identifier (letters/digits/underscore)" }, 400);
    }
    try {
      setSecret(runtime.db, name, key, body.value);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.delete("/api/workflows/:name/secrets/:key", (c) => {
    const { name, key } = c.req.param();
    const ok = deleteSecret(runtime.db, name, key);
    if (!ok) return c.json({ error: "Secret not found" }, 404);
    return c.json({ ok: true });
  });

  // Per-step log file content (tail or full).
  app.get("/api/workflow-runs/:id/steps/:step/log", async (c) => {
    const id = c.req.param("id");
    const step = c.req.param("step");
    const baseDir = resolve(process.cwd(), "data/workflow-runs");
    const store = new FileLogStore(baseDir);
    const path = store.stepLogPath(id, step);
    if (!existsSync(path)) {
      return c.json({ error: "Log file not found" }, 404);
    }
    const text = await readFile(path, "utf-8");
    return c.json({ runId: id, step, path, content: text });
  });

  // Active sandboxes panel.
  app.get("/api/sandboxes", (c) => {
    return c.json({ sandboxes: globalSandboxRegistry.list() });
  });

  app.delete("/api/sandboxes/:id", async (c) => {
    const id = c.req.param("id");
    const ok = await globalSandboxRegistry.kill(id);
    if (!ok) return c.json({ error: "Sandbox not found" }, 404);
    return c.json({ ok: true });
  });

  // --- Federation / resources (S10.1) ---
  //
  // HTTP mirror of the `tai resources` CLI. Each request reads fresh state from
  // disk (lockfile + trust store) — these are file-backed and cheap, and we
  // want changes made via CLI to show up immediately. The approval flow here
  // is a two-step "preflight then confirm" handshake: an install that needs
  // human approval returns 409 with the resolved manifest; the UI then re-POSTs
  // with `approve: true` once the user clicks through. S10.3 swaps this for a
  // proper SSE-backed flow via the existing /api/approvals queue.

  function buildResourceLoader(): ResourceLoader {
    const loader = new ResourceLoader();
    loader.addSource(new FileResourceSource());
    loader.addSource(new HttpResourceSource());
    loader.addSource(new GitResourceSource());
    loader.addSource(new NpmResourceSource());
    loader.addSource(new TaiRegistrySource());
    return loader;
  }

  /**
   * Register an installed resource into the appropriate live runtime registry.
   * Without this step, an install would land in `tai.lock` but the skill /
   * prompt / KB / etc. wouldn't be reachable from agents until a process
   * restart re-bootstrapped it.
   *
   * Bodies for kinds that ship as data (skill / prompt / kb) are derived from
   * `manifest.data` so agents can use them immediately. Kinds that need
   * compiled bodies (tool / provider / step_executor) only get the manifest
   * record — actually executing them requires the worker-sandbox slice
   * (ptask_s8_6_b).
   */
  function registerInstalledResource(res: Resource): void {
    const { manifest } = res;
    const origin = res.origin;
    switch (manifest.kind) {
      case "skill": {
        const data = (manifest.data ?? {}) as Record<string, unknown>;
        runtime.getSkillRegistry().asResources().register({
          manifest,
          origin,
          body: { manifest, definition: data as never },
        });
        break;
      }
      case "prompt": {
        const data = (manifest.data ?? {}) as Record<string, unknown>;
        const text = typeof data.text === "string" ? data.text : "";
        runtime.getPromptRegistry().asResources().register({
          manifest,
          origin,
          body: { text },
        });
        break;
      }
      case "kb": {
        const data = (manifest.data ?? {}) as Record<string, unknown>;
        const rootPath = typeof data.rootPath === "string" ? data.rootPath : "";
        runtime.getKbRegistry().asResources().register({
          manifest,
          origin,
          body: { rootPath, description: manifest.description },
        });
        break;
      }
      case "tool":
        runtime.getToolRegistry().asResources().register(res);
        break;
      case "provider":
        runtime.getProviderRegistry().asResources().register(res);
        break;
      case "step_executor":
        runtime.getStepExecutorRegistry().asResources().register(res);
        break;
      case "trigger":
        runtime.getTriggerRegistry().asResources().register(res);
        break;
      // workflow / agent / channel / sandbox / task_backend kinds have their
      // own registration surfaces that aren't reachable from this layer yet.
    }
  }

  /**
   * Bootstrap: re-register every lockfile entry into the live runtime
   * registries at server start. Without this, restarting the process would
   * forget every previously-installed resource even though `tai.lock` still
   * lists them.
   */
  (async () => {
    try {
      const lock = Lockfile.read(defaultLockfilePath());
      if (lock.list().length === 0) return;
      const loader = buildResourceLoader();
      for (const entry of lock.list()) {
        try {
          const res = await loader.load(entry.uri);
          registerInstalledResource(res);
        } catch (err) {
          console.warn(
            `[resources] failed to re-register ${entry.kind}/${entry.id} from ${entry.uri}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      console.warn(`[resources] lockfile bootstrap failed: ${(err as Error).message}`);
    }
  })();

  app.get("/api/resources", (c) => {
    const lock = Lockfile.read(defaultLockfilePath());
    return c.json({ resources: lock.list(), lockfilePath: lock.filePath });
  });

  app.get("/api/resources/:kind/:id{.+}", (c) => {
    const kind = c.req.param("kind") as ResourceKind;
    const id = decodeURIComponent(c.req.param("id"));
    const lock = Lockfile.read(defaultLockfilePath());
    const entry = lock.get(kind, id);
    if (!entry) return c.json({ error: "not_found" }, 404);
    const trust = new TrustStore();
    const trusted = trust.getTrustedResource(kind, id, entry.manifestHash);
    return c.json({ entry, trusted: trusted ?? null });
  });

  app.post("/api/resources/install", async (c) => {
    const body = await c
      .req
      .json<{ uri?: string; frozen?: boolean; approve?: boolean; useApprovalQueue?: boolean }>()
      .catch(() => null);
    if (!body?.uri) return c.json({ error: "uri is required" }, 400);

    const loader = buildResourceLoader();
    let res: Resource;
    try {
      res = await loader.load(body.uri);
    } catch (err) {
      return c.json({ error: `failed to fetch: ${(err as Error).message}` }, 400);
    }

    const lockfilePath = defaultLockfilePath();
    const lock = Lockfile.read(lockfilePath);

    // Queue-driven approval path: register an HttpApprovalHandler in the global
    // approvals queue, let ApprovalGate route the prompt through it, and hold
    // the request open until the UI (or another approver) resolves it via
    // POST /api/approvals/:id. Same mechanism tool approvals use.
    if (body.useApprovalQueue && !body.frozen) {
      const trust = new TrustStore();
      const handler = new HttpApprovalHandler();
      const handlerKey = `install_${res.manifest.kind}_${res.manifest.id.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}`;
      registerHandler(handlerKey, handler);
      try {
        const gate = new ApprovalGate({ trust, handler, sessionId: handlerKey });
        const decision = await gate.decide({ resource: res });
        if (decision.approved) {
          lock.upsertResource(res);
          lock.save();
          registerInstalledResource(res);
          return c.json({
            ok: true,
            mode: decision.cached ? "cached" : "approved",
            resource: { manifest: res.manifest, origin: res.origin },
            decision,
          });
        }
        return c.json(
          {
            ok: false,
            mode: "denied",
            resource: { manifest: res.manifest, origin: res.origin },
            reason: decision.reason,
          },
          403,
        );
      } finally {
        unregisterHandler(handlerKey);
      }
    }

    if (body.frozen) {
      const entry = lock.get(res.manifest.kind, res.manifest.id);
      if (!entry) {
        return c.json(
          { error: `--frozen: no lockfile entry for ${res.manifest.kind}/${res.manifest.id}` },
          400,
        );
      }
      if (entry.manifestHash !== hashManifest(res.manifest)) {
        return c.json(
          { error: "manifest hash does not match lockfile", expected: entry.manifestHash, got: hashManifest(res.manifest) },
          409,
        );
      }
      return c.json({
        ok: true,
        mode: "frozen",
        resource: { manifest: res.manifest, origin: res.origin },
      });
    }

    const trust = new TrustStore();
    const gate = new ApprovalGate({ trust });
    const decision = await gate.decide({ resource: res });

    if (decision.approved) {
      lock.upsertResource(res);
      lock.save();
      registerInstalledResource(res);
      return c.json({
        ok: true,
        mode: decision.cached ? "cached" : "auto",
        resource: { manifest: res.manifest, origin: res.origin },
        decision,
      });
    }

    // Untrusted — caller must opt in via approve:true after reviewing.
    if (!body.approve) {
      return c.json(
        {
          ok: false,
          mode: "needs_approval",
          resource: { manifest: res.manifest, origin: res.origin },
          requestedPermissions: res.manifest.permissions ?? {},
          reason: decision.reason,
        },
        409,
      );
    }

    // Caller explicitly approves — record + install.
    trust.approveResource(res.manifest, res.origin.uri, res.manifest.permissions ?? {});
    lock.upsertResource(res);
    lock.save();
    registerInstalledResource(res);
    return c.json({
      ok: true,
      mode: "approved",
      resource: { manifest: res.manifest, origin: res.origin },
    });
  });

  app.delete("/api/resources/:kind/:id{.+}", (c) => {
    const kind = c.req.param("kind") as ResourceKind;
    const id = decodeURIComponent(c.req.param("id"));
    const lock = Lockfile.read(defaultLockfilePath());
    const removed = lock.remove(kind, id);
    if (!removed) return c.json({ error: "not_found" }, 404);
    lock.save();
    new TrustStore().revokeResource(kind, id);
    // Also drop it from the live runtime registry so an agent referencing it
    // immediately stops resolving the now-uninstalled resource.
    switch (kind) {
      case "skill": runtime.getSkillRegistry().unregister(id); break;
      case "prompt": runtime.getPromptRegistry().unregister(id); break;
      case "kb": runtime.getKbRegistry().unregister(id); break;
      case "tool": runtime.getToolRegistry().asResources().unregister({ kind, id }); break;
      case "provider": runtime.getProviderRegistry().asResources().unregister({ kind, id }); break;
      case "step_executor": runtime.getStepExecutorRegistry().asResources().unregister({ kind, id }); break;
      case "trigger": runtime.getTriggerRegistry().unregister(id); break;
    }
    return c.json({ ok: true });
  });

  app.get("/api/registry/search", async (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ results: [] });
    try {
      const src = new TaiRegistrySource();
      const results = await src.search(q.trim());
      return c.json({ results });
    } catch (err) {
      return c.json({ error: (err as Error).message, results: [] }, 200);
    }
  });

  app.get("/api/trust", (c) => {
    const trust = new TrustStore();
    return c.json({
      publishers: trust.listPublishers(),
      resources: trust.listResources(),
    });
  });

  app.post("/api/trust/publisher", async (c) => {
    const body = await c
      .req
      .json<{ publicKey?: string; publisher?: string }>()
      .catch(() => null);
    if (!body?.publicKey || !body?.publisher) {
      return c.json({ error: "publicKey and publisher are required" }, 400);
    }
    const trust = new TrustStore();
    trust.trustPublisher(body.publicKey, body.publisher);
    return c.json({ ok: true });
  });

  app.delete("/api/trust/publisher/:key{.+}", (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const trust = new TrustStore();
    const removed = trust.revokePublisher(key);
    if (!removed) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  // --- Authored resources (S10.4) ---
  //
  // Lightweight CRUD for user-authored skills + prompts. Persists to
  // `<contextDir>/../authored-resources/<kind>/<id>/manifest.yaml` so the
  // resource survives a runtime reload. Loaded on demand each request — there
  // is no in-process cache here, so external changes to the YAML files take
  // effect immediately. Resource registration into the live runtime registries
  // is best-effort: missing pieces (e.g. body for prompts) are derived from
  // the manifest data block at register time.

  const SUPPORTED_AUTHORED_KINDS = new Set(["skill", "prompt", "agent"]);

  function authoredRoot(): string {
    return resolve(runtime.contextDir, "..", "authored-resources");
  }

  function authoredDir(kind: string, id: string): string {
    // ID may include a "/" namespace (e.g. acme/widget). Encode that as a
    // subdirectory so the filesystem layout matches the id naturally.
    return resolve(authoredRoot(), kind, id);
  }

  function authoredManifestPath(kind: string, id: string): string {
    return join(authoredDir(kind, id), "manifest.yaml");
  }

  function authoredSkillMdPath(id: string): string {
    return join(authoredDir("skill", id), "SKILL.md");
  }

  function authoredSafeId(id: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(id) && !id.includes("..");
  }

  function listAuthoredForKind(kind: string): Array<{ kind: string; id: string; manifest: Record<string, unknown> }> {
    const dir = resolve(authoredRoot(), kind);
    if (!existsSync(dir)) return [];
    const out: Array<{ kind: string; id: string; manifest: Record<string, unknown> }> = [];
    function walk(rel: string) {
      const abs = resolve(dir, rel);
      const entries = readdirSync(abs, { withFileTypes: true });
      let hasManifest = false;
      // Prefer SKILL.md when authoring a skill.
      if (kind === "skill") {
        for (const e of entries) {
          if (e.isFile() && /^skill\.md$/i.test(e.name)) {
            hasManifest = true;
            try {
              const text = readFileSync(join(abs, e.name), "utf8");
              const parsed = parseSkillMd(text, { dirName: e.name === "SKILL.md" ? rel.split(/[\\/]/).pop() : undefined });
              out.push({ kind, id: rel.split(/[\\/]/).join("/"), manifest: parsed.manifest as unknown as Record<string, unknown> });
            } catch (err) {
              console.warn(`[authored] failed to parse ${join(abs, e.name)}: ${(err as Error).message}`);
            }
          }
        }
      }
      for (const e of entries) {
        if (e.isFile() && e.name === "manifest.yaml") {
          hasManifest = true;
          const text = readFileSync(join(abs, "manifest.yaml"), "utf8");
          const manifest = YAML.parse(text) as Record<string, unknown>;
          if (kind === "skill") {
            console.warn(
              `[skill] DEPRECATION: ${manifest.id ?? rel} uses manifest.yaml at ${join(abs, "manifest.yaml")}. ` +
                `Migrate to the agentskills.io SKILL.md format.`,
            );
          }
          out.push({ kind, id: rel.split(/[\\/]/).join("/"), manifest });
        }
      }
      if (hasManifest) return;
      for (const e of entries) {
        if (e.isDirectory()) walk(join(rel, e.name));
      }
    }
    walk(".");
    return out;
  }

  function registerAuthored(kind: string, manifest: Record<string, unknown>): void {
    const sourcePath =
      kind === "skill" ? authoredSkillMdPath(manifest.id as string) : authoredManifestPath(kind, manifest.id as string);
    const origin = {
      scheme: "file" as const,
      uri: `file://${sourcePath}`,
      loadedAt: Date.now(),
    };
    if (kind === "skill") {
      const def = manifest.data ?? {};
      runtime.getSkillRegistry().asResources().register({
        manifest: manifest as never,
        origin,
        body: { manifest: manifest as never, definition: def as never },
      });
    } else if (kind === "prompt") {
      const text = ((manifest.data as Record<string, unknown> | undefined)?.text as string | undefined) ?? "";
      runtime.getPromptRegistry().asResources().register({
        manifest: manifest as never,
        origin,
        body: { text },
      });
    } else if (kind === "agent") {
      const definition = (manifest.data ?? {}) as Record<string, unknown>;
      runtime.getAgentRegistry().asResources().register({
        manifest: manifest as never,
        origin,
        body: { manifest: manifest as never, definition: definition as never },
      });
    }
  }

  function unregisterAuthored(kind: string, id: string): boolean {
    if (kind === "skill") return runtime.getSkillRegistry().unregister(id);
    if (kind === "prompt") return runtime.getPromptRegistry().unregister(id);
    if (kind === "agent") return runtime.getAgentRegistry().unregister(id);
    return false;
  }

  // Bootstrap: scan the authored-resources directory once and register everything.
  for (const kind of SUPPORTED_AUTHORED_KINDS) {
    try {
      for (const entry of listAuthoredForKind(kind)) {
        registerAuthored(kind, entry.manifest);
      }
    } catch (err) {
      console.warn(`[authored] failed to load ${kind}: ${(err as Error).message}`);
    }
  }

  app.get("/api/authored", (c) => {
    const kind = c.req.query("kind");
    const kinds = kind ? [kind] : [...SUPPORTED_AUTHORED_KINDS];
    const out: Array<{ kind: string; id: string; manifest: Record<string, unknown> }> = [];
    for (const k of kinds) {
      if (!SUPPORTED_AUTHORED_KINDS.has(k)) continue;
      out.push(...listAuthoredForKind(k));
    }
    return c.json({ resources: out, supportedKinds: [...SUPPORTED_AUTHORED_KINDS] });
  });

  app.post("/api/authored/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (!SUPPORTED_AUTHORED_KINDS.has(kind)) {
      return c.json({ error: `unsupported kind "${kind}"; supported: ${[...SUPPORTED_AUTHORED_KINDS].join(", ")}` }, 400);
    }
    const body = await c.req.json<{
      id?: string;
      version?: string;
      description?: string;
      data?: Record<string, unknown>;
      // agentskills.io SKILL.md fields (skill kind only):
      instructions?: string;
      allowedTools?: string[];
      license?: unknown;
      compatibility?: unknown;
      metadata?: unknown;
    }>().catch(() => null);
    if (!body?.id) return c.json({ error: "id is required" }, 400);
    if (!authoredSafeId(body.id)) {
      return c.json({ error: "id must be alphanumeric with . _ - / characters" }, 400);
    }

    const dir = authoredDir(kind, body.id);
    mkdirSync(dir, { recursive: true });

    let manifest: Record<string, unknown>;
    if (kind === "skill") {
      // Accept either the new SKILL.md shape or a legacy data block.
      const data = (body.data ?? {}) as Record<string, unknown>;
      const instructions =
        typeof body.instructions === "string"
          ? body.instructions
          : typeof data.instructions === "string"
            ? (data.instructions as string)
            : "";
      const allowedTools =
        body.allowedTools ?? (Array.isArray(data.toolRefs) ? (data.toolRefs as string[]) : undefined);
      const skillMdText = renderSkillMd({
        name: body.id,
        description: body.description ?? "",
        body: instructions,
        version: body.version,
        license: body.license ?? data.license,
        compatibility: body.compatibility ?? data.compatibility,
        metadata: body.metadata ?? data.metadata,
        allowedTools,
      });
      writeFileSync(authoredSkillMdPath(body.id), skillMdText, "utf8");
      // If a legacy manifest.yaml is still sitting next to the new SKILL.md,
      // remove it so subsequent listings don't double-register.
      const legacy = authoredManifestPath(kind, body.id);
      if (existsSync(legacy)) {
        try {
          unlinkSync(legacy);
        } catch {
          /* best effort */
        }
      }
      manifest = parseSkillMd(skillMdText).manifest as unknown as Record<string, unknown>;
    } else {
      manifest = {
        kind,
        id: body.id,
        version: body.version ?? "0.0.0",
        description: body.description,
        data: body.data ?? {},
      };
      writeFileSync(authoredManifestPath(kind, body.id), YAML.stringify(manifest), "utf8");
    }
    // Replace any prior registration before re-registering.
    unregisterAuthored(kind, body.id);
    registerAuthored(kind, manifest);
    return c.json({ ok: true, resource: { kind, id: body.id, manifest } });
  });

  app.delete("/api/authored/:kind/:id{.+}", (c) => {
    const kind = c.req.param("kind");
    const id = decodeURIComponent(c.req.param("id"));
    if (!SUPPORTED_AUTHORED_KINDS.has(kind)) return c.json({ error: "unsupported kind" }, 400);
    if (!authoredSafeId(id)) return c.json({ error: "invalid id" }, 400);
    const skillMd = kind === "skill" ? authoredSkillMdPath(id) : null;
    const manifestYaml = authoredManifestPath(kind, id);
    let removedFiles = 0;
    if (skillMd && existsSync(skillMd)) {
      unlinkSync(skillMd);
      removedFiles++;
    }
    if (existsSync(manifestYaml)) {
      unlinkSync(manifestYaml);
      removedFiles++;
    }
    if (removedFiles === 0) return c.json({ error: "not_found" }, 404);
    unregisterAuthored(kind, id);
    return c.json({ ok: true });
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
