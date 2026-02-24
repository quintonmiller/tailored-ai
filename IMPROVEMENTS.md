# Improvement Plan

Identified opportunities to make TAI more user-friendly, robust, and capable.

## Quick Wins

### ~~QW-1: Provider connectivity test in setup wizard~~ DONE
- Added `testProviderConnection()` to `packages/cli/src/setup.ts`
- Tests Ollama (`/api/tags`), OpenAI (`/v1/models`), Anthropic (auth check via `/v1/messages`)
- Shows clear error + "Continue anyway?" on failure

### ~~QW-2: Model discovery in setup wizard~~ DONE
- Ollama: fetches available models via `/api/tags`, presents selection list
- OpenAI/Anthropic: preset model selections with "Custom..." option

### ~~QW-3: `--list-profiles` and `--list-sessions` CLI flags~~ DONE
- `--list-profiles`: shows profiles with model, tools, instruction preview
- `--list-sessions`: shows 20 most recent sessions with ID, key, provider/model, timestamp

### ~~QW-4: Clean stale dist artifacts~~ DONE
- Removed `packages/core/dist/tools/trello.*`

### ~~QW-5: "New Chat" button and profile selector in web UI~~ DONE
- Added "New Chat" button and profile dropdown to `packages/ui/src/pages/Chat.tsx`
- Profile selection passed through to `sendChat()` API call
- Empty state message when no messages exist

### ~~QW-6: Tool execution timing~~ DONE
- Added timing to tool execution in `packages/core/src/agent/loop.ts`
- Appends `[completed in Xms]` for tools taking >= 100ms

## Medium Effort

### ~~ME-1: Config validation~~ DONE
- Added `validateConfig()` to `packages/core/src/config.ts`
- Validates profile tool references, hook tool references, cron job profile references, default provider
- Warnings printed at CLI startup via `[config] Warning: ...`

### ME-2: Provider fallback chain
- **Files**: `packages/core/src/factories.ts`, `packages/core/src/config.ts`
- **What**: Allow configuring a fallback provider. If primary fails N times, automatically switch. `agent.fallbackProvider: openai` or a provider list.
- **Why**: Local Ollama can be unreliable; cloud fallback prevents downtime.

### ~~ME-3: Tool parameter validation~~ DONE
- Added `validateToolArgs()` to `packages/core/src/agent/loop.ts`
- Checks required params and basic type matching before tool execution
- Returns clear errors with expected parameter list to the LLM

### ME-4: Form-based profile builder in UI
- **Files**: `packages/ui/src/pages/Config.tsx`, new component
- **What**: Replace raw YAML editor for profiles with a form: name, model dropdown, instructions textarea, tool checklist, temperature slider, hook builder.
- **Why**: Most users shouldn't need to write YAML for common profile setup.

### ~~ME-5: Retry/backoff on external API tools~~ DONE
- Created `packages/core/src/tools/retry.ts` with `withRetry()` + `isTransientError()`
- Exponential backoff (500ms → 1s → 2s), configurable retries
- Applied to `web_fetch` and `web_search` tools

### ~~ME-6: Session browser in chat UI~~ DONE
- Added toggleable session sidebar to `packages/ui/src/pages/Chat.tsx`
- Shows 30 most recent sessions with key, provider/model, and relative timestamps
- Click to load session history; active session highlighted
- Responsive CSS with sidebar overlay on mobile

### ~~ME-7: Smarter history compaction~~ DONE
- Added `trimHistoryWithSummary()` and `summarizeMessages()` to `packages/core/src/agent/loop.ts`
- When messages would be dropped, summarizes them into a `[Earlier conversation summary: ...]` system message
- Summary is cached across loop rounds to avoid re-summarization
- Opt-in via `summarizeOnTrim: true` in profile config or loop options
- Falls back to silent trimming if summarization fails

### ~~ME-8: Expand tool results in UI~~ DONE
- Added `ToolResultBubble` component to `packages/ui/src/components/MessageBubble.tsx`
- Tool results >500 chars show truncated with Expand/Collapse toggle
- Copy-to-clipboard button for results >100 chars
- Styled with `.tool-result-actions` and `.tool-result-btn` CSS

## Larger Initiatives

### LI-1: Test coverage push
- **What**: Add tests for the top 5 most-used tools (memory, exec, read, write, web_fetch), hook execution, and cron scheduling. Target 40%+ coverage.
- **Why**: Currently 78 tests covering ~10%. Tools are completely untested.

### LI-2: Context relevance scoring
- **What**: Embed context files and only inject ones semantically relevant to the current query. Use lightweight local embeddings or keyword extraction.
- **Why**: Currently all context files are loaded regardless of relevance, wasting prompt tokens.

### LI-3: File manager UI
- **What**: Web UI page for browsing, uploading, previewing, and editing context files and knowledge base documents.
- **Why**: Context/KB management currently requires filesystem access.

### LI-4: Token/cost tracking
- **What**: Log estimated tokens (prompt + completion) per request to a DB table. Show cumulative cost per session/profile in the UI.
- **Why**: Users of OpenAI/Anthropic providers have no visibility into spending.

### LI-5: API documentation (OpenAPI)
- **What**: Auto-generate OpenAPI spec from Hono routes. Serve Swagger UI at `/api/docs`.
- **Why**: No API documentation exists; external integrations must read source code.

### LI-6: Dark mode
- **What**: Add theme toggle to the UI. Use CSS custom properties for colors.
- **Why**: Light-only UI causes eye strain in dark environments.

### ~~LI-7: Parallel tool execution~~ DONE (already implemented)
- Tool calls are already executed concurrently via `Promise.all` in `packages/core/src/agent/loop.ts`

## Code Quality

### CQ-1: Error message improvements
- **What**: Wrap catch blocks with operation context: `Failed to ${operation}: ${err.message}`. Standardize error response format across API endpoints.

### CQ-2: Rate limiting
- **Files**: `packages/server/src/index.ts`, tool base
- **What**: Add rate limiting middleware to API endpoints. Add per-tool rate limits for external API tools.

### CQ-3: Consistent package naming
- **What**: Align `@tailored-ai/cli` npm name with the `@agent/*` workspace pattern, or document the intentional difference.

### ~~CQ-4: Site typecheck fix~~ DONE
- Changed `@agent/site` typecheck script from `next lint` to `tsc --noEmit`
