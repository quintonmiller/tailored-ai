# @tailored-ai/trigger-fs-watcher

Reference implementation of a glob-aware filesystem watcher trigger for TAI workflows. Uses [chokidar](https://github.com/paulmillr/chokidar) for cross-platform file watching with glob pattern support.

## What it does

The `fs_watch` trigger watches one or more paths (including glob patterns) and fires a workflow when matching files are created, modified, or deleted. Unlike the built-in `file_drop` trigger (single directory, no globs), `fs_watch` supports:

- **Glob patterns** — `["./src/**/*.ts", "./config/*.yaml"]`
- **Event filtering** — `["create"]`, `["modify"]`, `["delete"]`, or any combination
- **Debounce** — configurable debounce window (default: 500ms) to avoid firing on mid-write state
- **Pattern exclusion** — ignore patterns like `"*.test.ts"` or `"node_modules/**"`
- **Depth control** — `deep: false` watches only top-level entries

## Workflow input

When the trigger fires, the workflow receives:

```json
{
  "file_path": "/absolute/path/to/file.ts",
  "event": "modify",
  "stat": {
    "size": 1234,
    "mtime": 1700000000000,
    "isFile": true,
    "isDirectory": false
  }
}
```

For `delete` events, `stat` is `null`.

## Workflow example

```yaml
# examples/trigger-fs-watcher/workflow.yaml
name: "watch-code-changes"
description: "Fires when TypeScript source files change"
triggers:
  - kind: fs_watch
    config:
      paths:
        - "./packages/**/*.ts"
      events:
        - "modify"
      debounceMs: 500
      ignored:
        - "*.test.ts"
        - "node_modules/**"
      deep: true
steps:
  - type: notify
    channel: log
    message: |
      File changed: ${input.file_path}
      Event: ${input.event}
      Size: ${input.stat?.size} bytes
```

## Trigger registration

The trigger kind is registered in `packages/core/src/resources/trigger-registry.ts`:

```ts
export const BUILTIN_TRIGGER_KINDS: TriggerKindMeta[] = [
  // ...
  { kind: "fs_watch", description: "Watches paths/globs and fires on create/modify/delete.", async: true },
];
```

## Poller implementation

`FsWatcher` class lives in `packages/core/src/triggers/fs-watch.ts`. It:

1. Resolves paths against `baseDir` (or `process.cwd()` when relative)
2. Creates a chokidar watcher with `ignoreInitial: true` (no fire on startup)
3. Debounces events per-path to avoid duplicate fires during batch writes
4. Fans out to all registered workflows matching the path

## Clean shutdown

The watcher implements `stop()` and `unregister(workflowName)` to close
chokidar handles and clear debounce timers. No orphan watchers remain.

## Installation

```bash
cd examples/trigger-fs-watcher
npm install
npm run build
```

Add to your `config.yaml` plugins:

```yaml
plugins:
  - "@tailored-ai/trigger-fs-watcher"
```

## See also

- Built-in `file_drop` trigger: `packages/core/src/triggers/file-drop.ts`
- Trigger registry: `packages/core/src/resources/trigger-registry.ts`
- Trigger coordinator: `packages/core/src/workflows/trigger-coordinator.ts`
