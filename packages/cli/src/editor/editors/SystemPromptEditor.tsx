import { Select, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Action } from "../state.js";

interface Props {
  current: string | undefined;
  dispatch: (a: Action) => void;
  onExit: () => void;
}

type Mode = "select" | "path";

export function SystemPromptEditor({ current, dispatch, onExit }: Props) {
  const [mode, setMode] = useState<Mode>("select");

  useInput((_input, key) => {
    if (!key.escape) return;
    if (mode === "path") {
      setMode("select");
      return;
    }
    onExit();
  });

  if (mode === "path") {
    return (
      <Box flexDirection="column">
        <Text bold>Edit Global system prompt</Text>
        <Box marginTop={1}>
          <Text>Base prompt file path:</Text>
        </Box>
        <Box marginTop={1}>
          <TextInput
            defaultValue={current ?? ""}
            placeholder="/path/to/base-prompt.md"
            onSubmit={(v) => {
              const trimmed = v.trim();
              dispatch({ type: "setSystemPromptBaseFile", baseFile: trimmed || undefined });
              onExit();
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>esc to cancel · empty string clears the override</Text>
        </Box>
      </Box>
    );
  }

  const options = [
    { label: "Built-in default", value: "builtin" },
    { label: "Use base prompt file…", value: "file" },
  ];

  return (
    <Box flexDirection="column">
      <Text bold>Edit Global system prompt</Text>
      <Box marginTop={1}>
        <Text dimColor>
          Sets the default base prompt for every agent. Per-agent `systemPrompt` overrides win field-by-field at runtime.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          For inline `base` strings, custom layers, or layer reordering, edit agent.systemPrompt in YAML directly.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Select
          defaultValue={current ? "file" : "builtin"}
          options={options}
          onChange={(v) => {
            if (v === "file") {
              setMode("path");
              return;
            }
            dispatch({ type: "setSystemPromptBaseFile", baseFile: undefined });
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
