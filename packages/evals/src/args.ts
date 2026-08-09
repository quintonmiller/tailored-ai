/**
 * Argument handling shared by the CLI entrypoint.
 *
 * Kept out of `cli.ts` because that module runs `main()` on import — anything
 * exported from it can only be tested by starting a benchmark.
 */

/**
 * Drop the `--` that a package-manager invocation forwards along with the args.
 *
 * Every documented way to run this CLI goes through pnpm — `pnpm run eval --
 * --home ~/.tailored-ai` — and pnpm passes the separator itself through to the
 * script. Node's `parseArgs` reads `--` as end-of-options, so every flag after
 * it lands in `positionals` and is silently ignored; `compare` reads `--` as the
 * path of the first report and fails on a file called `--`. Both failures land
 * a long way from their cause.
 *
 * Only the first separator goes. A second one is a real end-of-options marker
 * and belongs to whoever typed it.
 */
export function stripSeparator(argv: string[]): string[] {
  const at = argv.indexOf("--");
  return at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 1)];
}
