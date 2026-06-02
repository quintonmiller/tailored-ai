import { Select, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { resolveOnePlugin } from "../resolve.js";
import type { Action } from "../state.js";
import type { ResolvedPlugin, SlotChoice } from "../types.js";

interface Props {
  label: string;
  current: SlotChoice;
  /** True when "Disabled" is a meaningful choice for this slot. */
  allowDisabled: boolean;
  /** True when the runtime can swap this slot for a plugin-provided
   *  implementation. UI/Memory currently have no registry, so this is false. */
  allowCustom: boolean;
  /** Action constructor that updates the slot on the parent state. */
  toAction: (choice: SlotChoice) => Action;
  /** When the user picks a custom URI, the resolved plugin is also appended
   *  to draft.plugins so it shows up in the Plugins row. Required only when
   *  allowCustom is true. */
  toPluginAction?: (plugin: ResolvedPlugin) => Action;
  /** Plugin home root (state.draft.homeDir). Used to install the package via
   *  the PluginManager when the user picks a custom URI. */
  homeDir: string;
  dispatch: (a: Action) => void;
  onExit: () => void;
}

type Mode = "select" | "uri" | "resolving";

export function SlotEditor({
  label,
  current,
  allowDisabled,
  allowCustom,
  toAction,
  toPluginAction,
  homeDir,
  dispatch,
  onExit,
}: Props) {
  const [mode, setMode] = useState<Mode>("select");
  const [busy, setBusy] = useState<string | undefined>();

  useInput((_input, key) => {
    if (!key.escape) return;
    if (mode === "uri") {
      setMode("select");
      return;
    }
    if (mode === "select") {
      onExit();
    }
    // resolving — transient, ignore
  });

  if (mode === "uri") {
    return (
      <Box flexDirection="column">
        <Text bold>Edit {label}</Text>
        <Box marginTop={1}>
          <Text>Custom package URI:</Text>
        </Box>
        <Box marginTop={1}>
          <TextInput
            placeholder="npm:@some-org/tai-package"
            onSubmit={(v) => {
              const uri = v.trim();
              if (!uri) {
                setMode("select");
                return;
              }
              setMode("resolving");
              setBusy(`Installing ${uri}…`);
              void resolveOnePlugin(uri, homeDir).then((resolved) => {
                // customUri carries the registered id that ends up in
                // config (e.g. server.ui.provider). Prefer the resolved
                // manifestId; fall back to the URI when the plugin doesn't
                // ship a manifest.
                const providerId = resolved.manifestId ?? uri;
                dispatch(toAction({ customUri: providerId }));
                if (toPluginAction) dispatch(toPluginAction(resolved));
                setBusy(undefined);
                onExit();
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
        <Text bold>Edit {label}</Text>
        <Box marginTop={1}>
          <Text dimColor>{busy}</Text>
        </Box>
      </Box>
    );
  }

  const options = [
    { label: "Built-in (default)", value: "builtin" },
    ...(allowDisabled ? [{ label: "Disabled", value: "disabled" }] : []),
    ...(allowCustom ? [{ label: "Use custom package…", value: "custom" }] : []),
  ];
  const defaultValue =
    current === "builtin" ? "builtin" : current === "disabled" ? "disabled" : "custom";

  return (
    <Box flexDirection="column">
      <Text bold>Edit {label}</Text>
      <Box marginTop={1}>
        <Select
          defaultValue={defaultValue}
          options={options}
          onChange={(v) => {
            if (v === "custom") {
              setMode("uri");
              return;
            }
            if (v === "builtin") dispatch(toAction("builtin"));
            else if (v === "disabled") dispatch(toAction("disabled"));
            onExit();
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ choose · enter select · esc back</Text>
      </Box>
    </Box>
  );
}
