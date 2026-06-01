import { Box, Text } from "ink";

interface Binding {
  keys: string;
  description: string;
}

const MENU_KEYS: Binding[] = [
  { keys: "↑↓ / j k", description: "navigate rows" },
  { keys: "enter", description: "edit selected row" },
  { keys: "tab", description: "cycle right pane (Details / YAML / Diff)" },
  { keys: "/", description: "filter rows" },
  { keys: "s", description: "save and exit" },
  { keys: "u", description: "undo last change" },
  { keys: "?", description: "toggle this help" },
  { keys: "q / esc", description: "cancel and exit" },
];

const EDITOR_KEYS: Binding[] = [
  { keys: "↑↓ / j k", description: "move between fields" },
  { keys: "enter", description: "edit field or commit" },
  { keys: "space", description: "toggle (Tools / Channels)" },
  { keys: "d", description: "delete item (Plugins / Channels)" },
  { keys: "esc", description: "return to menu" },
];

export function HelpOverlay() {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold>Keybindings</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold dimColor>
          Menu
        </Text>
        {MENU_KEYS.map((b) => (
          <Box key={b.keys}>
            <Box width={15}>
              <Text color="cyan">{b.keys}</Text>
            </Box>
            <Text>{b.description}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold dimColor>
          Editors
        </Text>
        {EDITOR_KEYS.map((b) => (
          <Box key={b.keys}>
            <Box width={15}>
              <Text color="cyan">{b.keys}</Text>
            </Box>
            <Text>{b.description}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press ? again to dismiss.</Text>
      </Box>
    </Box>
  );
}
