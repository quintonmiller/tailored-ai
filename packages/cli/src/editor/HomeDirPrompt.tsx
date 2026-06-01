import { Select, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { resolve as resolvePath } from "node:path";
import { useState } from "react";

interface Props {
  defaultHomeDir: string;
  onSubmit: (homeDir: string) => void;
}

type Mode = "select" | "custom";

export function HomeDirPrompt({ defaultHomeDir, onSubmit }: Props) {
  const [mode, setMode] = useState<Mode>("select");

  if (mode === "custom") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Custom data directory</Text>
        <Box marginTop={1}>
          <TextInput
            defaultValue={defaultHomeDir}
            onSubmit={(v) => {
              const trimmed = v.trim();
              if (!trimmed) return;
              onSubmit(resolvePath(trimmed));
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Welcome to Tailored AI</Text>
      <Box marginTop={1}>
        <Text>Where should tai store its data?</Text>
      </Box>
      <Box marginTop={1}>
        <Select
          options={[
            { label: `${defaultHomeDir}  (recommended)`, value: "home" },
            { label: `${process.cwd()}  (current directory)`, value: "cwd" },
            { label: "Custom path…", value: "custom" },
          ]}
          onChange={(v) => {
            if (v === "home") onSubmit(defaultHomeDir);
            else if (v === "cwd") onSubmit(process.cwd());
            else setMode("custom");
          }}
        />
      </Box>
    </Box>
  );
}
