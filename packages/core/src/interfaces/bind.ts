/**
 * A card bound to a world-state record shows the record: its title field as
 * the title, every other field as a line. Rebuilt from the record whenever a
 * surface redraws it, so the card says what is true now, not what was true
 * when it was sent.
 */
import type { StateCaller, StateService } from "../state/service.js";
import type { FieldCondition, StateRecord } from "../state/types.js";
import { MAX_LIST_ITEMS } from "./kinds.js";

/** A card holds at most this many fields; the rest of the record is left off the card. */
const MAX_CARD_FIELDS = 20;

export function boundCardProps(
  props: Record<string, unknown>,
  record: StateRecord,
  titleField: string | undefined,
): Record<string, unknown> {
  // The record names itself when its type has a title field, so the title
  // stays right after a rename; the agent's title is for types without one.
  const named = titleField ? record.data[titleField] : undefined;
  const title =
    typeof named === "string" && named.trim()
      ? named
      : typeof props.title === "string" && props.title.trim()
        ? props.title
        : `${record.type} ${record.id}`;
  const fields = Object.entries(record.data)
    .filter(([key]) => key !== titleField)
    .slice(0, MAX_CARD_FIELDS)
    .map(([key, value]) => ({ label: key, value: typeof value === "string" ? value : JSON.stringify(value) }));
  // The agent's other props pass through, so the kind's schema still catches
  // a typo instead of it vanishing; its fields give way to the record's.
  const { fields: _given, ...rest } = props;
  return { ...rest, title, ...(fields.length ? { fields } : {}) };
}

/** Records a list shows when its agent names no `limit`. Small: every one is a button on Discord. */
const DEFAULT_LIST_LIMIT = 10;
/** Most records read to find a list's matches among a set of scopes. */
const SCOPED_READ_LIMIT = 500;

export interface ListQuery {
  type: string;
  where?: Record<string, unknown>;
  limit?: number;
  /** When set, only records in these scopes: what the agent could see when it sent the list. */
  scopes?: string[];
}

/**
 * A list's props from its query: one item per matching record, labelled by
 * the type's title field, ticked when the `check` field holds its `on`
 * value. Records past the limit are counted in `more`.
 */
export async function listProps(
  state: StateService,
  caller: StateCaller,
  props: Record<string, unknown>,
  query: ListQuery,
): Promise<Record<string, unknown>> {
  const { limit, visible, titleField } = await readQuery(state, caller, query);
  const check = checkOf(props);
  const items = visible.slice(0, limit).map((r) => {
    const named = titleField ? r.data[titleField] : undefined;
    return {
      id: r.id,
      label: typeof named === "string" && named.trim() ? named : r.id,
      ...(check ? { checked: r.data[check.field] === check.on } : {}),
    };
  });
  const { items: _given, more: _counted, ...rest } = props;
  return {
    ...rest,
    title: typeof props.title === "string" && props.title.trim() ? props.title : query.type,
    items,
    ...(visible.length > limit ? { more: visible.length - limit } : {}),
  };
}

/** Most columns a table shows when the agent names none. */
const DEFAULT_TABLE_COLUMNS = 6;

/**
 * A table's props from its query: one row per matching record, one cell per
 * column. The columns are the agent's, or else the title field followed by
 * the other fields the records hold, in the order they first appear.
 */
export async function tableProps(
  state: StateService,
  caller: StateCaller,
  props: Record<string, unknown>,
  query: ListQuery,
): Promise<Record<string, unknown>> {
  const { limit, visible, titleField } = await readQuery(state, caller, query);
  const shown = visible.slice(0, limit);
  const given = Array.isArray(props.columns) ? props.columns.filter((c): c is string => typeof c === "string") : [];
  const columns = given.length ? given : discoverColumns(shown, titleField);
  const rows = shown.map((r) => ({ id: r.id, cells: columns.map((c) => cellText(r.data[c])) }));
  const { rows: _given, more: _counted, ...rest } = props;
  return {
    ...rest,
    title: typeof props.title === "string" && props.title.trim() ? props.title : query.type,
    columns,
    rows,
    ...(visible.length > limit ? { more: visible.length - limit } : {}),
  };
}

/** A query-bound component's props, read fresh: a list's items or a table's rows. */
export function queriedProps(
  state: StateService,
  caller: StateCaller,
  kind: string,
  props: Record<string, unknown>,
  query: ListQuery,
): Promise<Record<string, unknown>> {
  return kind === "table" ? tableProps(state, caller, props, query) : listProps(state, caller, props, query);
}

/**
 * The records a query-bound component shows: matching, among its scopes,
 * oldest first so an edit never moves a row (the default order, most
 * recently updated first, would send each ticked item to the top).
 */
async function readQuery(state: StateService, caller: StateCaller, query: ListQuery) {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIST_LIMIT)), MAX_LIST_ITEMS);
  const scopes = query.scopes ? new Set(query.scopes) : undefined;
  const found = await state.query(caller, {
    type: query.type,
    ...(query.where ? { where: query.where as Record<string, FieldCondition> } : {}),
    orderBy: { field: "createdAt", direction: "asc" },
    limit: scopes ? SCOPED_READ_LIMIT : limit + 1,
  });
  const visible = scopes ? found.filter((r) => scopes.has(r.scope)) : found;
  return { limit, visible, titleField: state.getType(query.type)?.title };
}

function discoverColumns(records: StateRecord[], titleField: string | undefined): string[] {
  const seen: string[] = titleField ? [titleField] : [];
  for (const r of records) for (const key of Object.keys(r.data)) if (!seen.includes(key)) seen.push(key);
  return seen.slice(0, DEFAULT_TABLE_COLUMNS);
}

function cellText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A list's `check`, with its defaults: a boolean field, ticked when true. */
export function checkOf(props: Record<string, unknown>): { field: string; on: unknown; off: unknown } | undefined {
  const check = props.check as { field?: unknown; on?: unknown; off?: unknown } | undefined;
  if (!check || typeof check.field !== "string" || !check.field) return undefined;
  return { field: check.field, on: check.on ?? true, off: check.off ?? false };
}
