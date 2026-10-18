/**
 * A card bound to a world-state record shows the record: its title field as
 * the title, every other field as a line. Rebuilt from the record whenever a
 * surface redraws it, so the card says what is true now, not what was true
 * when it was sent.
 */
import type { StateRecord } from "../state/types.js";

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
