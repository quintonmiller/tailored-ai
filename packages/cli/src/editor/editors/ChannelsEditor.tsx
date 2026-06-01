import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { resolveOnePlugin } from "../resolve.js";
import type { Action } from "../state.js";
import type { ResolvedPlugin } from "../types.js";

interface Props {
  discord: boolean;
  plugins: ResolvedPlugin[];
  dispatch: (action: Action) => void;
  onExit: () => void;
}

type Mode = "list" | "add" | "resolving";

export function ChannelsEditor({ discord, plugins, dispatch, onExit }: Props) {
  const [mode, setMode] = useState<Mode>("list");
  const [cursor, setCursor] = useState(0);
  const [resolveMsg, setResolveMsg] = useState<string | undefined>();

  // Rows: discord toggle, each plugin, "Add" row.
  const totalRows = 1 + plugins.length + 1;
  const addRow = totalRows - 1;

  useInput((input, key) => {
    if (mode !== "list") {
      // In add/resolving sub-modes, esc still drops back to the list.
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
    if (input === " " && cursor === 0) {
      dispatch({ type: "toggleDiscord" });
      return;
    }
    if (input === "d" && cursor > 0 && cursor <= plugins.length) {
      dispatch({ type: "removePlugin", index: cursor - 1 });
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
    void resolveOnePlugin(trimmed).then((resolved) => {
      dispatch({ type: "addPlugin", plugin: resolved });
      setResolveMsg(undefined);
      setMode("list");
    });
  };

  return (
    <Box flexDirection="column">
      <Text bold>Edit Channels</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={cursor === 0 ? "cyan" : undefined}>
          {cursor === 0 ? "▶ " : "  "}[{discord ? "x" : " "}] discord <Text dimColor>(built-in)</Text>
        </Text>
        {plugins.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Custom channel packages:</Text>
            {plugins.map((pl, i) => {
              const idx = i + 1;
              return (
                <Text key={pl.uri} color={idx === cursor ? "cyan" : pl.resolveError ? "red" : undefined}>
                  {idx === cursor ? "▶ " : "  "}
                  {pl.uri}
                  {pl.manifestId ? <Text dimColor> ({pl.manifestId}@{pl.version ?? "?"})</Text> : null}
                  {pl.resolveError ? <Text color="red"> — {pl.resolveError}</Text> : null}
                </Text>
              );
            })}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color={cursor === addRow ? "cyan" : undefined}>
            {cursor === addRow ? "▶ " : "  "}+ Add custom channel package
          </Text>
        </Box>
      </Box>

      {mode === "add" ? (
        <Box marginTop={1} flexDirection="column">
          <Text>Package URI:</Text>
          <TextInput placeholder="npm:@some-org/tai-slack-channel" onSubmit={handleSubmit} />
        </Box>
      ) : null}
      {resolveMsg ? (
        <Box marginTop={1}>
          <Text dimColor>{resolveMsg}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>space toggle · enter add · d delete · esc back</Text>
      </Box>
    </Box>
  );
}
