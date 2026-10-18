/**
 * Working-memory key naming the rooms a turn was woken for, comma-separated.
 * Read by the `room` tool so `pass` with no argument can scope itself, and by
 * the agent loop so a context slot knows which rooms' records the turn sees.
 *
 * Its own module so the loop can read it without importing the watcher, which
 * imports the loop.
 */
export const WAKE_ROOMS_KEY = "room:wake-rooms";
