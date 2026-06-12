import { existsSync, readFileSync } from "node:fs";
import { type AgentConfig, loadConfig } from "@tailored-ai/core";
import { render } from "ink";
import { createElement } from "react";
import { App } from "./App.js";
import { ConflictPrompt } from "./ConflictPrompt.js";
import { HomeDirPrompt } from "./HomeDirPrompt.js";
import { discoverProviders } from "./provider-discovery.js";
import { type DraftConfig, defaultDraft } from "./types.js";

export type EditorMode = "init" | "edit";

export interface RunEditorResult {
  draft: DraftConfig;
  /** Original config text — set when the user edited an existing file. */
  originalText?: string;
  /** Path of the config file the edit targets, if known up front. */
  configPath?: string;
}

export interface RunEditorAppOptions {
  mode: EditorMode;
  /** Required for init mode (offered as the recommended home dir). */
  defaultHomeDir: string;
  /** Set when a config already exists; init mode then prompts edit/replace/cancel. */
  existingConfigPath?: string;
}

class TTYError extends Error {}

function requireTTY() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new TTYError(
      "The Ink editor requires an interactive terminal. Pipe-based usage isn't supported — run from a TTY, or use --dry-run.",
    );
  }
}

/** Render an Ink component to completion. Promise resolves when the component calls onDone. */
function renderOnce<T>(element: (onDone: (value: T) => void) => React.ReactElement): Promise<T> {
  return new Promise<T>((resolveOuter) => {
    let resolved = false;
    const settle = (value: T) => {
      if (resolved) return;
      resolved = true;
      instance.unmount();
      resolveOuter(value);
    };
    const instance = render(element(settle));
  });
}

/** Public entry: orchestrate all Ink prompts for the requested mode. */
export async function runEditorApp(opts: RunEditorAppOptions): Promise<RunEditorResult | null> {
  requireTTY();

  // Step 1: resolve the path. For init+existing, ask edit/replace/cancel; for
  // pure edit, the path is already known; for fresh init, the home dir prompt
  // picks where the new config lives.
  let configPath = opts.existingConfigPath;
  let originalText: string | undefined;
  let homeDir = opts.defaultHomeDir;

  if (opts.mode === "init" && opts.existingConfigPath) {
    const decision = await renderOnce<"edit" | "replace" | "cancel">((done) =>
      createElement(ConflictPrompt, { path: opts.existingConfigPath as string, onChoose: done }),
    );
    if (decision === "cancel") return null;
    if (decision === "edit") {
      configPath = opts.existingConfigPath;
    } else {
      // replace — treat as fresh install at the same path.
      configPath = undefined;
    }
  }

  if (opts.mode === "init" && !configPath) {
    homeDir = await renderOnce<string>((done) =>
      createElement(HomeDirPrompt, { defaultHomeDir: opts.defaultHomeDir, onSubmit: done }),
    );
  }

  // Step 2: build initial draft. Existing config → hydrate from disk; fresh
  // install → defaults.
  let initialDraft: DraftConfig;
  if (configPath && existsSync(configPath)) {
    // Dynamic import keeps the setup.ts ↔ editor circular dependency manageable.
    const { hydrateFromYaml } = await import("../setup.js");
    originalText = readFileSync(configPath, "utf-8");
    initialDraft = hydrateFromYaml(originalText, homeDir);
  } else {
    initialDraft = defaultDraft(homeDir);
  }

  // Step 2b: discover selectable providers — built-ins from the registry,
  // plugin providers by probing the config's plugins against a capture
  // context (#225). The interpolated on-disk config doubles as the base
  // the model-discovery probe runs against.
  let baseConfig: AgentConfig | undefined;
  if (configPath && existsSync(configPath)) {
    try {
      baseConfig = loadConfig(configPath);
    } catch {
      // Unparseable config — the editor still works with built-ins only.
    }
  }
  const providers = await discoverProviders(homeDir, baseConfig);

  // Step 3: drive the editor.
  const finalDraft = await renderOnce<DraftConfig | null>((done) =>
    createElement(App, {
      initialDraft: structuredClone(initialDraft),
      mode: configPath ? "existing" : "new",
      originalText,
      providers,
      baseConfig,
      onSave: (d) => done(d),
      onCancel: () => done(null),
    }),
  );
  if (!finalDraft) return null;
  return { draft: finalDraft, originalText, configPath };
}

export { TTYError };
