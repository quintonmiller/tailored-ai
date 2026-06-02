import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { resolveOnePlugin } from "../resolve.js";
import type { Action } from "../state.js";
import type { ResolvedPlugin } from "../types.js";

interface Props {
  agents: ResolvedPlugin[];
  homeDir: string;
  dispatch: (action: Action) => void;
  onExit: () => void;
}

type Mode = "list" | "add" | "resolving";

export function AgentsEditor({ agents, homeDir, dispatch, onExit }: Props) {
  const [mode, setMode] = useState<Mode>("list");
  const [cursor, setCursor] = useState(0);
  const [resolveMsg, setResolveMsg] = useState<string | undefined>();

  const totalRows = agents.length + 1;
  const addRow = agents.length;

  useInput((input, key) => {
    if (mode !== "list") {
      if (key.escape) setMode("list");
      return;
    }
    if (key.escape) {
      onExit();
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(totalRows - 1, c + 1));
      return;
    }
    if (input === "d" && cursor < agents.length) {
      dispatch({ type: "removeExternalAgent", index: cursor });
      setCursor((c) => Math.min(c, totalRows - 2));
      return;
    }
    if (key.return && cursor === addRow) {
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
    setResolveMsg(`Resolving ${trimmed}…`);
    // resolveOnePlugin works for any resource URI — it builds the same
    // ResourceLoader the runtime uses, so a successful resolve here means
    // the runtime will find the same manifest at startup.
    void resolveOnePlugin(trimmed, homeDir).then((resolved) => {
      dispatch({ type: "addExternalAgent", agent: resolved });
      setResolveMsg(undefined);
      setMode("list");
    });
  };

  return (
    <Box flexDirection="column">
      <Text bold>Edit External agents</Text>
      <Box marginTop={1}>
        <Text dimColor>Resource URIs pointing at `kind: agent` manifests. Loaded into the AgentRegistry at startup.</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {agents.length === 0 ? <Text dimColor>No external agents yet.</Text> : null}
        {agents.map((pl, i) => (
          <Text key={pl.uri} color={i === cursor ? "cyan" : pl.resolveError ? "red" : undefined}>
            {i === cursor ? "▶ " : "  "}
            {pl.uri}
            {pl.manifestId ? <Text dimColor> ({pl.manifestId}@{pl.version ?? "?"})</Text> : null}
            {pl.resolveError ? <Text color="red"> — {pl.resolveError}</Text> : null}
          </Text>
        ))}
        <Box marginTop={agents.length > 0 ? 1 : 0}>
          <Text color={cursor === addRow ? "cyan" : undefined}>
            {cursor === addRow ? "▶ " : "  "}+ Add external agent
          </Text>
        </Box>
      </Box>

      {mode === "add" ? (
        <Box marginTop={1} flexDirection="column">
          <Text>Agent URI:</Text>
          <TextInput placeholder="npm:@some-org/tai-agent-name" onSubmit={handleSubmit} />
        </Box>
      ) : null}
      {resolveMsg ? (
        <Box marginTop={1}>
          <Text dimColor>{resolveMsg}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>enter add · d delete · esc back</Text>
      </Box>
    </Box>
  );
}
