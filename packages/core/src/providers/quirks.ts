/**
 * Learning a model's request-shape constraints from its own refusals.
 *
 * Three providers arrived at the same pattern independently:
 *
 * | where | condition | what the API said |
 * |---|---|---|
 * | openai, chat completions | effort alongside function tools | `Function tools with reasoning_effort are not supported…` |
 * | openai, responses | which effort values a model takes | `'none' is not supported with the 'gpt-5-mini' model. Supported values are: …` |
 * | anthropic | temperature at all | `` `temperature` is deprecated for this model. `` |
 *
 * Each is a per-model constraint that no static rule predicts — vendors add
 * models faster than anyone updates a table, and the same vendor words the same
 * refusal differently between its own two endpoints. The only reliable way to
 * find out is to be told no, so the shape is: send, read the refusal, correct,
 * remember for the rest of the process.
 *
 * What generalises is the scaffolding — the ladder, the memo, the warning. What
 * does *not* is the recognition step: which 400s are recoverable and what the
 * corrected shape is. That is vendor knowledge and stays in the provider, which
 * is why {@link runQuirkLadder} takes `recover` as a callback rather than
 * trying to own a table of error patterns.
 */

/**
 * An HTTP failure carried with its parts intact.
 *
 * Recognition needs the status and the body. Without this the only thing
 * reaching `recover` is a message the provider composed itself, and deciding
 * "was that a 400?" by matching the string you formatted two lines earlier is
 * the same mistake as inferring control flow from a model's prose. The message
 * is unchanged from what these providers always threw, so anything asserting on
 * it — or merely catching `Error` — is unaffected.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, bodyText: string, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.bodyText = bodyText;
  }

  /** The body parsed as JSON, or undefined when it was not JSON. */
  json<T = unknown>(): T | undefined {
    try {
      return JSON.parse(this.bodyText) as T;
    } catch {
      return undefined;
    }
  }
}

/**
 * Per-model facts learned at runtime, created on first touch.
 *
 * Keyed by model id rather than provider instance because that is the grain the
 * constraint has: two models behind one provider can differ, and the same model
 * behaves the same however it was reached.
 */
export class QuirkMemo<Q extends object> {
  private facts = new Map<string, Q>();

  constructor(private readonly create: () => Q) {}

  /** The record for this model, creating an empty one if this is the first refusal. */
  for(model: string): Q {
    let found = this.facts.get(model);
    if (!found) {
      found = this.create();
      this.facts.set(model, found);
    }
    return found;
  }

  /** What has been learned, or undefined if this model has never refused anything. */
  peek(model: string): Q | undefined {
    return this.facts.get(model);
  }

  has(model: string): boolean {
    return this.facts.has(model);
  }

  forget(model: string): void {
    this.facts.delete(model);
  }
}

/**
 * Say something once per key, for the life of the process.
 *
 * Silently degrading a request the caller explicitly asked for is the failure
 * mode all three of these recoveries were written to avoid: `agent.temperature`
 * or `thinking: high` stops applying and nothing says so. But the correction
 * repeats on every call, so an unconditional warning would bury the log.
 */
export class WarnOnce {
  private said = new Set<string>();

  constructor(private readonly sink: (message: string) => void = (m) => console.warn(m)) {}

  say(key: string, message: string): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.sink(message);
  }

  /** Test seam; also lets a provider re-warn after deliberately forgetting a model. */
  reset(key?: string): void {
    if (key === undefined) this.said.clear();
    else this.said.delete(key);
  }
}

export interface QuirkLadderOptions<S, R> {
  /** The shape to try first, given whatever this model has already taught us. */
  initial: S;
  /**
   * Stable identity of a shape. Two shapes with the same key are the same
   * attempt, and the ladder refuses to make it twice.
   */
  key: (shape: S) => string;
  /** Send the request. Throw to signal failure. */
  attempt: (shape: S) => Promise<R>;
  /**
   * The corrected shape to try next, or `undefined` to rethrow untouched.
   *
   * Returning `undefined` is the important default. Retrying an unrelated
   * failure with a different body turns one clear error into two confusing
   * ones, so only recognised refusals should produce a next shape.
   */
  recover: (shape: S, error: Error) => S | undefined;
}

/**
 * Send, and correct the request shape for as long as the API keeps explaining
 * what is wrong with it.
 *
 * Termination is structural: a shape whose key has already been tried is never
 * tried again, so the loop is bounded by the number of distinct shapes rather
 * than by a retry counter or by trusting error messages not to loop. That
 * matters because the messages are the input — a vendor rewording one should
 * cost a missed recovery, never a hang.
 */
export async function runQuirkLadder<S, R>(opts: QuirkLadderOptions<S, R>): Promise<R> {
  let shape = opts.initial;
  const tried = new Set<string>();

  for (;;) {
    tried.add(opts.key(shape));
    try {
      return await opts.attempt(shape);
    } catch (err) {
      const error = err as Error;
      const next = opts.recover(shape, error);
      if (next === undefined || tried.has(opts.key(next))) throw error;
      shape = next;
    }
  }
}
