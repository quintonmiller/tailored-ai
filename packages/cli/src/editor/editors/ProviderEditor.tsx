import { PasswordInput, Select, TextInput } from "@inkjs/ui";
import type { AgentConfig } from "@tailored-ai/core";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { buildProbeConfig, type DiscoveredProvider, listModelsFor } from "../provider-discovery.js";
import { resolveOnePlugin } from "../resolve.js";
import type { Action } from "../state.js";
import type { ProviderDraft, ProviderKind } from "../types.js";

interface Props {
  provider: ProviderDraft;
  homeDir: string;
  /** Selectable providers — registry built-ins + plugin-registered (#225). */
  discovered?: DiscoveredProvider[];
  /** Interpolated on-disk config — base for model-discovery probes. */
  baseConfig?: AgentConfig;
  dispatch: (action: Action) => void;
  onExit: () => void;
}

type Field = "kind" | "baseUrl" | "apiKey" | "defaultModel" | "save";
type FocusState = { field: Field; editing: boolean };
type Mode = "form" | "addCustom" | "resolving" | "customAdded";

/** Friendlier labels for the well-known built-ins; anything else self-labels. */
const KIND_LABELS: Record<string, string> = {
  openai_compatible: "openai_compatible (Ollama, vLLM, LM Studio)",
};

// Hosted vendors (openai, anthropic, openrouter, bedrock, …) are plugins
// (#236) — they appear here via discovery once installed.
const FALLBACK_KINDS = ["openai_compatible"];

const PRESET_URLS: Record<string, string> = {
  vllm: "http://127.0.0.1:8000/v1",
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
};

export function ProviderEditor({ provider, homeDir, discovered, baseConfig, dispatch, onExit }: Props) {
  const [draft, setDraft] = useState<ProviderDraft>(provider);
  const [focus, setFocus] = useState<FocusState>({ field: "kind", editing: false });
  const [mode, setMode] = useState<Mode>("form");
  const [busy, setBusy] = useState<string | undefined>();
  const [addedUri, setAddedUri] = useState<string | undefined>();
  // Model catalog fetched via the provider's optional listModels (#226).
  // undefined = none available (free-text entry); keyed so kind/baseUrl/
  // apiKey edits refetch and stale responses are dropped.
  const [models, setModels] = useState<string[] | undefined>();
  const [manualModel, setManualModel] = useState(false);
  const probeKey = useRef<string>("");

  const kindIds = discovered?.length ? discovered.map((d) => d.id) : FALLBACK_KINDS;
  const kindOptions: { label: string; value: string }[] = [
    ...kindIds.map((id) => {
      const source = discovered?.find((d) => d.id === id)?.source;
      return { label: KIND_LABELS[id] ?? (source === "plugin" ? `${id} (plugin)` : id), value: id };
    }),
    { label: "Use custom provider package…", value: "__custom__" },
  ];

  useEffect(() => {
    const entry = discovered?.find((d) => d.id === draft.kind);
    if (!entry) {
      setModels(undefined);
      return;
    }
    const key = `${draft.kind}|${draft.baseUrl ?? ""}|${draft.apiKey ?? ""}`;
    if (probeKey.current === key) return;
    probeKey.current = key;
    setModels(undefined);
    void listModelsFor(entry, buildProbeConfig(draft.kind, draft, baseConfig)).then((list) => {
      if (probeKey.current === key) setModels(list);
    });
  }, [discovered, draft, baseConfig]);

  const fields: Field[] = ["kind", ...(draft.kind === "openai_compatible" ? ["baseUrl" as Field] : []), "apiKey", "defaultModel", "save"];

  useInput((input, key) => {
    if (mode !== "form") {
      // Esc in any sub-mode returns to the form. handleSubmit('') from
      // the TextInput also routes back here via setMode("form").
      if (key.escape) setMode("form");
      return;
    }
    if (focus.editing) {
      if (key.escape) setFocus({ ...focus, editing: false });
      return;
    }
    if (key.escape) {
      onExit();
      return;
    }
    if (key.upArrow || input === "k") {
      const i = fields.indexOf(focus.field);
      setFocus({ field: fields[Math.max(0, i - 1)], editing: false });
      return;
    }
    if (key.downArrow || input === "j") {
      const i = fields.indexOf(focus.field);
      setFocus({ field: fields[Math.min(fields.length - 1, i + 1)], editing: false });
      return;
    }
    if (key.return) {
      if (focus.field === "save") {
        dispatch({ type: "setProvider", provider: draft });
        onExit();
        return;
      }
      setFocus({ ...focus, editing: true });
    }
  });

  const closeEdit = () => setFocus({ ...focus, editing: false });

  if (mode === "addCustom") {
    return (
      <Box flexDirection="column">
        <Text bold>Edit Provider</Text>
        <Box marginTop={1}>
          <Text>Custom provider package URI:</Text>
        </Box>
        <Box marginTop={1}>
          <TextInput
            placeholder="npm:@some-org/tai-provider-foo"
            onSubmit={(v) => {
              const uri = v.trim();
              if (!uri) {
                setMode("form");
                return;
              }
              setMode("resolving");
              setBusy(`Resolving ${uri}…`);
              void resolveOnePlugin(uri, homeDir).then((resolved) => {
                dispatch({ type: "addPlugin", plugin: resolved });
                setAddedUri(uri);
                setBusy(undefined);
                setMode("customAdded");
              });
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "resolving") {
    return (
      <Box flexDirection="column">
        <Text bold>Edit Provider</Text>
        <Box marginTop={1}>
          <Text dimColor>{busy}</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "customAdded") {
    return (
      <Box flexDirection="column">
        <Text bold>Edit Provider</Text>
        <Box marginTop={1}>
          <Text color="green">Added {addedUri} to plugins.</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text>Next steps:</Text>
          <Text dimColor>· save, then install it: tai plugin install {addedUri}</Text>
          <Text dimColor>· reopen tai edit — the provider's id appears in the Kind list and can be selected here</Text>
          <Text dimColor>· provider-specific options beyond defaultModel stay in its providers.&lt;id&gt; block</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>enter / esc to continue</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Edit Provider</Text>

      <Box marginTop={1} flexDirection="column">
        <FieldRow label="Kind" value={draft.kind} active={focus.field === "kind"}>
          {focus.field === "kind" && focus.editing ? (
            <Select
              defaultValue={draft.kind}
              options={kindOptions}
              onChange={(v) => {
                if (v === "__custom__") {
                  closeEdit();
                  setMode("addCustom");
                  return;
                }
                const kind = v as ProviderKind;
                setDraft((d) => ({ ...d, kind, baseUrl: kind === "openai_compatible" ? d.baseUrl ?? PRESET_URLS.ollama : undefined }));
                closeEdit();
              }}
            />
          ) : null}
        </FieldRow>

        {draft.kind === "openai_compatible" ? (
          <FieldRow label="Base URL" value={draft.baseUrl ?? "(unset)"} active={focus.field === "baseUrl"}>
            {focus.field === "baseUrl" && focus.editing ? (
              <TextInput
                defaultValue={draft.baseUrl ?? PRESET_URLS.ollama}
                onSubmit={(v) => {
                  setDraft((d) => ({ ...d, baseUrl: v.trim() || undefined }));
                  closeEdit();
                }}
              />
            ) : null}
          </FieldRow>
        ) : null}

        <FieldRow
          label="API key"
          value={draft.apiKey ? "••• set" : "(unset)"}
          active={focus.field === "apiKey"}
          dim={!draft.apiKey}
        >
          {focus.field === "apiKey" && focus.editing ? (
            <PasswordInput
              onSubmit={(v) => {
                setDraft((d) => ({ ...d, apiKey: v.trim() || undefined }));
                closeEdit();
              }}
            />
          ) : null}
        </FieldRow>

        <FieldRow
          label="Model"
          value={draft.defaultModel || "(unset)"}
          active={focus.field === "defaultModel"}
          hint={models?.length ? `${models.length} models discovered` : undefined}
        >
          {focus.field === "defaultModel" && focus.editing ? (
            models?.length && !manualModel ? (
              <Select
                defaultValue={models.includes(draft.defaultModel) ? draft.defaultModel : undefined}
                options={[
                  ...models.map((m) => ({ label: m, value: m })),
                  { label: "(enter manually…)", value: "__manual__" },
                ]}
                onChange={(v) => {
                  if (v === "__manual__") {
                    setManualModel(true);
                    return;
                  }
                  setDraft((d) => ({ ...d, defaultModel: v }));
                  closeEdit();
                }}
              />
            ) : (
              <TextInput
                defaultValue={draft.defaultModel}
                onSubmit={(v) => {
                  setDraft((d) => ({ ...d, defaultModel: v.trim() }));
                  setManualModel(false);
                  closeEdit();
                }}
              />
            )
          ) : null}
        </FieldRow>

        <Box marginTop={1}>
          <Text color={focus.field === "save" ? "green" : undefined} bold={focus.field === "save"}>
            {focus.field === "save" ? "▶ " : "  "}[ Save ]
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ field · enter edit/save · esc back</Text>
      </Box>
    </Box>
  );
}

function FieldRow({
  label,
  value,
  active,
  dim,
  hint,
  children,
}: {
  label: string;
  value: string;
  active: boolean;
  dim?: boolean;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={active ? "cyan" : undefined}>
          {active ? "▶ " : "  "}
          {label}: <Text dimColor={dim}>{value}</Text>
          {hint ? <Text dimColor> · {hint}</Text> : null}
        </Text>
      </Box>
      {children ? (
        <Box marginLeft={4} marginTop={1} marginBottom={1}>
          {children}
        </Box>
      ) : null}
    </Box>
  );
}
