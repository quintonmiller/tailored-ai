import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  type AgentRuntime,
  ApprovalGate,
  type AutopilotSettings,
  type AutopilotWorker,
  addTaskComment,
  type Briefing,
  BUDGETED_TOKEN_SOURCES,
  type CollectionListFilter,
  type CollectionType,
  ConfigWriteRejected,
  type CronScheduler,
  checkBudget,
  compactSession,
  countChunks,
  createCollection,
  createDocument,
  createProject,
  createProjectTask,
  type DashboardWidget,
  defaultLockfilePath,
  deleteCollection,
  deleteDocument,
  deleteProject,
  deleteProjectTask,
  deleteSecret,
  deleteSession,
  type EngineEvent,
  type ExploratoryWorker,
  ensureExploratoryState,
  executeCommand,
  executeHooks,
  FileLogStore,
  FileResourceSource,
  type FormEvent,
  findOrCreateSession,
  formatCompactResult,
  formatHits,
  GitResourceSource,
  generateBriefing,
  generateSuggestions,
  getAutopilotSettings,
  getCollection,
  getCollectionStats,
  getDefaultProjectId,
  getDocument,
  getExploratoryRun,
  getNote,
  getProject,
  getProjectTask,
  getSessionMessages,
  getTokenUsageInWindow,
  getWorkflowRun,
  globalSandboxRegistry,
  HttpResourceSource,
  hashManifest,
  isCommand,
  Lockfile,
  listCollections,
  listDocuments,
  listExploratoryRuns,
  listExploratoryStates,
  listFacts,
  listFormPending,
  listNotes,
  listRecentCommentsByAuthor,
  listSecrets,
  listSessions,
  listTasks,
  listWorkflowRuns,
  listWorkflowSteps,
  type MemoryFragment,
  NpmResourceSource,
  type ProjectQueryFilter,
  parseSkillMd,
  parseWorkflow,
  promoteNote,
  providerFactoryRegistry,
  queryProjects,
  queryProjectTasks,
  type Resource,
  type ResourceKind,
  ResourceLoader,
  readRawConfig,
  recallQueryAsync,
  renderSkillMd,
  resetSession,
  resolveDashboardWidgets,
  resolveWorkflowsDir,
  runAgentLoop,
  runMemorySweep,
  SESSION_SUMMARY_TAG,
  type Suggestions,
  setSecret,
  summarizeSession,
  TaiRegistrySource,
  type TaskQueryFilter,
  type TaskWatcher,
  TrustStore,
  type UiProvider,
  updateAutopilotSettings,
  updateDocument,
  updateExploratoryState,
  updateNote,
  updateProject,
  updateProjectTask,
  updateRawConfig,
  updateSessionMeta,
  validateWorkflow,
  type WorkflowEngine,
  type WorkflowTrigger,
  writeRawConfigPath,
  writeRawConfigText,
} from "@tailored-ai/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import YAML from "yaml";
import {
  getAllPendingApprovals,
  HttpApprovalHandler,
  registerHandler,
  resolveApprovalById,
  unregisterHandler,
} from "./approval.js";
import { mountPluginHttpRoutes, routePathToRegex } from "./http-routes.js";
import { checkPortAvailable, portInUseMessage } from "./port.js";

export interface ServerOptions {
  runtime: AgentRuntime;
  scheduler?: CronScheduler;
  taskWatcher?: TaskWatcher;
  autopilot?: AutopilotWorker;
  exploratory?: ExploratoryWorker;
  workflowEngine?: WorkflowEngine;
  /**
   * Active UI provider. Resolved by the CLI via `resolveUiProvider(runtime)`.
   * When set, `mount()` runs before `/*` static serving so custom routes
   * win over the SPA index. When undefined, no UI is served.
   */
  uiProvider?: UiProvider;
  /**
   * MCP status snapshot getter, wired by the CLI to `mcpManager.list()`.
   * Decouples the server from core's `McpManager` — it only sees the
   * serializable shape. Drives `GET /api/mcp` (#249). Undefined when MCP
   * isn't wired (e.g. a host that doesn't run the manager).
   */
  mcpStatus?: () => Array<{ serverId: string; tools: string[]; connectedAt: number }>;
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

/**
 * Constant-time compare for bearer tokens. Buffers of different length
 * are rejected without leaking the length difference through fast return.
 */
function safeBearerEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Build a backend scope string from request params. The SQLite backend
 * parses `project:<id> agent:<name> session:<id>` (space-separated). Other
 * backends may treat scope as opaque, but the format is uniform on the
 * server side so backend swaps don't ripple into routes.
 */
function buildScope(parts: { projectId?: string | null; agent?: string | null; sessionId?: string | null }): string {
  const out: string[] = [];
  if (parts.projectId) out.push(`project:${parts.projectId}`);
  if (parts.agent) out.push(`agent:${parts.agent}`);
  if (parts.sessionId) out.push(`session:${parts.sessionId}`);
  return out.length > 0 ? out.join(" ") : "global";
}

/**
 * Strip a `kind:` prefix from a fragment id. SQLite backend returns
 * `note:abc` / `fact:abc`; the legacy JSON shape exposed the bare id. We
 * peel the prefix back off so the UI keeps working without a migration.
 */
function stripIdPrefix(id: string | undefined, kind: string): string {
  if (!id) return "";
  const prefix = `${kind}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/**
 * Convert a `MemoryFragment` (note kind) back into the legacy Note JSON
 * shape that `/api/memory/notes` has returned since v0. Every field on
 * the legacy shape lives on `fragment.metadata` for SqliteMemoryBackend
 * (see `noteFragment` in sqlite-backend.ts). Other backends may not
 * populate every field — callers tolerate `null`.
 */
function fragmentToNote(fragment: MemoryFragment): Record<string, unknown> {
  const md = (fragment.metadata ?? {}) as Record<string, unknown>;
  return {
    id: stripIdPrefix(fragment.id, "note"),
    content: fragment.text,
    tags: Array.isArray(md.tags) ? md.tags : [],
    importance: typeof md.importance === "number" ? md.importance : null,
    ref_count: typeof md.ref_count === "number" ? md.ref_count : 0,
    created_at: typeof md.created_at === "string" ? md.created_at : null,
    ttl_at: typeof md.ttl_at === "string" ? md.ttl_at : null,
    project_id: typeof md.project_id === "string" ? md.project_id : null,
    agent: typeof md.agent === "string" ? md.agent : null,
    // session_id isn't in the SQLite noteFragment metadata today; callers
    // that want it should `getNote` directly. Surface as null for shape parity.
    session_id: typeof md.session_id === "string" ? md.session_id : null,
  };
}

/**
 * Convert a `MemoryFragment` (fact kind) back into the legacy Fact JSON
 * shape that `/api/facts` has returned since v0. Mirrors `factFragment`
 * in sqlite-backend.ts.
 */
function fragmentToFact(fragment: MemoryFragment): Record<string, unknown> {
  const md = (fragment.metadata ?? {}) as Record<string, unknown>;
  return {
    id: stripIdPrefix(fragment.id, "fact"),
    category: typeof md.category === "string" ? md.category : "",
    entity: typeof md.entity === "string" ? md.entity : "",
    key: typeof md.key === "string" ? md.key : "",
    value: fragment.text,
    asof: typeof md.asof === "string" ? md.asof : null,
    source: typeof md.source === "string" ? md.source : null,
    confidence: typeof md.confidence === "number" ? md.confidence : null,
    project_id: typeof md.project_id === "string" ? md.project_id : null,
    created_at: typeof md.created_at === "string" ? md.created_at : null,
    updated_at: typeof md.updated_at === "string" ? md.updated_at : null,
  };
}

/**
 * The body every paused route returns. Uniform on purpose: a client should be
 * able to detect "paused" once and render it the same way everywhere, rather
 * than string-matching a different error message per endpoint.
 */
function pausedPayload(runtime: AgentRuntime): Record<string, unknown> {
  const state = runtime.getPauseState();
  return {
    error: "Agents are paused",
    paused: true,
    scope: state.pause_scope,
    since: state.paused_at,
    by: state.paused_by,
  };
}

export function createServer(opts: ServerOptions) {
  const startTime = Date.now();
  const { runtime } = opts;

  const app = new Hono();

  // --- Briefing cache (server-process lifetime, single entry) ---
  //
  // One cached briefing, refreshed lazily when it goes stale past
  // `briefing.ttlMinutes`. `inflight` is the single-flight guard: concurrent
  // callers await the same generation instead of triggering N provider calls.
  let briefingCache: Briefing | null = null;
  let briefingInflight: Promise<Briefing> | null = null;

  function briefingTtlMs(): number {
    const minutes = runtime.getConfig().briefing?.ttlMinutes ?? 30;
    return Math.max(0, minutes) * 60_000;
  }
  function briefingIsStale(b: Briefing | null): boolean {
    if (!b) return true;
    return Date.now() - b.generatedAt >= briefingTtlMs();
  }
  /** Run one generation, deduped across concurrent callers (single-flight). */
  function runBriefing(): Promise<Briefing> {
    if (briefingInflight) return briefingInflight;
    const p = generateBriefing(runtime)
      .then((b) => {
        briefingCache = b;
        return b;
      })
      .finally(() => {
        briefingInflight = null;
      });
    briefingInflight = p;
    return p;
  }

  // --- Suggestions cache (server-process lifetime, single entry) ---
  //
  // Same TTL + single-flight contract as the briefing cache above, but for the
  // chat empty-state suggestion chips. Defaults to a shorter `ttlMinutes` since
  // suggestions track current state more tightly than a daily briefing.
  let suggestionsCache: Suggestions | null = null;
  let suggestionsInflight: Promise<Suggestions> | null = null;

  function suggestionsTtlMs(): number {
    const minutes = runtime.getConfig().suggestions?.ttlMinutes ?? 15;
    return Math.max(0, minutes) * 60_000;
  }
  function suggestionsIsStale(s: Suggestions | null): boolean {
    if (!s) return true;
    return Date.now() - s.generatedAt >= suggestionsTtlMs();
  }
  function runSuggestions(): Promise<Suggestions> {
    if (suggestionsInflight) return suggestionsInflight;
    const p = generateSuggestions(runtime)
      .then((s) => {
        suggestionsCache = s;
        return s;
      })
      .finally(() => {
        suggestionsInflight = null;
      });
    suggestionsInflight = p;
    return p;
  }

  // --- Auth middleware ---
  //
  // Two layered checks against `Authorization: Bearer <token>`:
  //
  //   1. server.authToken (preferred) — gates EVERY /api/* route, including
  //      GETs. Set this whenever the server binds non-loopback. Compared
  //      in constant time.
  //   2. server.apiKey (legacy) — gates only mutating verbs. Kept for
  //      back-compat; emits no error when authToken handles the request.
  //
  // OPTIONS passes through both checks (CORS preflight).
  //
  // Plugin routes registered with `auth: "none"` (e.g. the trusted-actions
  // executor callback) are exempt from the server bearer check — they do
  // their own auth. Compiled from the route registry into method + path
  // matchers; `:param` segments become wildcards. Checked against the
  // concrete request path (`c.req.routePath` is the middleware's own `/api/*`
  // pattern inside `app.use`, so it can't identify the matched handler).
  const authExemptMatchers = runtime
    .getHttpRoutes()
    .list()
    .filter((r) => r.auth === "none")
    .map((r) => ({ method: r.method, regex: routePathToRegex(r.mountPath) }));
  app.use("/api/*", async (c, next) => {
    const method = c.req.method;
    if (method === "OPTIONS") return next();

    if (authExemptMatchers.some((m) => m.method === method && m.regex.test(c.req.path))) {
      return next();
    }

    const cfg = runtime.getConfig().server;
    const authHeader = c.req.header("Authorization") ?? "";
    const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    if (cfg.authToken) {
      if (!safeBearerEquals(presented, cfg.authToken)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      return next();
    }

    if (method === "GET" || method === "HEAD") return next();

    if (cfg.apiKey) {
      if (!safeBearerEquals(presented, cfg.apiKey)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
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

  app.patch("/api/sessions/:id", async (c) => {
    const { id } = c.req.param();
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string | null;
      pinned?: boolean;
    };
    const patch: { title?: string | null; pinned?: boolean } = {};
    if (Object.hasOwn(body, "title")) {
      const t = body.title;
      if (t === null) patch.title = null;
      else if (typeof t === "string") patch.title = t.slice(0, 200);
      else return c.json({ error: "title must be string or null" }, 400);
    }
    if (Object.hasOwn(body, "pinned")) {
      if (typeof body.pinned !== "boolean") return c.json({ error: "pinned must be boolean" }, 400);
      patch.pinned = body.pinned;
    }
    const row = updateSessionMeta(runtime.db, id, patch);
    if (!row) return c.json({ error: "session not found" }, 404);
    return c.json(row);
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
        const result = await summarizeSession(runtime.db, id, runtime.getProvider(), runtime.getModel(), { force });
        if (result) noteId = result.noteId;
      } catch (err) {
        console.error("[server] session summary failed:", (err as Error).message);
      }
    }

    const deleted = deleteSession(runtime.db, id);
    if (!deleted) return c.json({ error: "session not found" }, 404);
    return c.json({ deleted: true, summaryNoteId: noteId });
  });

  // ---------------------------------------------------------------------------
  // Memory: notes + chunks + recall (M7).
  // ---------------------------------------------------------------------------

  app.get("/api/memory/notes", async (c) => {
    const project = c.req.query("project");
    const tag = c.req.query("tag");
    const search = c.req.query("search");
    const agent = c.req.query("agent");
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
    // ?project=global → un-scoped (null). Omitted → no project filter.
    const projectFilter = project === undefined ? undefined : project === "global" ? null : project;
    const backend = await runtime.getMemoryBackend();
    if (!backend.list) {
      return c.json({ error: "list not supported by the active memory backend" }, 501);
    }
    // `search` and `agent` aren't first-class on the backend list contract.
    // We over-fetch and filter client-side on the agent metadata; for
    // `search` we substring-match the fragment text. Cheap for the typical
    // notes-table sizes; revisit if a remote backend ships paginated list.
    const scope = buildScope({
      projectId: typeof projectFilter === "string" ? projectFilter : undefined,
      agent: agent || undefined,
    });
    const fragments = await backend.list({
      scope,
      kind: "note",
      tags: tag ? [tag] : undefined,
      limit: search || agent ? Math.max(limit, 500) : limit,
    });
    let notes = fragments.map(fragmentToNote);
    if (agent) notes = notes.filter((n) => n.agent === agent);
    if (search) {
      const needle = search.toLowerCase();
      notes = notes.filter((n) =>
        String(n.content ?? "")
          .toLowerCase()
          .includes(needle),
      );
    }
    return c.json(notes.slice(0, limit));
  });

  app.post("/api/memory/notes", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      content?: unknown;
      tags?: unknown;
      importance?: unknown;
      project_id?: unknown;
      session_id?: unknown;
      agent?: unknown;
      ttl_at?: unknown;
    };
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [];
    const importance =
      typeof body.importance === "number" && body.importance >= 0 && body.importance <= 1 ? body.importance : null;
    const backend = await runtime.getMemoryBackend();
    const scope = buildScope({
      projectId: typeof body.project_id === "string" ? body.project_id : undefined,
      agent: typeof body.agent === "string" ? body.agent : undefined,
      sessionId: typeof body.session_id === "string" ? body.session_id : undefined,
    });
    const { id } = await backend.write(
      { text: body.content },
      {
        kind: "note",
        scope,
        tags,
        suggestedImportance: importance ?? undefined,
        suggestedTtl: typeof body.ttl_at === "string" ? body.ttl_at : null,
      },
    );
    // Re-fetch via backend.get to return the legacy Note shape. When the
    // backend doesn't support get, fall back to a minimal envelope.
    if (backend.get) {
      const fragment = await backend.get(id);
      if (fragment) return c.json(fragmentToNote(fragment), 201);
    }
    return c.json({ id: stripIdPrefix(id, "note") }, 201);
  });

  app.get("/api/memory/notes/:id", async (c) => {
    const { id } = c.req.param();
    const backend = await runtime.getMemoryBackend();
    if (!backend.get) {
      return c.json({ error: "get not supported by the active memory backend" }, 501);
    }
    // Try the prefixed form first (`note:<id>` is the canonical backend
    // identifier), then fall back to bare id for backends that don't use
    // the kind-prefix convention.
    const fragment = (await backend.get(`note:${id}`)) ?? (await backend.get(id));
    if (!fragment) return c.json({ error: "note not found" }, 404);
    return c.json(fragmentToNote(fragment));
  });

  // PATCH stays SQLite-direct: tag/importance/pinned edits operate on
  // SQLite-shape-specific columns and the MemoryBackend write contract
  // doesn't model partial updates.
  app.patch("/api/memory/notes/:id", async (c) => {
    const { id } = c.req.param();
    const existing = getNote(runtime.db, id);
    if (!existing) return c.json({ error: "note not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      tags?: unknown;
      importance?: unknown;
      pinned?: unknown;
    };
    const patch: { tags?: string[]; importance?: number | null } = {};
    if (Object.hasOwn(body, "tags")) {
      if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string")) {
        return c.json({ error: "tags must be string[]" }, 400);
      }
      patch.tags = body.tags as string[];
    }
    if (Object.hasOwn(body, "importance")) {
      if (body.importance === null) {
        patch.importance = null;
      } else if (typeof body.importance !== "number" || body.importance < 0 || body.importance > 1) {
        return c.json({ error: "importance must be number in [0,1] or null" }, 400);
      } else {
        patch.importance = body.importance;
      }
    }
    // Convenience: `pinned: true|false` toggles both the tag and importance.
    if (Object.hasOwn(body, "pinned")) {
      if (typeof body.pinned !== "boolean") {
        return c.json({ error: "pinned must be boolean" }, 400);
      }
      const baseTags = patch.tags ?? existing.tags;
      const withPin = body.pinned
        ? Array.from(new Set([...baseTags, "pinned"]))
        : baseTags.filter((t) => t !== "pinned");
      patch.tags = withPin;
      // Set importance to >= 0.95 so the note also survives any tag-less
      // fallbacks and the TTL sweep.
      if (body.pinned && (patch.importance ?? existing.importance ?? 0) < 0.95) {
        patch.importance = 0.95;
      }
    }
    const updated = updateNote(runtime.db, id, patch);
    if (!updated) return c.json({ error: "note not found" }, 404);
    return c.json(updated);
  });

  app.delete("/api/memory/notes/:id", async (c) => {
    const { id } = c.req.param();
    const backend = await runtime.getMemoryBackend();
    if (!backend.delete) {
      return c.json({ error: "delete not supported by the active memory backend" }, 501);
    }
    // Try the prefixed form (canonical for SQLite), fall back to bare id
    // for backends that don't use the kind-prefix convention.
    const ok = (await backend.delete(`note:${id}`)) || (await backend.delete(id));
    if (!ok) return c.json({ error: "note not found" }, 404);
    return c.json({ deleted: true });
  });

  // Promote stays SQLite-direct: lifecycle operation that owns the chunk
  // table + embedding model, both private to the SQLite backend today.
  app.post("/api/memory/notes/:id/promote", async (c) => {
    const { id } = c.req.param();
    const embedder = runtime.getEmbedder();
    if (!embedder) {
      return c.json(
        { error: "memory.embeddings is not enabled — set memory.embeddings.enabled and baseUrl/model" },
        409,
      );
    }
    const body = (await c.req.json<{ force?: boolean }>().catch(() => ({}))) as { force?: boolean };
    const result = await promoteNote(runtime.db, embedder, id, { force: body.force === true });
    if (!result) return c.json({ error: "note not found" }, 404);
    return c.json(result);
  });

  app.get("/api/memory/recall", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "q is required" }, 400);
    const project = c.req.query("project");
    const projectFilter = project === undefined || project === "global" ? null : project;
    const limit = Number.parseInt(c.req.query("limit") ?? "5", 10);
    const tier = c.req.query("tier") as "any" | "short" | "long" | undefined;
    const embedder = runtime.getEmbedder();
    const backend = await runtime.getMemoryBackend();
    const hits = await recallQueryAsync(
      backend,
      {
        query: q,
        projectId: projectFilter,
        tier: tier ?? "any",
        limit,
        embedder,
        embedModel: runtime.getConfig().memory?.embeddings?.model,
      },
      runtime.db,
    );
    return c.json({ hits, formatted: formatHits(hits) });
  });

  // Stats stays SQLite-direct: analytics over SQLite-specific shape
  // (ref_count, archival tag filter, chunk count) that isn't part of the
  // MemoryBackend contract.
  app.get("/api/memory/stats", (c) => {
    const project = c.req.query("project");
    const projectFilter = project === undefined ? undefined : project === "global" ? null : project;

    // Three counts: live notes, session summaries, chunks.
    const liveNotes = listNotes(runtime.db, {
      project_id: projectFilter,
      excludeExpired: true,
      limit: 10_000,
      includeGlobal: typeof projectFilter === "string",
    });
    const summaries = liveNotes.filter((n) => n.tags.includes(SESSION_SUMMARY_TAG));
    const chunks = countChunks(runtime.db, projectFilter as string | null | undefined);
    // Facts live in a separate table — count them so the stats tile reflects
    // reality when the agent has been writing facts instead of notes.
    const facts = listFacts(runtime.db, {
      project_id: projectFilter as string | null | undefined,
      limit: 10_000,
      includeGlobal: typeof projectFilter === "string",
    });

    // Most-referenced (live) notes.
    const topReferenced = [...liveNotes]
      .filter((n) => n.ref_count > 0)
      .sort((a, b) => b.ref_count - a.ref_count)
      .slice(0, 5)
      .map((n) => ({
        id: n.id,
        content: n.content.slice(0, 200),
        ref_count: n.ref_count,
        importance: n.importance,
        tags: n.tags,
      }));

    const embedder = runtime.getEmbedder();
    return c.json({
      counts: {
        notes: liveNotes.length,
        facts: facts.length,
        sessionSummaries: summaries.length,
        chunks,
      },
      topReferenced,
      embeddingsEnabled: !!embedder,
      embeddingModel: embedder?.defaultModel ?? null,
    });
  });

  // Sweep stays SQLite-direct: lifecycle operation (TTL eviction, ref-count
  // decay) owned by the SQLite backend's internal tables.
  app.post("/api/memory/sweep", (c) => {
    const report = runMemorySweep(runtime.db);
    return c.json(report);
  });

  // Trusted-actions HTTP routes (/api/trusted-actions/*) moved to the
  // @tailored-ai/trusted-actions package — they register through core's HTTP
  // route seam and are mounted below via `mountPluginHttpRoutes`. See #206.

  // === Always-on / exploratory agents ===

  app.get("/api/exploratory/agents", (c) => {
    const config = runtime.getConfig();
    const states = listExploratoryStates(runtime.db);
    const stateByName = new Map(states.map((s) => [s.agent_name, s]));
    const agents = Object.entries(config.agents ?? {})
      .filter(([, def]) => def.online?.enabled)
      .map(([name, def]) => {
        const state = stateByName.get(name);
        return {
          name,
          enabled_in_config: true,
          enabled_in_state: state?.enabled ?? true,
          paused_until: state?.paused_until ?? null,
          last_tick_at: state?.last_tick_at ?? null,
          last_tick_status: state?.last_tick_status ?? null,
          current_interval_ms: state?.current_interval_ms ?? null,
          tokens_today: state?.tokens_today ?? 0,
          runs_today: state?.runs_today ?? 0,
          cadence: def.online?.cadence ?? null,
          budgets: def.online?.budgets ?? null,
        };
      });
    return c.json({
      enabled: !!config.exploratory?.enabled,
      activity: opts.exploratory?.getActivity() ?? null,
      agents,
    });
  });

  app.get("/api/exploratory/runs", (c) => {
    const agentName = c.req.query("agent") || undefined;
    const limit = Number.parseInt(c.req.query("limit") || "20", 10);
    const runs = listExploratoryRuns(runtime.db, {
      agentName,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 20,
    });
    return c.json({ runs });
  });

  app.get("/api/exploratory/runs/:id", (c) => {
    const run = getExploratoryRun(runtime.db, c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json(run);
  });

  app.post("/api/exploratory/agents/:name/pause", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as { hours?: number };
    const hours = body.hours && body.hours > 0 ? Math.min(body.hours, 24 * 7) : 4;
    const until = new Date(Date.now() + hours * 3_600_000).toISOString();
    ensureExploratoryState(runtime.db, name);
    const state = updateExploratoryState(runtime.db, name, { paused_until: until });
    return c.json({ ok: true, paused_until: state.paused_until });
  });

  app.post("/api/exploratory/agents/:name/resume", (c) => {
    const name = c.req.param("name");
    ensureExploratoryState(runtime.db, name);
    const state = updateExploratoryState(runtime.db, name, {
      paused_until: null,
      enabled: true,
    });
    return c.json({ ok: true, state });
  });

  app.post("/api/exploratory/agents/:name/disable", (c) => {
    const name = c.req.param("name");
    ensureExploratoryState(runtime.db, name);
    const state = updateExploratoryState(runtime.db, name, { enabled: false });
    return c.json({ ok: true, state });
  });

  app.post("/api/exploratory/agents/:name/run", async (c) => {
    if (!opts.exploratory) {
      return c.json({ error: "exploratory worker not configured" }, 503);
    }
    const name = c.req.param("name");
    const def = runtime.getConfig().agents?.[name];
    if (!def) return c.json({ error: `unknown agent: ${name}` }, 404);
    if (!def.online?.enabled) {
      return c.json({ error: `agent "${name}" does not have online.enabled` }, 400);
    }
    try {
      const run = await opts.exploratory.runAgent(name, def);
      return c.json({ ok: true, run });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
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

    // Reached only under `scope: all` — the default pause deliberately keeps
    // the owner's own chat working, since it is how you inspect a deployment
    // you have just stopped. Answered as JSON rather than an empty SSE stream
    // so the UI can say why instead of hanging.
    if (runtime.isAgentsPaused("human")) {
      return c.json(pausedPayload(runtime), 503);
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

        const baseOpts = runtime.buildLoopOptions({ session, agentName });
        const combinedSignal = baseOpts.signal
          ? AbortSignal.any([baseOpts.signal, c.req.raw.signal])
          : c.req.raw.signal;
        const response = await runAgentLoop(message, {
          ...baseOpts,
          approvalHandler,
          signal: combinedSignal,
          onTextDelta: (text) => {
            stream.writeSSE({
              event: "delta",
              data: JSON.stringify({ text }),
            });
          },
          onReasoningDelta: (text) => {
            stream.writeSSE({
              event: "reasoning",
              data: JSON.stringify({ text }),
            });
          },
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
          onMemoryRecalled: (info) => {
            stream.writeSSE({
              event: "memory_recalled",
              data: JSON.stringify(info),
            });
          },
          // info shape: { count, sources, pinned } — pinned is the always-inject lane.
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

        // Surface the final turn's reasoning (#254) on the response event so
        // the live UI can attach it without a refetch. The assistant row was
        // saved inside the loop; read its reasoning back from the DB (avoids
        // changing runAgentLoop's string return). On reload, the same field
        // comes from GET /api/sessions/:id/messages.
        const lastReasoning = [...getSessionMessages(runtime.db, session.id)]
          .reverse()
          .find((m) => m.role === "assistant")?.reasoning;
        await stream.writeSSE({
          event: "response",
          data: JSON.stringify({
            content: response,
            reasoning: lastReasoning,
            sessionId: session.id,
            sessionKey: key,
          }),
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

  /**
   * MCP connection status: one entry per connected server with its discovered
   * tool names and connected-at timestamp (#249). Mirrors the startup banner
   * and `tai doctor` so "configured but not connected" is visible instead of
   * silent. Empty array when MCP isn't wired or no server is connected.
   */
  app.get("/api/mcp", (c) => {
    const servers = (opts.mcpStatus?.() ?? []).map((s) => ({
      serverId: s.serverId,
      tools: s.tools,
      toolCount: s.tools.length,
      connectedAt: new Date(s.connectedAt).toISOString(),
    }));
    servers.sort((a, b) => a.serverId.localeCompare(b.serverId));
    return c.json({ servers });
  });

  /**
   * List loaded plugins with their load status and self-described metadata
   * (#228/#229). The host records loadPlugins results onto the runtime;
   * disposers stay server-side — only serializable fields go out.
   */
  app.get("/api/plugins", (c) => {
    const plugins = runtime.getLoadedPlugins().map((p) => ({
      module: p.module,
      ok: p.ok,
      shape: p.shape,
      error: p.error,
      meta: p.meta,
      warnings: p.warnings,
    }));
    plugins.sort((a, b) => a.module.localeCompare(b.module));
    return c.json({ plugins });
  });

  /**
   * List installed skills (catalog form). Drives the per-agent skill picker
   * in the UI. Returns id, description, version, instructions length, and
   * the source URI so users can see where a skill came from. Skills are
   * registered into the SkillRegistry by `registerInstalledResource` when
   * the lockfile bootstrap runs at startup, plus on every `tai resources
   * install` of a skill.
   */
  app.get("/api/skills", (c) => {
    const entries = runtime.getSkillRegistry().listWithManifests();
    const skills = entries.map((e) => ({
      id: e.manifest.id,
      version: e.manifest.version,
      description: e.manifest.description ?? "",
      instructionsLength: e.definition.instructions?.length ?? 0,
      toolRefs: e.definition.toolRefs ?? [],
      uri: e.origin.uri,
    }));
    skills.sort((a, b) => a.id.localeCompare(b.id));
    return c.json({ skills });
  });

  // ----- Agent CRUD (DUX4) -----
  // Routes mutate `agents.<name>` in the raw YAML and trigger a runtime
  // reload. Reuses the same helpers as AdminTool so the agent and a
  // browser-side admin behave identically.

  const VALID_AGENT_NAME = /^[A-Za-z0-9_-]+$/;

  app.post("/api/agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      definition?: unknown;
    };
    const name = body.name;
    const def = body.definition;
    if (typeof name !== "string" || !VALID_AGENT_NAME.test(name)) {
      return c.json({ error: "name must match /^[A-Za-z0-9_-]+$/" }, 400);
    }
    if (!def || typeof def !== "object" || Array.isArray(def)) {
      return c.json({ error: "definition must be an object" }, 400);
    }
    if (runtime.getConfig().agents[name]) {
      return c.json({ error: `agent "${name}" already exists` }, 409);
    }
    try {
      await writeRawConfigPath(runtime, `agents.${name}`, def);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ name, definition: runtime.getConfig().agents[name] }, 201);
  });

  app.patch("/api/agents/:name", async (c) => {
    const { name } = c.req.param();
    if (!VALID_AGENT_NAME.test(name)) {
      return c.json({ error: "invalid agent name" }, 400);
    }
    const existing = runtime.getConfig().agents[name];
    if (!existing) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { definition?: unknown };
    const def = body.definition;
    if (!def || typeof def !== "object" || Array.isArray(def)) {
      return c.json({ error: "definition must be an object" }, 400);
    }
    try {
      // Shallow-merge with the existing raw YAML entry so partial patches
      // don't clobber fields the caller didn't send.
      const raw = readRawConfig(runtime.configPath);
      const agentsRaw = (raw.agents ?? {}) as Record<string, Record<string, unknown>>;
      const merged = { ...(agentsRaw[name] ?? {}), ...(def as Record<string, unknown>) };
      await writeRawConfigPath(runtime, `agents.${name}`, merged);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ name, definition: runtime.getConfig().agents[name] });
  });

  app.delete("/api/agents/:name", async (c) => {
    const { name } = c.req.param();
    if (!VALID_AGENT_NAME.test(name)) {
      return c.json({ error: "invalid agent name" }, 400);
    }
    if (!runtime.getConfig().agents[name]) {
      return c.json({ error: "not found" }, 404);
    }
    try {
      await writeRawConfigPath(runtime, `agents.${name}`, undefined);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ deleted: true });
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

    // Existence is checked against the file before the write rather than
    // inside it: the shared writer's callback has no way to report "404" and
    // returning from it would still rewrite the document for a job that
    // isn't there.
    const currentCron = readRawConfig(runtime.configPath).cron as Record<string, unknown> | undefined;
    const currentJobs = (currentCron?.jobs ?? []) as Record<string, unknown>[];
    if (!currentJobs.some((j) => j.name === name)) {
      return c.json({ error: `Job "${name}" not found in config` }, 404);
    }

    try {
      await updateRawConfig(runtime, (doc) => {
        const cron = doc.cron as Record<string, unknown> | undefined;
        const jobs = (cron?.jobs as Record<string, unknown>[]) ?? [];
        const job = jobs.find((j) => j.name === name);
        if (!job) return;
        if (body.enabled) {
          delete job.enabled; // default is true, keep config clean
        } else {
          job.enabled = false;
        }
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof ConfigWriteRejected ? 400 : 500);
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
      const arr = status
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      filter.status = arr.length === 1 ? arr[0] : arr;
    }
    const author = c.req.query("author");
    if (author) filter.author = author;
    const assignee = c.req.query("assignee");
    if (assignee) filter.assignee = assignee;
    const tags = c.req.query("tags");
    if (tags)
      filter.tags = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
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

  // Recent comments authored by X — used by the Agents page to surface
  // "what has this agent been working on" beyond the current assignee.
  app.get("/api/task-comments", (c) => {
    const author = c.req.query("author");
    if (!author) return c.json({ error: "author query param is required" }, 400);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 20)) : 20;
    return c.json({ comments: listRecentCommentsByAuthor(runtime.db, author, limit) });
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

  // --- Collections (personal tracker: steelbooks, tiki mugs, restaurants, etc.) ---

  app.get("/api/collections", (c) => {
    const filter: CollectionListFilter = {};
    const type = c.req.query("type");
    if (type) filter.type = type as CollectionType;
    const search = c.req.query("search");
    if (search) filter.search = search;
    const limitRaw = c.req.query("limit");
    if (limitRaw) filter.limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 20));
    const offsetRaw = c.req.query("offset");
    if (offsetRaw) filter.offset = Math.max(0, Number.parseInt(offsetRaw, 10) || 0);

    return c.json(listCollections(runtime.db, filter));
  });

  app.get("/api/collections/stats", (c) => {
    return c.json(getCollectionStats(runtime.db));
  });

  app.post("/api/collections", async (c) => {
    const body = await c.req.json<{
      type?: string;
      name?: string;
      notes?: string | null;
      rating?: number | null;
      location?: string | null;
      url?: string | null;
      added_by?: string;
      source?: string;
    }>();

    if (!body.type || !body.name?.trim()) {
      return c.json({ error: "type and name are required" }, 400);
    }

    try {
      const item = createCollection(runtime.db, {
        type: body.type as CollectionType,
        name: body.name,
        notes: body.notes,
        rating: body.rating,
        location: body.location,
        url: body.url,
        added_by: (body.added_by as "user" | "tai") ?? undefined,
        source: (body.source as "email_id" | "chat" | "manual") ?? undefined,
      });
      return c.json(item, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get("/api/collections/:id", (c) => {
    const { id } = c.req.param();
    const item = getCollection(runtime.db, id);
    if (!item) return c.json({ error: "Collection not found" }, 404);
    return c.json(item);
  });

  app.delete("/api/collections/:id", (c) => {
    const { id } = c.req.param();
    const deleted = deleteCollection(runtime.db, id);
    if (!deleted) return c.json({ error: "Collection not found" }, 404);
    return c.json({ ok: true });
  });

  // --- Facts ---

  app.get("/api/facts", async (c) => {
    const projectIdRaw = c.req.query("project_id");
    // Tri-state filter:
    //   "global"           → globals only (project_id IS NULL)
    //   undefined / null   → globals only (back-compat)
    //   "<project-id>"     → that project's facts PLUS globals
    const projectId = projectIdRaw === "global" || projectIdRaw == null ? null : projectIdRaw;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const category = c.req.query("category");
    const entity = c.req.query("entity");
    const key = c.req.query("key");
    const search = c.req.query("search");

    const backend = await runtime.getMemoryBackend();
    if (!backend.list) {
      return c.json({ error: "list not supported by the active memory backend" }, 501);
    }
    // category/entity/key/search aren't first-class on the list contract.
    // Over-fetch then filter client-side from fragment metadata.
    const scope = buildScope({ projectId: typeof projectId === "string" ? projectId : undefined });
    const needsClientFilter = !!(category || entity || key || search);
    const fragments = await backend.list({
      scope,
      kind: "fact",
      limit: needsClientFilter ? Math.max(limit ?? 100, 1000) : limit,
    });
    let facts = fragments.map(fragmentToFact);
    if (category) facts = facts.filter((f) => f.category === category);
    if (entity) facts = facts.filter((f) => f.entity === entity);
    if (key) facts = facts.filter((f) => f.key === key);
    if (search) {
      const needle = search.toLowerCase();
      facts = facts.filter((f) =>
        String(f.value ?? "")
          .toLowerCase()
          .includes(needle),
      );
    }
    if (typeof limit === "number") facts = facts.slice(0, limit);
    return c.json({ facts });
  });

  app.get("/api/facts/:category/:entity/:key", async (c) => {
    const { category, entity, key } = c.req.param();
    const projectIdRaw = c.req.query("project_id");
    const projectId = projectIdRaw === "global" || projectIdRaw == null ? null : projectIdRaw;
    const backend = await runtime.getMemoryBackend();
    const scope = buildScope({ projectId: typeof projectId === "string" ? projectId : undefined });
    const hits = await backend.query({
      wantStructured: { category, entity, key },
      scope,
      limit: 1,
    });
    const fragment = hits[0];
    if (!fragment) return c.json({ error: "Fact not found" }, 404);
    return c.json(fragmentToFact(fragment));
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
      const backend = await runtime.getMemoryBackend();
      const scope = buildScope({
        projectId: typeof body.project_id === "string" ? body.project_id : undefined,
      });
      const structured: Record<string, unknown> = {
        category: body.category,
        entity: body.entity ?? "",
        key: body.key,
      };
      if (body.asof !== undefined && body.asof !== null) structured.asof = body.asof;
      if (body.confidence !== undefined && body.confidence !== null) structured.confidence = body.confidence;
      await backend.write(
        { text: body.value, structured },
        {
          kind: "fact",
          scope,
          sourceUri: body.source ?? undefined,
        },
      );
      // Re-fetch via query to return the canonical Fact shape.
      const hits = await backend.query({
        wantStructured: { category: body.category, entity: body.entity ?? "", key: body.key },
        scope,
        limit: 1,
      });
      const fragment = hits[0];
      if (fragment) return c.json(fragmentToFact(fragment), 201);
      return c.json({ id: "" }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.delete("/api/facts/:id", async (c) => {
    const { id } = c.req.param();
    const backend = await runtime.getMemoryBackend();
    if (!backend.delete) {
      return c.json({ error: "delete not supported by the active memory backend" }, 501);
    }
    const ok = (await backend.delete(`fact:${id}`)) || (await backend.delete(id));
    if (!ok) return c.json({ error: "Fact not found" }, 404);
    return c.json({ ok: true });
  });

  app.delete("/api/facts/:category/:entity/:key", async (c) => {
    const { category, entity, key } = c.req.param();
    const projectIdRaw = c.req.query("project_id");
    const projectId = projectIdRaw === "global" || projectIdRaw == null ? null : projectIdRaw;
    const backend = await runtime.getMemoryBackend();
    if (!backend.delete) {
      return c.json({ error: "delete not supported by the active memory backend" }, 501);
    }
    const scope = buildScope({ projectId: typeof projectId === "string" ? projectId : undefined });
    const hits = await backend.query({
      wantStructured: { category, entity, key },
      scope,
      limit: 1,
    });
    const target = hits[0];
    if (!target || !target.id) return c.json({ error: "Fact not found" }, 404);
    const ok = await backend.delete(target.id);
    if (!ok) return c.json({ error: "Fact not found" }, 404);
    return c.json({ ok: true });
  });

  // --- Projects ---

  app.get("/api/projects", (c) => {
    const filter: ProjectQueryFilter = {};
    const status = c.req.query("status");
    if (status) {
      const arr = status
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
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
      const filename = `${body.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)}.md`;
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
    // Scoped to the sources the caps actually govern, so `usage` and
    // `budget.cap` describe the same thing. Deployment-wide totals — which now
    // include chat, rooms and cron — live at /api/usage.
    const usage = {
      "1h": getTokenUsageInWindow(runtime.db, 1, BUDGETED_TOKEN_SOURCES),
      "5h": getTokenUsageInWindow(runtime.db, 5, BUDGETED_TOKEN_SOURCES),
      "24h": getTokenUsageInWindow(runtime.db, 24, BUDGETED_TOKEN_SOURCES),
    };
    const budget = checkBudget(runtime.db, settings);
    return c.json({ usage, budget });
  });

  /**
   * Where the tokens went. `?hours=` sets the window (default 24).
   *
   * The loop records every provider call, so this covers chat, room wakes,
   * cron and delegation as well as autopilot and exploratory — none of which
   * were counted before. Grouped both ways because they answer different
   * questions: `bySource` says which subsystem is spending, `byAgent` says
   * which agent is.
   */
  app.get("/api/usage", (c) => {
    const hours = Math.max(1, Math.min(24 * 90, Number(c.req.query("hours") ?? 24) || 24));
    const window = `-${hours} hours`;
    const group = (column: "source" | "agent") =>
      runtime.db
        .prepare(
          `SELECT COALESCE(${column}, '(unattributed)') AS key,
                  SUM(prompt_tokens)     AS prompt,
                  SUM(completion_tokens) AS completion,
                  COUNT(*)               AS calls
             FROM token_usage
            WHERE created_at >= datetime('now', ?)
            GROUP BY 1
            ORDER BY prompt DESC`,
        )
        .all(window);

    const totals = runtime.db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens), 0)     AS prompt,
                COALESCE(SUM(completion_tokens), 0) AS completion,
                COUNT(*)                            AS calls
           FROM token_usage
          WHERE created_at >= datetime('now', ?)`,
      )
      .get(window);

    return c.json({ hours, totals, bySource: group("source"), byAgent: group("agent") });
  });

  // --- Briefing endpoints ---
  //
  // GET returns the cached briefing (generating on first call / when stale).
  // POST forces a regeneration. Both are no-ops with `{ enabled: false }` when
  // `briefing.enabled` is off — no provider call, no token cost.

  app.get("/api/briefing", async (c) => {
    if (runtime.getConfig().briefing?.enabled !== true) {
      return c.json({ enabled: false });
    }
    // Fresh cache: serve it without a provider call.
    if (briefingCache && !briefingIsStale(briefingCache)) {
      return c.json({
        enabled: true,
        content: briefingCache.content,
        generatedAt: briefingCache.generatedAt,
        stale: false,
      });
    }
    try {
      const b = await runBriefing();
      return c.json({ enabled: true, content: b.content, generatedAt: b.generatedAt, stale: false });
    } catch (err) {
      // On failure, fall back to a stale cache if we have one so the card
      // still renders something rather than erroring the whole Home page.
      if (briefingCache) {
        return c.json({
          enabled: true,
          content: briefingCache.content,
          generatedAt: briefingCache.generatedAt,
          stale: true,
        });
      }
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Board page widget specs (declarative). The UI renders each via its widget
  // renderer registry; widgets fetch their own data from `options.endpoint`.
  app.get("/api/dashboard", (c) => {
    return c.json({ widgets: resolveDashboardWidgets(runtime.getConfig()) });
  });

  // Persist a Board layout (drag reorder + resize). The body is the widgets in
  // display order with their span; we rewrite `dashboard.widgets` so order/span
  // resolve as given. Config widgets keep their full spec (only order/span
  // change); built-in/provider widgets get a minimal id+type override so their
  // core-owned title/options are preserved by the resolver merge.
  app.post("/api/dashboard/layout", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      widgets?: Array<{ id?: unknown; type?: unknown; span?: unknown; rowSpan?: unknown }>;
    };
    const incoming = Array.isArray(body.widgets) ? body.widgets : null;
    if (!incoming) return c.json({ error: "widgets must be an array" }, 400);

    const existing = new Map((runtime.getConfig().dashboard?.widgets ?? []).map((w) => [w.id, w] as const));
    const seen = new Set<string>();
    const next: DashboardWidget[] = [];
    for (let i = 0; i < incoming.length; i++) {
      const w = incoming[i];
      const id = typeof w?.id === "string" ? w.id : "";
      const type = typeof w?.type === "string" ? w.type : "";
      if (!id || !type || seen.has(id)) {
        return c.json({ error: `invalid or duplicate widget at index ${i}` }, 400);
      }
      seen.add(id);
      const span = Math.min(4, Math.max(1, Math.round(Number(w?.span) || 1)));
      const rowSpan = Math.min(6, Math.max(1, Math.round(Number(w?.rowSpan) || 2)));
      const order = (i + 1) * 10;
      const prior = existing.get(id);
      next.push(prior ? { ...prior, order, span, rowSpan } : { id, type, order, span, rowSpan });
    }

    try {
      await writeRawConfigPath(runtime, "dashboard.widgets", next);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ widgets: resolveDashboardWidgets(runtime.getConfig()) });
  });

  app.post("/api/briefing/refresh", async (c) => {
    if (runtime.getConfig().briefing?.enabled !== true) {
      return c.json({ enabled: false });
    }
    // Rate-limit: refuse if a generation is already running.
    if (briefingInflight) {
      return c.json({ error: "A briefing is already being generated" }, 429);
    }
    try {
      const b = await runBriefing();
      return c.json({ enabled: true, content: b.content, generatedAt: b.generatedAt, stale: false });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- Suggestions endpoint ---
  //
  // GET returns cached chat suggestion chips (generating on first call / when
  // stale). No refresh endpoint — chips are TTL-only. A no-op returning
  // `{ enabled: false }` when `suggestions.enabled` is off: no provider call,
  // no token cost.

  app.get("/api/suggestions", async (c) => {
    if (runtime.getConfig().suggestions?.enabled !== true) {
      return c.json({ enabled: false });
    }
    // Fresh cache: serve it without a provider call.
    if (suggestionsCache && !suggestionsIsStale(suggestionsCache)) {
      return c.json({
        enabled: true,
        suggestions: suggestionsCache.suggestions,
        generatedAt: suggestionsCache.generatedAt,
      });
    }
    try {
      const s = await runSuggestions();
      return c.json({ enabled: true, suggestions: s.suggestions, generatedAt: s.generatedAt });
    } catch (err) {
      // On failure, fall back to a stale cache if we have one so the chips
      // still render rather than erroring the chat empty state.
      if (suggestionsCache) {
        return c.json({
          enabled: true,
          suggestions: suggestionsCache.suggestions,
          generatedAt: suggestionsCache.generatedAt,
        });
      }
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

    // Same reasoning as /api/chat: only `scope: all` blocks a person's own
    // slash command. Checked before the command is parsed so the non-agent
    // branches (new_session, compact, help) refuse too — under `all` nothing
    // should quietly half-work.
    if (runtime.isAgentsPaused("human")) {
      return c.json(pausedPayload(runtime), 503);
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

  /**
   * Resolve a config-section key to its dotted path in the YAML document.
   * Static sections live in SECTION_MAP; per-channel config uses the open
   * `channels.<id>` pattern (e.g. `channels.discord` → `["channels", "discord"]`),
   * so channels register their own config page without a hardcoded list here.
   */
  function resolveSectionPath(key: string): string[] | undefined {
    if (key.startsWith("channels.")) {
      const id = key.slice("channels.".length);
      if (!id || id.includes(".")) return undefined;
      return ["channels", id];
    }
    return SECTION_MAP[key];
  }

  app.get("/api/config/section/:key", (c) => {
    const key = c.req.param("key");
    const path = resolveSectionPath(key);
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
    const path = resolveSectionPath(key);
    if (!path) {
      return c.json({ error: `Unknown section "${key}"` }, 404);
    }
    const body = await c.req.json<{ data: unknown }>();
    if (body.data === undefined) {
      return c.json({ error: "data is required" }, 400);
    }
    try {
      const { warnings } = await updateRawConfig(runtime, (doc) => {
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
      });
      return c.json({ ok: true, warnings });
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof ConfigWriteRejected ? 400 : 500);
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
      // Parsed and validated before it lands. This route used to write the
      // request body straight to disk: because runtime.reload() swallows its
      // own failures, unparseable YAML answered 200 {"ok":true} while the
      // process kept serving the previous config, and the damage only showed
      // up at the next restart.
      const { warnings } = await writeRawConfigText(runtime, body.content);
      return c.json({ ok: true, message: "Config saved and reloaded.", warnings });
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof ConfigWriteRejected ? 400 : 500);
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
      const provCfg = config.providers[dp];
      if (typeof provCfg?.defaultModel === "string" && provCfg.defaultModel) {
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
      const { warnings } = await updateRawConfig(runtime, (doc) => {
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
      });
      return c.json({ ok: true, message: "Provider config saved and reloaded.", warnings });
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof ConfigWriteRejected ? 400 : 500);
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
      } else {
        // Any other provider (plugin-registered or built-in): build it via
        // its registry factory and ask the instance for its catalog through
        // the optional listModels capability. Providers without listModels
        // return an empty list.
        const factory = providerFactoryRegistry.get(providerName);
        if (!factory) {
          return c.json({ error: `No provider factory registered for "${providerName}"` }, 404);
        }
        const probeConfig = {
          ...config,
          agent: { ...config.agent, defaultProvider: providerName },
        };
        const { provider } = factory(probeConfig);
        const listModels = (provider as { listModels?: () => Promise<string[]> }).listModels;
        if (listModels) {
          models = (await listModels.call(provider)).sort();
        }
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

    const route = config.webhooks.routes.find((r) => r.path === `/${routePath}` || r.path === routePath);
    if (!route) {
      return c.json({ error: `No webhook route configured for "/${routePath}"` }, 404);
    }

    // Read the raw body once. Needed up-front because github_hmac auth
    // signs the raw bytes — re-parsing later via c.req.json() would
    // canonicalize whitespace and break the signature check.
    const rawBody = await c.req.text();

    // Per-route auth takes precedence over the global bearer check.
    // - "github_hmac": validate X-Hub-Signature-256 against route.secret
    //   using HMAC-SHA256 of the raw body.
    // - "bearer" (or default + global secret): Authorization: Bearer ...
    if (route.auth === "github_hmac") {
      if (!route.secret) {
        console.error(`[webhook] route "${route.path}" has auth=github_hmac but no secret configured`);
        return c.json({ error: "Route auth misconfigured" }, 500);
      }
      const sigHeader = c.req.header("x-hub-signature-256");
      if (!sigHeader) {
        return c.json({ error: "Missing X-Hub-Signature-256" }, 401);
      }
      const expected = `sha256=${createHmac("sha256", route.secret).update(rawBody).digest("hex")}`;
      // timingSafeEqual requires equal-length buffers — bail early if the
      // header is malformed.
      const a = Buffer.from(sigHeader);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return c.json({ error: "Bad signature" }, 401);
      }
    } else if (route.auth === "bearer" && route.secret) {
      const auth = c.req.header("Authorization");
      if (auth !== `Bearer ${route.secret}`) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    } else if (config.webhooks.secret) {
      // Backwards-compat: global Bearer when no per-route auth is set.
      const auth = c.req.header("Authorization");
      if (auth !== `Bearer ${config.webhooks.secret}`) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
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
      const promise = opts.workflowEngine.runWorkflow(wfName, { message, payload, route: routePath }, "webhook");
      // Don't block the webhook on workflow completion — kick it off and report ack.
      const run = await Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), 25))]);
      if (run) return c.json({ ok: true, action: "workflow", run }, 202);
      return c.json({ ok: true, action: "workflow", workflow: wfName, status: "pending" }, 202);
    }

    // action === 'agent' — send through agent loop.
    //
    // This one does NOT go through the workflow engine, so the gate in
    // `runWorkflow` never sees it: a webhook route with `action: agent` calls
    // `runAgentLoop` directly a few lines below. A third party POSTing to a
    // URL is not a human at a keyboard, so it is autonomous under any scope.
    if (runtime.isAgentsPaused("autonomous")) {
      const state = runtime.getPauseState();
      return c.json(
        {
          error: "Agents are paused",
          paused: true,
          scope: state.pause_scope,
          since: state.paused_at,
        },
        503,
      );
    }

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
    const list = runtime
      .getWorkflows()
      .list()
      .map((w) => ({
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
    const { validateWorkflowInputs } = await import("@tailored-ai/core");
    const validation = validateWorkflowInputs(registered.definition.inputs, body.input);
    if (validation.errors.length > 0) {
      return c.json({ error: "Invalid input", details: validation.errors }, 400);
    }
    // Fire and forget — return the runId immediately. Errors are reported
    // through the run row and SSE events.
    const promise = opts.workflowEngine.runWorkflow(name, validation.values, body.trigger ?? "http", {
      dryRun: body.dryRun === true,
    });
    const run = await Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), 25))]);
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
          if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
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
      return c.json(
        {
          error: `Workflow name mismatch — body name "${(parsed as { name?: string })?.name}" does not match URL "${name}"`,
        },
        400,
      );
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
      const { recordVersion } = await import("@tailored-ai/core");
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
    const { listVersions } = await import("@tailored-ai/core");
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
    const { getVersion } = await import("@tailored-ai/core");
    const v = getVersion(runtime.db, name, Number(version));
    if (!v) return c.json({ error: "Version not found" }, 404);
    return c.json(v);
  });

  app.post("/api/workflows/:name/versions/:version/restore", async (c) => {
    const { name, version } = c.req.param();
    const { getVersion, recordVersion } = await import("@tailored-ai/core");
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
    const { summarizeWorkflowAnalytics, perWorkflowMetrics, stepHotspots, tokenUsageByWorkflow } = await import(
      "@tailored-ai/core"
    );
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
        runtime
          .getSkillRegistry()
          .asResources()
          .register({
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
        runtime
          .getKbRegistry()
          .asResources()
          .register({
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
    const body = await c.req
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
        return c.json({ error: `--frozen: no lockfile entry for ${res.manifest.kind}/${res.manifest.id}` }, 400);
      }
      if (entry.manifestHash !== hashManifest(res.manifest)) {
        return c.json(
          {
            error: "manifest hash does not match lockfile",
            expected: entry.manifestHash,
            got: hashManifest(res.manifest),
          },
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
      case "skill":
        runtime.getSkillRegistry().unregister(id);
        break;
      case "prompt":
        runtime.getPromptRegistry().unregister(id);
        break;
      case "kb":
        runtime.getKbRegistry().unregister(id);
        break;
      case "tool":
        runtime.getToolRegistry().asResources().unregister({ kind, id });
        break;
      case "provider":
        runtime.getProviderRegistry().asResources().unregister({ kind, id });
        break;
      case "step_executor":
        runtime.getStepExecutorRegistry().asResources().unregister({ kind, id });
        break;
      case "trigger":
        runtime.getTriggerRegistry().unregister(id);
        break;
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
    const body = await c.req.json<{ publicKey?: string; publisher?: string }>().catch(() => null);
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
              const parsed = parseSkillMd(text, {
                dirName: e.name === "SKILL.md" ? rel.split(/[\\/]/).pop() : undefined,
              });
              out.push({
                kind,
                id: rel.split(/[\\/]/).join("/"),
                manifest: parsed.manifest as unknown as Record<string, unknown>,
              });
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
      runtime
        .getSkillRegistry()
        .asResources()
        .register({
          manifest: manifest as never,
          origin,
          body: { manifest: manifest as never, definition: def as never },
        });
    } else if (kind === "prompt") {
      const text = ((manifest.data as Record<string, unknown> | undefined)?.text as string | undefined) ?? "";
      runtime
        .getPromptRegistry()
        .asResources()
        .register({
          manifest: manifest as never,
          origin,
          body: { text },
        });
    } else if (kind === "agent") {
      const definition = (manifest.data ?? {}) as Record<string, unknown>;
      runtime
        .getAgentRegistry()
        .asResources()
        .register({
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
      return c.json(
        { error: `unsupported kind "${kind}"; supported: ${[...SUPPORTED_AUTHORED_KINDS].join(", ")}` },
        400,
      );
    }
    const body = await c.req
      .json<{
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
      }>()
      .catch(() => null);
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

  // --- Plugin-mounted HTTP routes ---
  //
  // Adapt every route the runtime's HttpRouteRegistry holds onto Hono. Plugins
  // (e.g. @tailored-ai/trusted-actions) register these via `ctx.http`. Mounted
  // after the core routes and the auth middleware (which already covers
  // `/api/*`), and before the SPA fallback so a plugin route under `/api/ext/…`
  // or an allow-listed absolute path wins over the static index. See #206.
  mountPluginHttpRoutes(app, runtime);

  // --- UI provider (static bundle and/or custom routes) ---

  const uiProvider = opts.uiProvider;

  if (uiProvider?.mount) {
    // Run plugin-supplied mount before the static fallback so custom routes win.
    Promise.resolve(uiProvider.mount(app)).catch((err) => {
      console.warn(`[ui:${uiProvider.id}] mount() failed: ${(err as Error).message}`);
    });
  }

  const uiDist = uiProvider?.staticDir;
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
    // Without a listener, a bind failure is an unhandled 'error' event: the
    // process dies on a raw stack trace that never names the port. The case
    // that matters is a second instance started by mistake — the port is the
    // lock that stops two deployments running at once, so it has to say so.
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(portInUseMessage(hostname, port));
        process.exit(1);
      }
      console.error(`[server] listen failed on ${hostname}:${port}:`, err.message);
      process.exit(1);
    });
    return server;
  }

  return { app, start };
}

export { checkPortAvailable, portInUseMessage } from "./port.js";
