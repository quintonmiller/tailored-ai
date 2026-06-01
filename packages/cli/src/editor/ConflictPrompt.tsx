import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";

interface Props {
  path: string;
  onChoose: (decision: "edit" | "replace" | "cancel") => void;
}

export function ConflictPrompt({ path, onChoose }: Props) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Existing configuration found</Text>
      <Box marginTop={1}>
        <Text>{path} already exists.</Text>
      </Box>
      <Box marginTop={1}>
        <Select
          options={[
            { label: "Edit current config  (recommended)", value: "edit" },
            { label: "Replace with a fresh install  (overwrites)", value: "replace" },
            { label: "Cancel", value: "cancel" },
          ]}
          onChange={(v) => onChoose(v as "edit" | "replace" | "cancel")}
        />
      </Box>
    </Box>
  );
}
