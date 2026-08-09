/**
 * The one string the parent and the worker have to agree on.
 *
 * It lives alone in its own module for a boring but load-bearing reason: the
 * worker runs its scenario at import time, so importing the constant *from* the
 * worker made the parent process run a scenario of its own on startup.
 */
export const RESULT_MARKER = "__TAI_EVAL_RESULT__";
