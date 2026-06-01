import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { resolveOnePlugin } from "../resolve.js";
import type { Action } from "../state.js";
import type { ToolsDraft } from "../types.js";

interface Props {
  tools: ToolsDraft;
  dispatch: (action: Action) => void;
  onExit: () => void;
}

const TOOL_ORDER: (keyof ToolsDraft)[] = ["memory", "exec", "read", "write", "web_fetch", "web_search"];

const HINTS: Record<keyof ToolsDraft, string> = {
  memory: "tiered memory with recall + facts",
  exec: "run allowlisted shell commands",
  read: "read files in the workspace",
  write: "write files in the workspace",
  web_fetch: "fetch URLs",
  web_search: "needs an API key (Brave/Tavily)",
};

type Mode = "list" | "add" | "resolving";

export function ToolsEditor({ tools, dispatch, onExit }: Props) {
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [busy, setBusy] = useState<string | undefined>();

  const totalRows = TOOL_ORDER.length + 1;
  const addRow = TOOL_ORDER.length;

  useInput((input, key) => {
    if (key.escape) {
      if (mode !== "list") setMode("list");
      else onExit();
      return;
    }
    if (mode !== "list") return;
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(totalRows - 1, c + 1));
      return;
    }
    if (cursor < TOOL_ORDER.length) {
      if (input === " " || key.return) {
        dispatch({ type: "toggleTool", tool: TOOL_ORDER[cursor] });
      }
      return;
    }
    // add row
    if (key.return) {
      setMode("add");
    }
  });

  const handleSubmit = (uri: string) => {
    const trimmed = uri.trim();
    if (!trimmed) {
      setMode("list");
      return;
    }
    setMode("resolving");
    setBusy(`Resolving ${trimmed}…`);
    void resolveOnePlugin(trimmed).then((resolved) => {
      dispatch({ type: "addPlugin", plugin: resolved });
      setBusy(undefined);
      setMode("list");
    });
  };

  return (
    <Box flexDirection="column">
      <Text bold>Edit Tools</Text>
      <Box marginTop={1} flexDirection="column">
        {TOOL_ORDER.map((name, i) => {
          const on = tools[name];
          const isCursor = i === cursor;
          return (
            <Box key={name}>
              <Text color={isCursor ? "cyan" : undefined}>
                {isCursor ? "▶ " : "  "}[{on ? "x" : " "}] {name}
                {"  "}
                <Text dimColor>{HINTS[name]}</Text>
              </Text>
            </Box>
          );
        })}
        <Box marginTop={1}>
          <Text color={cursor === addRow ? "cyan" : undefined}>
            {cursor === addRow ? "▶ " : "  "}+ Add custom tool package
          </Text>
        </Box>
      </Box>

      {mode === "add" ? (
        <Box marginTop={1} flexDirection="column">
          <Text>Tool package URI:</Text>
          <TextInput placeholder="npm:@some-org/tai-tool-foo" onSubmit={handleSubmit} />
          <Text dimColor>esc to cancel</Text>
        </Box>
      ) : null}
      {mode === "resolving" ? (
        <Box marginTop={1}>
          <Text dimColor>{busy}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>space/enter toggle · ↑↓ navigate · esc back</Text>
      </Box>
    </Box>
  );
}
