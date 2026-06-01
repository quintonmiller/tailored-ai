import { Box, Text } from "ink";
import type { DiffLine } from "./preview.js";

interface Props {
  lines: DiffLine[];
  maxLines?: number;
}

export function DiffPane({ lines, maxLines = 30 }: Props) {
  if (lines.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Diff</Text>
        <Box marginTop={1}>
          <Text dimColor>No changes yet.</Text>
        </Box>
      </Box>
    );
  }
  const visible = lines.slice(0, maxLines);
  return (
    <Box flexDirection="column">
      <Text bold>Diff</Text>
      <Box marginTop={1} flexDirection="column">
        {visible.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines stable per render
          <Text key={i} color={line.kind === "add" ? "green" : line.kind === "remove" ? "red" : undefined}>
            {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
            {line.text || " "}
          </Text>
        ))}
        {lines.length > maxLines ? (
          <Box marginTop={1}>
            <Text dimColor>… {lines.length - maxLines} more line(s)</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
