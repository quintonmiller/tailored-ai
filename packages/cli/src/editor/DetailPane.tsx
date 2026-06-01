import { Box, Text } from "ink";
import type { AppState } from "./state.js";
import type { DraftConfig, SlotChoice } from "./types.js";

function describeSlot(s: SlotChoice): string {
  if (s === "builtin") return "built-in";
  if (s === "disabled") return "disabled";
  return s.customUri;
}

interface Props {
  state: AppState;
}

export function DetailPane({ state }: Props) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} borderStyle="single" borderColor="gray">
      <Text bold>Detail</Text>
      <Box marginTop={1} flexDirection="column">
        {renderDetail(state.selected, state.draft)}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press enter to edit.</Text>
      </Box>
    </Box>
  );
}

function renderDetail(selected: string, d: DraftConfig) {
  switch (selected) {
    case "provider":
      return (
        <>
          <Text>Kind: {d.provider.kind}</Text>
          <Text>Model: {d.provider.defaultModel || "(none)"}</Text>
          {d.provider.baseUrl ? <Text>Base URL: {d.provider.baseUrl}</Text> : null}
          {d.provider.apiKey ? <Text>API key: ••• set</Text> : <Text dimColor>API key: not set</Text>}
        </>
      );
    case "ui":
      return (
        <>
          <Text>Bundled web UI served from the CLI.</Text>
          <Text dimColor>Current: {describeSlot(d.ui)}</Text>
        </>
      );
    case "memory":
      return (
        <>
          <Text>Tiered SQLite memory (recall + facts + embeddings).</Text>
          <Text dimColor>Current: {describeSlot(d.memory)}</Text>
        </>
      );
    case "tools":
      return (
        <Box flexDirection="column">
          {Object.entries(d.tools).map(([name, on]) => (
            <Text key={name} color={on ? "green" : "gray"}>
              {on ? "✔" : "✗"} {name}
            </Text>
          ))}
        </Box>
      );
    case "channels":
      return (
        <Box flexDirection="column">
          <Text color={d.channels.discord ? "green" : "gray"}>
            {d.channels.discord ? "✔" : "✗"} discord (built-in)
          </Text>
          {d.plugins.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text bold>Custom channel packages:</Text>
              {d.plugins.map((pl) => (
                <Text key={pl.uri} color={pl.resolveError ? "red" : undefined}>
                  · {pl.uri}
                  {pl.manifestId ? ` (${pl.manifestId}@${pl.version ?? "?"})` : ""}
                  {pl.resolveError ? ` — ${pl.resolveError}` : ""}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    case "task":
      return (
        <>
          <Text>Built-in SQLite task store.</Text>
          <Text dimColor>Current: {describeSlot(d.taskBackend)}</Text>
        </>
      );
    case "plugins":
      if (d.plugins.length === 0) return <Text dimColor>No plugins configured.</Text>;
      return (
        <Box flexDirection="column">
          {d.plugins.map((pl) => (
            <Text key={pl.uri} color={pl.resolveError ? "red" : undefined}>
              · {pl.uri}
              {pl.manifestId ? ` (${pl.manifestId}@${pl.version ?? "?"})` : ""}
              {pl.resolveError ? ` — ${pl.resolveError}` : ""}
            </Text>
          ))}
        </Box>
      );
    default:
      return <Text dimColor>(no detail)</Text>;
  }
}
