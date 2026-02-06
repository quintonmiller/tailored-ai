# Autonomous Agent Framework - Specification

## Project Overview

Build a lightweight, modular AI agent framework optimized for **local LLMs** while supporting cloud providers. This is inspired by OpenClaw but designed from scratch to be simpler and more compatible with smaller models (30B parameter quantized models running on consumer GPUs).

### Why Not OpenClaw?

OpenClaw is excellent for frontier models (GPT-4, Claude) but has issues with local models:

1. **System prompt too large** (~4K tokens) - confuses smaller models
2. **Too many conditional instructions** - "reply NO_REPLY if...", "use HEARTBEAT_OK when..." - models misinterpret these
3. **Complex tool schemas** - 20+ tools with verbose descriptions overwhelm local models
4. **Inconsistent tool call formats** - models output XML instead of JSON under pressure

**Key finding**: When tested directly via Ollama API, local models (qwen3-coder:30b, devstral-small-2) work correctly. The same models fail through OpenClaw due to prompt complexity.

---

## Core Requirements

### 1. Communication Channels

**Priority 1: Discord**
- Bot integration with message handling
- Support for DMs and server channels
- Mention detection and response routing
- Reaction support

**Future**: Slack, Telegram, WhatsApp, Matrix

### 2. AI Provider Support

**Priority 1: Ollama (local)**
- Native `/api/chat` endpoint with `tools` parameter
- Model management and switching
- Temperature and parameter control

**Priority 2: OpenAI** ✅
- Chat completions API
- Tool/function calling
- Configurable base URL for OpenAI-compatible APIs

**Future**: Anthropic, OpenRouter, Azure OpenAI, local llama.cpp, streaming support

### 3. Skills / Tools System

**Priority 1: Built-in core tools**
- `exec` - Run shell commands
- `read` - Read files
- `write` - Write files
- `web_search` - Search the web (Brave, Google, etc.)
- `web_fetch` - Fetch and parse URLs

**Priority 2: Custom skill definitions**
- YAML/JSON skill definitions
- Per-skill system prompts
- Tool parameter schemas

**Future**: Skill marketplace / import system

### 4. Webhook Receiver

- HTTP endpoint for external triggers
- Configurable routes and handlers
- Authentication (token-based)
- Payload templating for agent messages

Use cases:
- Gmail notifications (via Pub/Sub)
- GitHub webhooks
- Calendar alerts
- Home automation triggers

### 5. Main Agent + Sub-agents

**Main Agent**
- Primary conversation handler
- Full context and tool access
- Session management

**Sub-agents**
- Spawned for parallel/background tasks
- Minimal context (reduce token usage)
- Can use different models (cheap model for simple tasks)
- Isolated permissions if needed
- Report results back to main agent

### 6. Cron Jobs

- Schedule recurring agent tasks
- Configurable model/context per job
- Examples: daily email summary, weekly report generation

### 7. Web UI (Minimal Dashboard)

- Agent status and health
- Active sessions list
- Recent logs/activity
- Basic configuration
- Future: chat interface

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript/Node.js | Async-friendly, good ecosystem, familiar |
| Database | SQLite | Simple, file-based, sufficient for single-node |
| Web Framework | Fastify or Hono | Fast, TypeScript-native |
| UI Framework | React or Svelte | For dashboard (can be simple) |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Web UI (Dashboard)                       │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                         HTTP Server                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   Webhooks   │  │   REST API   │  │  WebSocket   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Agent Orchestrator                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Main Agent   │  │ Sub-agents   │  │ Cron Runner  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   Channels   │ │   Providers  │ │    Tools     │
│  ┌────────┐  │ │  ┌────────┐  │ │  ┌────────┐  │
│  │Discord │  │ │  │ Ollama │  │ │  │  exec  │  │
│  │ Slack  │  │ │  │ OpenAI │  │ │  │  read  │  │
│  │  ...   │  │ │  │  ...   │  │ │  │  ...   │  │
│  └────────┘  │ │  └────────┘  │ │  └────────┘  │
└──────────────┘ └──────────────┘ └──────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SQLite Database                             │
│  sessions | messages | tool_results | cron_jobs | config        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Components

### 1. Provider Interface

```typescript
interface AIProvider {
  id: string;
  name: string;

  chat(params: ChatParams): Promise<ChatResponse>;
  chatStream(params: ChatParams): AsyncIterable<ChatDelta>;

  supportsTools: boolean;
  supportedModels: string[];
}

interface ChatParams {
  model: string;
  messages: Message[];
  tools?: Tool[];
  temperature?: number;
  maxTokens?: number;
}

interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  usage: { input: number; output: number };
  finishReason: 'stop' | 'tool_calls' | 'length';
}
```

### 2. Tool Interface

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;

  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  env: Record<string, string>;
}

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}
```

### 3. Channel Interface

```typescript
interface Channel {
  id: string;
  type: 'discord' | 'slack' | 'telegram' | ...;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  onMessage(handler: (msg: IncomingMessage) => void): void;
  send(target: string, content: string): Promise<void>;
}
```

### 4. Agent Loop (Simplified)

```typescript
async function runAgentLoop(session: Session, userMessage: string): Promise<string> {
  const messages = await getSessionHistory(session.id);
  messages.push({ role: 'user', content: userMessage });

  const systemPrompt = buildSystemPrompt(session); // Keep this SHORT for local models

  while (true) {
    const response = await provider.chat({
      model: session.model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools: getEnabledTools(session),
    });

    messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

    if (response.finishReason === 'stop') {
      await saveSessionHistory(session.id, messages);
      return response.content;
    }

    // Execute tool calls
    for (const call of response.toolCalls) {
      const result = await executeTool(call.name, call.arguments, session);
      messages.push({ role: 'tool', toolCallId: call.id, content: result.output });
    }
  }
}
```

---

## Critical Lessons from OpenClaw Testing

### What Works with Local Models

1. **Simple system prompts** (< 500 tokens)
2. **Clear tool descriptions** (1-2 sentences each)
3. **Explicit instructions** ("Run the date command" vs "What time is it?")
4. **Native Ollama API** (`/api/chat` with `tools` parameter)
5. **Single-step tasks** with clear tool selection

### What Breaks Local Models

1. **Conditional response tokens** - "reply NO_REPLY if..." causes models to use NO_REPLY inappropriately
2. **Too many tools** - Models struggle to pick the right one from 20+ options
3. **Large context** - Quality degrades after ~4K tokens of history
4. **Vague requests** - Models don't realize they should use tools
5. **Multi-step without guidance** - Models loop or output garbage after many tool calls

### Model-Specific Notes

| Model | Tool Calling | Email Access | Notes |
|-------|--------------|--------------|-------|
| qwen3-coder:30b | ✅ Works | ❌ Refuses (safety) | Good for code, refuses personal data access |
| devstral-small-2 | ✅ Works | ✅ Works | Best all-around for agentic tasks |
| qwen2.5-coder:32b | ❌ Broken | N/A | Outputs XML text instead of JSON tool_calls |

### Recommended Defaults

```typescript
const LOCAL_MODEL_DEFAULTS = {
  maxToolsPerRequest: 5,        // Don't overwhelm with options
  systemPromptMaxTokens: 500,   // Keep it short
  historyMaxTokens: 2000,       // Summarize/compact aggressively
  temperature: 0.3,             // More deterministic tool selection
};
```

---

## System Prompt Guidelines

**DO:**
```
You are a helpful assistant with access to tools.
Available tools: exec (run commands), read (read files), web_search (search web).
Use tools when you need real information. After getting results, summarize for the user.
```

**DON'T:**
```
You are Quill, an AI assistant. In group chats, consider whether to respond or stay silent.
If this is a heartbeat, reply HEARTBEAT_OK unless action needed. For memory flushes,
reply NO_REPLY unless you have something to store. When in shared contexts, don't load
MEMORY.md for security. Use messaging tools for external communication. Consider the
vibe of the conversation before responding...
[500 more tokens of conditional instructions]
```

---

## Implementation Priorities

### Phase 1: Core Agent (Week 1-2)
- [x] Project setup (TypeScript, SQLite, basic structure)
- [x] Ollama provider implementation
- [x] Core tools: exec, read, write
- [x] Basic agent loop with tool calling
- [x] CLI interface for testing

### Phase 2: Discord + Persistence (Week 2-3)
- [x] Discord bot integration
- [x] Session management in SQLite
- [x] Message history persistence
- [x] Basic configuration system

### Phase 3: Sub-agents + Cron (Week 3-4)
- [x] Sub-agent spawning (delegate tool with profiles)
- [x] Model routing (different models for different tasks via profiles)
- [x] Cron job scheduler
- [x] Background task management (async delegate + task_status tool)

### Phase 4: Web UI + Polish (Week 4-5)
- [ ] Minimal dashboard (status, logs) — static files served but UI is stub
- [x] REST API for management (Hono HTTP server with SSE chat)
- [x] OpenAI provider
- [x] web_search, web_fetch tools
- [x] History compaction (trimHistory enforces maxHistoryTokens)

### Phase 5: Extensibility
- [x] Hot-reloadable runtime (`AgentRuntime` with `fs.watch`, dynamic tool/provider resolution per loop iteration)
- [x] Admin tool (runtime config reads/writes, profile management)
- [x] Custom tools (config-defined shell command templates with `{{param}}` interpolation)
- [ ] Additional channels (Slack, Telegram)
- [ ] Webhook improvements
- [ ] Chat UI in dashboard

---

## Configuration Example

```yaml
# config.yaml
server:
  port: 3000
  host: "127.0.0.1"

providers:
  ollama:
    baseUrl: "http://localhost:11434"
    defaultModel: "devstral-small-2:latest"
  openai:
    apiKey: "${OPENAI_API_KEY}"
    defaultModel: "gpt-4o-mini"

agent:
  defaultProvider: "ollama"
  systemPrompt: |
    You are a helpful assistant with access to tools.
    Use them when you need real information.
  maxHistoryTokens: 2000
  temperature: 0.3

channels:
  discord:
    enabled: true
    token: "${DISCORD_BOT_TOKEN}"
    allowedGuilds:
      - id: "123456789"
        channels: ["general", "bot-commands"]

tools:
  exec:
    enabled: true
    allowedCommands: ["gog", "git", "npm", "date", "ls"]
  read:
    enabled: true
    allowedPaths: ["/home/quint/repos", "/home/quint/.config"]
  web_search:
    enabled: true
    provider: "brave"
    apiKey: "${BRAVE_API_KEY}"

webhooks:
  enabled: true
  secret: "${WEBHOOK_SECRET}"
  routes:
    - path: "/gmail"
      action: "agent"
      messageTemplate: "New email from {{from}}: {{subject}}"

cron:
  jobs:
    - name: "daily-email-summary"
      schedule: "0 9 * * *"
      task: "Summarize my unread emails from the last 24 hours"
      model: "devstral-small-2:latest"
```

---

## File Structure

```
autonomous-agent/
├── src/
│   ├── cli.ts                # CLI entry point
│   ├── index.ts              # Library exports
│   ├── config.ts             # Configuration loading
│   ├── runtime.ts            # AgentRuntime: hot-reloadable state
│   ├── context.ts            # Context/memory file loader
│   ├── server.ts             # Hono HTTP server (REST API + SSE chat)
│   ├── agent/
│   │   ├── loop.ts           # Agent loop with history compaction
│   │   ├── session.ts        # Session management
│   │   ├── profiles.ts       # Agent profile resolution
│   │   ├── prompt.ts         # Base system prompt
│   │   └── tasks.ts          # In-memory background task tracking
│   ├── providers/
│   │   ├── interface.ts      # Provider interface
│   │   ├── ollama.ts         # Ollama implementation
│   │   └── openai.ts         # OpenAI implementation
│   ├── channels/
│   │   ├── interface.ts      # Channel interface
│   │   └── discord.ts        # Discord implementation
│   ├── tools/
│   │   ├── interface.ts      # Tool interface
│   │   ├── exec.ts
│   │   ├── read.ts
│   │   ├── write.ts
│   │   ├── web-search.ts
│   │   ├── web-fetch.ts
│   │   ├── memory.ts
│   │   ├── trello.ts
│   │   ├── gmail.ts
│   │   ├── google-calendar.ts
│   │   ├── claude-code.ts
│   │   ├── delegate.ts       # Sub-agent delegation (sync + async)
│   │   ├── task-status.ts    # Background task inspection
│   │   ├── admin.ts          # Runtime config and profile management
│   │   └── custom.ts         # Config-defined shell command tools
│   ├── cron/
│   │   └── scheduler.ts      # Cron job runner
│   └── db/
│       ├── schema.ts         # SQLite schema
│       └── queries.ts        # Database queries
├── ui/                       # Dashboard (static files)
├── config.yaml
├── package.json
└── tsconfig.json
```

---

## Environment Setup

### Local Development

```bash
# Required
- Node.js 20+
- Ollama running locally (http://localhost:11434)
- Discord bot token

# Optional
- OpenAI API key
- Brave Search API key
```

### Hardware (for local LLMs)

Current setup:
- GPU: RTX 5090 (32GB VRAM)
- CPU: Ryzen 7 9800X3D
- RAM: 32GB
- Models: devstral-small-2 (15GB), qwen3-coder:30b (18GB)

---

## Open Questions

1. ~~**Skill hot-reloading** - Should skills be loadable at runtime or require restart?~~ — Resolved: `AgentRuntime` hot-reloads config, tools, and provider. Custom tools can be defined in `config.yaml` and appear immediately. The admin tool lets the agent modify its own config at runtime.
2. **Multi-user** - Is this single-user or should it support multiple Discord users with separate contexts?
3. **Sandboxing** - How strict should exec sandboxing be? Docker? Allowlists only?
4. **Memory/RAG** - Should there be a vector store for long-term memory retrieval?

---

## References

- [Ollama API Docs](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [OpenAI Chat API](https://platform.openai.com/docs/api-reference/chat)
- [Discord.js Guide](https://discordjs.guide/)
- [Better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
