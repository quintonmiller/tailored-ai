import { Box, Text } from "ink";

interface Props {
  text: string;
  /** When tall, the pane scrolls to show this line index at the bottom. */
  maxLines?: number;
}

export function YamlPane({ text, maxLines = 30 }: Props) {
  const lines = text.split("\n");
  const visible = lines.slice(Math.max(0, lines.length - maxLines));
  return (
    <Box flexDirection="column">
      <Text bold>YAML preview</Text>
      <Box marginTop={1} flexDirection="column">
        {visible.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: yaml lines are stable per render
          <Text key={i} dimColor={line.trimStart().startsWith("#")}>
            {line || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
