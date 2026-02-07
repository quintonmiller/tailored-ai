import { shellEscape, runShellCommand } from './shell.js';
import type { AgentConfig, CommandConfig } from './config.js';

export interface ParsedCommand {
  name: string;
  input: string;
}

export type CommandResult =
  | { type: 'not_a_command' }
  | { type: 'new_session' }
  | { type: 'switch_profile'; profile: string }
  | { type: 'help'; text: string }
  | { type: 'shell_output'; output: string }
  | { type: 'agent_prompt'; prompt: string; profile?: string; newSession?: boolean }
  | { type: 'shell_then_prompt'; output: string; prompt: string; profile?: string; newSession?: boolean }
  | { type: 'error'; message: string }
  | { type: 'unknown_command'; name: string };

export interface CommandContext {
  config: AgentConfig;
  currentProfile?: string;
}

const BUILTIN_COMMANDS: Record<string, string> = {
  new: 'Start a new session',
  agent: 'Switch to a named profile (usage: /agent <name>)',
  help: 'List available commands',
};

export function isCommand(input: string): boolean {
  return input.startsWith('/');
}

export function parseCommand(input: string): ParsedCommand | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1);
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return { name: trimmed, input: '' };
  }
  return {
    name: trimmed.slice(0, spaceIdx),
    input: trimmed.slice(spaceIdx + 1).trim(),
  };
}

export async function executeCommand(
  input: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (!isCommand(input)) return { type: 'not_a_command' };

  const parsed = parseCommand(input);
  if (!parsed) return { type: 'not_a_command' };

  const { name, input: cmdInput } = parsed;

  // Built-in: /new
  if (name === 'new') {
    return { type: 'new_session' };
  }

  // Built-in: /agent <name>
  if (name === 'agent') {
    if (!cmdInput) {
      const profiles = Object.keys(ctx.config.profiles);
      if (!profiles.length) {
        return { type: 'error', message: 'No profiles configured. Add profiles in config.yaml.' };
      }
      const current = ctx.currentProfile ? ` (current: ${ctx.currentProfile})` : '';
      return {
        type: 'error',
        message: `Usage: /agent <name>${current}\nAvailable profiles: ${profiles.join(', ')}`,
      };
    }
    if (!ctx.config.profiles[cmdInput]) {
      const profiles = Object.keys(ctx.config.profiles);
      return {
        type: 'error',
        message: `Unknown profile "${cmdInput}". Available: ${profiles.join(', ') || '(none)'}`,
      };
    }
    return { type: 'switch_profile', profile: cmdInput };
  }

  // Built-in: /help
  if (name === 'help') {
    return { type: 'help', text: formatHelp(ctx) };
  }

  // Config-driven commands
  const cmdConfig = ctx.config.commands[name];
  if (!cmdConfig) {
    return { type: 'unknown_command', name };
  }

  return executeConfigCommand(name, cmdInput, cmdConfig);
}

async function executeConfigCommand(
  name: string,
  input: string,
  cmd: CommandConfig,
): Promise<CommandResult> {
  const hasShell = !!cmd.command;
  const hasPrompt = !!cmd.prompt;

  // Shell-only command
  if (hasShell && !hasPrompt) {
    const shellCmd = interpolateShell(cmd.command!, input);
    const result = await runShellCommand(shellCmd, cmd.timeout_ms);
    if (!result.success) {
      return { type: 'error', message: result.error ?? `Command "${name}" failed` };
    }
    return { type: 'shell_output', output: result.output };
  }

  // Prompt-only command
  if (hasPrompt && !hasShell) {
    const prompt = interpolatePrompt(cmd.prompt!, input);
    return {
      type: 'agent_prompt',
      prompt,
      profile: cmd.profile,
      newSession: cmd.new_session,
    };
  }

  // Shell + prompt combo
  if (hasShell && hasPrompt) {
    const shellCmd = interpolateShell(cmd.command!, input);
    const result = await runShellCommand(shellCmd, cmd.timeout_ms);
    if (!result.success) {
      return { type: 'error', message: result.error ?? `Command "${name}" failed` };
    }
    let prompt = interpolatePrompt(cmd.prompt!, input);
    prompt = prompt.replace(/\{\{output\}\}/g, result.output);
    return {
      type: 'shell_then_prompt',
      output: result.output,
      prompt,
      profile: cmd.profile,
      newSession: cmd.new_session,
    };
  }

  return { type: 'error', message: `Command "${name}" has no command or prompt defined.` };
}

/** Interpolate {{input}} in a shell command template — input is shell-escaped. */
function interpolateShell(template: string, input: string): string {
  return template.replace(/\{\{input\}\}/g, shellEscape(input));
}

/** Interpolate {{input}} in a prompt template — input is inserted raw. */
function interpolatePrompt(template: string, input: string): string {
  return template.replace(/\{\{input\}\}/g, input);
}

function formatHelp(ctx: CommandContext): string {
  const lines: string[] = ['Available commands:'];

  for (const [name, desc] of Object.entries(BUILTIN_COMMANDS)) {
    lines.push(`  /${name} — ${desc}`);
  }

  const custom = ctx.config.commands;
  if (Object.keys(custom).length > 0) {
    lines.push('');
    for (const [name, cmd] of Object.entries(custom)) {
      lines.push(`  /${name} — ${cmd.description}`);
    }
  }

  if (ctx.currentProfile) {
    lines.push(`\nCurrent profile: ${ctx.currentProfile}`);
  }

  return lines.join('\n');
}
