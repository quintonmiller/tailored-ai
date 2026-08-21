/**
 * Argument handling for the CLI entrypoint.
 *
 * A separate module because `cli.ts` runs `main()` on import — anything
 * exported from there can only be tested by starting a server.
 */

/**
 * Drop the `--` a package manager forwards along with the arguments.
 *
 * Every documented way to run this goes through pnpm — `pnpm run arcade -- list`
 * — and pnpm passes the separator through to the script. Without this, `--` is
 * argv[0], the command sniffer sees something starting with a dash, falls back
 * to `serve`, and `pnpm run arcade -- list` tries to bind port 4321. The failure
 * lands a long way from its cause: it reads as "the port is already in use", not
 * as "the subcommand was never parsed".
 *
 * Only the first separator goes. A second one is a real end-of-options marker
 * and belongs to whoever typed it.
 */
export function stripSeparator(argv: string[]): string[] {
  const at = argv.indexOf("--");
  return at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 1)];
}

/**
 * The subcommand, and everything after it.
 *
 * Defaults to `serve` so `pnpm run arcade` on its own does the obvious thing.
 * A leading flag is not a command — `arcade --port 5000` still serves.
 */
export function splitCommand(argv: string[]): { command: string; rest: string[] } {
  const args = stripSeparator(argv);
  const first = args[0];
  if (first && !first.startsWith("-")) return { command: first, rest: args.slice(1) };
  return { command: "serve", rest: args };
}
