import { Box, Text } from "ink";
import type { AppState, RowId } from "./state.js";
import type { DraftConfig, SlotChoice } from "./types.js";

function shortSlot(s: SlotChoice, builtinLabel: string): string {
  if (s === "builtin") return builtinLabel;
  if (s === "disabled") return "disabled";
  return s.customUri;
}

interface Props {
  state: AppState;
}

interface RowDescriptor {
  id: RowId;
  label: string;
  value: (d: DraftConfig) => string;
}

const ROW_DESCRIPTORS: RowDescriptor[] = [
  {
    id: "provider",
    label: "Provider",
    value: (d) => `${d.provider.kind} · ${d.provider.defaultModel || "(no model)"}`,
  },
  { id: "ui", label: "UI", value: (d) => shortSlot(d.ui, "bundled") },
  { id: "memory", label: "Memory", value: (d) => shortSlot(d.memory, "built-in (SQLite)") },
  {
    id: "tools",
    label: "Tools",
    value: (d) => {
      const on = Object.entries(d.tools)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return on.length === 0 ? "(none)" : on.join(", ");
    },
  },
  {
    id: "channels",
    label: "Channels",
    value: (d) => {
      const builtin = d.channels.discord ? ["discord"] : [];
      const customs = d.plugins.length > 0 ? `, ${d.plugins.length} custom` : "";
      return builtin.length === 0 && d.plugins.length === 0 ? "(none)" : `${builtin.join(", ") || "(none)"}${customs}`;
    },
  },
  { id: "task", label: "Task backend", value: (d) => shortSlot(d.taskBackend, "built-in (SQLite)") },
  {
    id: "agents",
    label: "Agents",
    value: (d) => (d.externalAgents.length === 0 ? "(none external)" : `${d.externalAgents.length} external`),
  },
  {
    id: "systemPrompt",
    label: "System prompt",
    value: (d) => (d.systemPromptBaseFile ? `baseFile: ${d.systemPromptBaseFile}` : "built-in default"),
  },
  {
    id: "plugins",
    label: "Plugins",
    value: (d) => (d.plugins.length === 0 ? "(none)" : `${d.plugins.length} configured`),
  },
];

export function MenuPane({ state }: Props) {
  const filter = state.search.toLowerCase();
  const rows = filter
    ? ROW_DESCRIPTORS.filter((r) => r.label.toLowerCase().includes(filter) || r.value(state.draft).toLowerCase().includes(filter))
    : ROW_DESCRIPTORS;

  return (
    <Box flexDirection="column" width="40%" paddingX={1} borderStyle="single" borderColor="gray">
      <Text bold>Settings</Text>
      {state.search ? (
        <Text dimColor>filter: {state.search}</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {rows.length === 0 ? <Text dimColor>(no matches)</Text> : null}
        {rows.map((row) => {
          const isSelected = row.id === state.selected;
          return (
            <Box key={row.id}>
              <Text color={isSelected ? "cyan" : undefined}>
                {isSelected ? "▶ " : "  "}
                {row.label}
                {": "}
                <Text dimColor>{row.value(state.draft)}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
