# TAI vs OpenClaw: Feature Gap Analysis

## Legend

- **Has** = TAI has this feature fully
- **Partial** = TAI has some of this, but with gaps
- **Missing** = TAI doesn't have this at all

---

## 1. Self-Hosted Gateway / Control Plane

| Aspect | TAI | OpenClaw | Gap |
|--------|-----|----------|-----|
| Long-lived server process | **Has** | Has | — |
| Unified runtime for all channels | **Has** | Has | — |
| Hot-reloadable config | **Has** | Has | — |
| Health endpoint | **Has** | Has | — |
| Multi-instance coordination | **Missing** | Has | TAI is single-process only, no shared state across instances |
| Node/device pairing | **Missing** | Has | No concept of remote nodes connecting to the gateway |
| WebSocket control plane | **Missing** | Has | TAI uses SSE (unidirectional); OpenClaw uses WebSocket (bidirectional) |

**Verdict: Partial.** TAI has a working server/runtime but lacks the "hub" architecture for multi-instance and device coordination.

---

## 2. Multi-Channel Messaging

| Channel | TAI | OpenClaw |
|---------|-----|----------|
| Discord | **Has** | Has |
| HTTP/REST API | **Has** | Has |
| Webhooks (inbound) | **Has** | Has |
| CLI/REPL | **Has** | Has |
| WhatsApp | **Missing** | Has |
| Telegram | **Missing** | Has |
| Slack | **Missing** | Has |
| Signal | **Missing** | Has |
| iMessage | **Missing** | Has |
| Teams | **Missing** | Has |
| Matrix | **Missing** | Has |
| Google Chat | **Missing** | Has |
| SMS | **Missing** | Has |

**Verdict: Partial.** TAI has 4 channels (Discord, HTTP, webhooks, CLI). OpenClaw has 13+. The `Channel` interface exists for extension, but only Discord is implemented as a real-time chat channel.

---

## 3. Multi-Agent Routing & Session Isolation

| Aspect | TAI | OpenClaw | Gap |
|--------|-----|----------|-----|
| Named agent profiles | **Has** | Has | — |
| Profile-based tool filtering | **Has** | Has | — |
| Delegate tool (sub-agents) | **Has** | Has | — |
| Per-user session isolation | **Has** | Has | — |
| Per-channel session keys | **Has** | Has | — |
| Deterministic routing rules | **Missing** | Has | No rule engine (e.g., "route DMs from X to profile Y") |
| Multiple simultaneous agents | **Missing** | Has | TAI runs one runtime; OpenClaw can run isolated agent workspaces |
| Peer-based bindings | **Missing** | Has | No "route this user to this agent" mappings |
| Agent workspace isolation | **Missing** | Has | All profiles share the same filesystem/DB |
| Cross-agent messaging | **Missing** | Has | Delegate is depth-1 only, no agent-to-agent pub/sub |

**Verdict: Partial.** TAI has profiles + delegation + session keys, but lacks a real routing engine and true workspace isolation between agents.

---

## 4. Tool Governance & Policy

| Aspect | TAI | OpenClaw | Gap |
|--------|-----|----------|-----|
| Per-tool enable/disable | **Has** | Has | — |
| Profile tool allowlists | **Has** | Has | — |
| Path allowlists (read/write) | **Has** | Has | — |
| Command allowlists (exec) | **Has** | Has | — |
| Admin tool write restrictions | **Has** | Has | — |
| Approval/confirmation workflow | **Has** | Has | — |
| Conditional permission rules | **Has** | Has | — |
| Tool groups/profiles (minimal, messaging, coding) | **Missing** | Has | No named tool group presets |
| Per-provider tool restrictions | **Missing** | Has | Same tools regardless of which provider/model |
| Tool deny lists | **Missing** | Has | TAI only has allowlists, not explicit denylists |
| Rate limiting per tool | **Missing** | Has | No per-tool or per-user rate limits |

**Verdict: Partial.** TAI has good per-tool controls and approval flow. Missing tool grouping presets and provider-specific restrictions.

---

## 5. Security Model

| Aspect | TAI | OpenClaw | Gap |
|--------|-----|----------|-----|
| API bearer token auth | **Has** | Has | — |
| Discord owner/guild allowlists | **Has** | Has | — |
| Approval flow (CLI + HTTP) | **Has** | Has | — |
| Config write lockdown (admin tool) | **Has** | Has | — |
| Shell injection filtering (exec) | **Has** | Has | — |
| Audit trail (SQLite messages) | **Has** | Has | — |
| DM pairing / allowlist policies | **Missing** | Has | No user pairing beyond Discord `owner` field |
| Security audit CLI command | **Missing** | Has | No `tai security audit` or `--deep` scan |
| Doctor/repair command | **Missing** | Has | No `tai doctor` for diagnosing issues |
| Threat model documentation | **Missing** | Has | No documented threat model |
| Sandboxing profiles/presets | **Missing** | Has | No predefined security postures (permissive/locked-down) |
| Token/secret scanning | **Missing** | Has | No scanning for exposed secrets in config |
| Local-only bind default | **Partial** | Has | Server binds to `0.0.0.0` by default, not `127.0.0.1` |

**Verdict: Partial.** TAI has the building blocks (auth, allowlists, approval) but lacks the security UX layer (audit commands, doctor, threat docs, sandboxing presets).

---

## 6. Onboarding & Configuration UX

| Aspect | TAI | OpenClaw | Gap |
|--------|-----|----------|-----|
| Setup wizard | **Has** | Has | — |
| Provider connectivity test | **Has** | Has | — |
| Model discovery (Ollama) | **Has** | Has | — |
| Config schema validation | **Has** | Has | — |
| `--list-profiles` / `--list-sessions` | **Has** | Has | — |
| Home dir auto-creation | **Has** | Has | — |
| Hot reload on config edit | **Has** | Has | — |
| `doctor` / repair command | **Missing** | Has | No self-diagnosis tool |
| Config migration on upgrade | **Missing** | Has | No schema versioning or auto-migration |
| In-UI config editing | **Partial** | Has | API exists (`/api/config`) but UI config editor is basic |

**Verdict: Good.** TAI's onboarding is solid. Missing `doctor` and config migration.

---

## 7. Session / Delivery Reliability

| Aspect | TAI | OpenClaw | Gap |
|--------|-----|----------|-----|
| SSE streaming | **Has** | Has | — |
| Retry on transient errors | **Has** | Has | — |
| Tool result truncation | **Has** | Has | — |
| History compaction + summarization | **Has** | Has | — |
| Message chunking for channel limits | **Partial** | Has | Discord 2000-char split exists; no generic chunking |
| Command queueing | **Missing** | Has | No inbound message queue; messages processed synchronously |
| Idempotency keys | **Missing** | Has | No request deduplication |
| Delivery retry on channel failure | **Missing** | Has | If Discord send fails, no retry |
| Offline message buffering | **Missing** | Has | If channel is down, messages are lost |

**Verdict: Partial.** Core streaming/retry exists. Missing queueing, idempotency, and delivery reliability.

---

## 8. Automation Primitives

| Aspect | TAI | OpenClaw | Gap |
|--------|-----|----------|-----|
| Cron jobs | **Has** | Has | — |
| Profile-level hooks (before/after) | **Has** | Has | — |
| Cron-level hooks | **Has** | Has | — |
| Template variables in hooks | **Has** | Has | — |
| `skipIf` conditional execution | **Has** | Has | — |
| Webhook receivers | **Has** | Has | — |
| Event-driven triggers | **Missing** | Has | No "on file change" or "on task status change" triggers beyond cron |
| Workflow chaining | **Missing** | Has | No DAG/pipeline of agent steps |

**Verdict: Good.** TAI's automation is solid. Missing event-driven triggers and workflow composition.

---

## 9. Companion Apps / Nodes

| Aspect | TAI | OpenClaw | Gap |
|--------|-----|----------|-----|
| Web UI (SPA) | **Has** | Has | — |
| Mobile app (iOS/Android) | **Missing** | Has | Web-only |
| Desktop companion | **Missing** | Has | No native desktop integration |
| Device capabilities (camera, screen, location) | **Missing** | Has | No device sensor access |
| Node pairing/roles | **Missing** | Has | No device registration system |

**Verdict: Missing.** TAI is web + CLI only.

---

## 10. Plugin / Extension Ecosystem

| Aspect | TAI | OpenClaw | Gap |
|--------|-----|----------|-----|
| Custom tools (config-only) | **Has** | Has | — |
| Code-level tool interface | **Has** | Has | — |
| Hook system | **Has** | Has | — |
| Plugin registry / marketplace | **Missing** | Has (ClawHub) | No community plugin system |
| Auto-discovery / install | **Missing** | Has | No `tai install <plugin>` |
| Skill registry | **Missing** | Has | No browseable skill catalog |
| Plugin sandboxing | **Missing** | Has | Custom tools run unsandboxed |

**Verdict: Partial.** TAI has extension points (custom tools, hooks, code interface) but no ecosystem infrastructure.

---

## Priority Gap Summary

### Critical gaps (high user-value, TAI is significantly behind)

1. **Security UX** — No audit command, doctor, threat model, or sandboxing presets. This is the #1 operational trust gap.
2. **Deterministic routing** — No rule engine for "user X → profile Y". Limits multi-tenant/multi-persona use.
3. **Delivery reliability** — No message queueing, idempotency, or delivery retry. Breaks in production.
4. **More channels** — Only Discord for real-time chat. Slack and Telegram would double the addressable audience.

### Moderate gaps (differentiators, not blockers)

5. **Tool governance presets** — No named tool groups or per-provider restrictions.
6. **Doctor / diagnostics CLI** — Setup wizard exists, but no post-setup health checks.
7. **Agent workspace isolation** — All profiles share filesystem; no true multi-tenant isolation.
8. **Event-driven triggers** — Cron covers time-based; no file/webhook/DB-change triggers.

### Long-term gaps (moat features, v2+)

9. **Companion apps / mobile nodes** — Major UX differentiator, large engineering effort.
10. **Plugin ecosystem** — Requires stable API surface + security model first.
11. **Multi-instance gateway** — Horizontal scaling; not needed until user base grows.
