import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { resolveOnePlugin } from "../resolve.js";
import type { Action } from "../state.js";
import type { ResolvedPlugin } from "../types.js";

interface Props {
  channels: Record<string, boolean>;
  plugins: ResolvedPlugin[];
  homeDir: string;
  dispatch: (action: Action) => void;
  onExit: () => void;
}

type Mode = "list" | "add" | "resolving";

export function ChannelsEditor({ channels, plugins, homeDir, dispatch, onExit }: Props) {
  const [mode, setMode] = useState<Mode>("list");
  const [cursor, setCursor] = useState(0);
  const [resolveMsg, setResolveMsg] = useState<string | undefined>();

  // Stable, sorted channel ids — one toggle row each. `discord` is seeded into
  // the draft (default false) so it always appears even when absent from config.
  const channelIds = Object.keys(channels).sort();

  // Rows: one per channel id, each plugin, "Add" row.
  const totalRows = channelIds.length + plugins.length + 1;
  const addRow = totalRows - 1;
  // Plugin rows sit after the channel-toggle rows.
  const firstPluginRow = channelIds.length;

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
    if (input === " " && cursor < channelIds.length) {
      dispatch({ type: "toggleChannel", channelId: channelIds[cursor] });
      return;
    }
    if (input === "d" && cursor >= firstPluginRow && cursor < addRow) {
      dispatch({ type: "removePlugin", index: cursor - firstPluginRow });
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
    void resolveOnePlugin(trimmed, homeDir).then((resolved) => {
      dispatch({ type: "addPlugin", plugin: resolved });
      setResolveMsg(undefined);
      setMode("list");
    });
  };

  return (
    <Box flexDirection="column">
      <Text bold>Edit Channels</Text>
      <Box marginTop={1} flexDirection="column">
        {channelIds.map((id, i) => (
          <Text key={id} color={cursor === i ? "cyan" : undefined}>
            {cursor === i ? "▶ " : "  "}[{channels[id] ? "x" : " "}] {id}
            {id === "discord" ? <Text dimColor> (built-in)</Text> : null}
          </Text>
        ))}
        {plugins.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Custom channel packages:</Text>
            {plugins.map((pl, i) => {
              const idx = firstPluginRow + i;
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
