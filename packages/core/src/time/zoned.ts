/** Civil date/time fields as observed in an IANA timezone. */
export interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedParts(at: Date, timeZone: string): ZonedDateTimeParts {
  const fields = Object.fromEntries(
    partsFormatter(timeZone)
      .formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour,
    minute: fields.minute,
    second: fields.second,
  };
}

function civilMillis(parts: ZonedDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function sameCivilTime(a: ZonedDateTimeParts, b: ZonedDateTimeParts): boolean {
  return civilMillis(a) === civilMillis(b);
}

/**
 * Convert a civil wall-clock time in `timeZone` to an absolute instant.
 *
 * Offset iteration avoids mutating `process.env.TZ`, so several runtimes with
 * different configured zones can coexist. Nonexistent DST times are rejected
 * instead of being silently shifted by an hour. For an ambiguous fall-back
 * time, the earlier matching instant is selected.
 */
export function fromZonedParts(target: ZonedDateTimeParts, timeZone: string): Date {
  const calendarCheck = new Date(Date.UTC(target.year, target.month - 1, target.day));
  if (
    calendarCheck.getUTCFullYear() !== target.year ||
    calendarCheck.getUTCMonth() + 1 !== target.month ||
    calendarCheck.getUTCDate() !== target.day ||
    target.hour < 0 ||
    target.hour > 23 ||
    target.minute < 0 ||
    target.minute > 59 ||
    target.second < 0 ||
    target.second > 59
  ) {
    throw new Error("invalid calendar date or time");
  }

  const targetMillis = civilMillis(target);
  let guess = targetMillis;
  const matches: number[] = [];
  for (let i = 0; i < 6; i++) {
    const observed = zonedParts(new Date(guess), timeZone);
    const delta = targetMillis - civilMillis(observed);
    if (delta === 0) {
      matches.push(guess);
      break;
    }
    guess += delta;
  }

  // Check one hour either side too. Fall-back transitions produce two valid
  // instants for one wall time; choosing the earlier makes the policy stable.
  for (const candidate of [guess - 3_600_000, guess + 3_600_000]) {
    if (sameCivilTime(zonedParts(new Date(candidate), timeZone), target)) matches.push(candidate);
  }
  if (matches.length === 0) {
    throw new Error(`the local time does not exist in ${timeZone} (likely a daylight-saving transition)`);
  }
  return new Date(Math.min(...matches));
}

export function addCivilDays(parts: ZonedDateTimeParts, days: number): ZonedDateTimeParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    ...parts,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}
