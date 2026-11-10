// Step 2 of recall (retrieval.md §2, §3): what a query says about time.
//
// - A date or range ("last month", "in 2024", "March 2025") becomes a world-time filter [from, to),
//   as calendar dates in the owner's time zone.
// - A past marker ("used to", "before", "in 20…") brings superseded and historical versions in.
// - A query made only of time words ("last year") is time-only, and returns at most 5 items.
//
// chrono-node finds the dates. It does not parse a bare year or a year range, both of which the
// spec names as examples, so those two forms are matched first by YEAR_RANGE and YEAR
// (spec-issues #35).

import * as chrono from "chrono-node";
import { contentWords, norm } from "@memory-anywhere/contracts/normalize";
import { PAST_MARKERS } from "../policy/generated.ts";
import { lexicon } from "../policy/lexicon.ts";

const PAST = lexicon(PAST_MARKERS, "substring");
const YEAR_RANGE = /\b(?:between|from)\s+((?:19|20)\d{2})\s+(?:and|to|until)\s+((?:19|20)\d{2})\b/u;
const YEAR = /\b((?:19|20)\d{2})\b/u;
const RELATIVE_UNIT = /\b(week|month|year)\b/u;

/** A half-open range of calendar dates, `YYYY-MM-DD`. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface TimeReading {
  readonly range: DateRange | undefined;
  readonly includePast: boolean;
  readonly timeOnly: boolean;
}

/** The calendar date of an instant in a time zone (`Intl` rejects unknown zones). */
export function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
const nextMonth = (y: number, m: number): string => (m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`);

export function readTime(query: string, nowMs: number, timeZone: string): TimeReading {
  const q = norm(query);
  const includePast = PAST.matches(q);
  let range: DateRange | undefined;
  let matched = "";

  const years = YEAR_RANGE.exec(q);
  const year = years ? undefined : YEAR.exec(q);
  if (years?.[1] && years[2]) {
    const [a, b] = [Number(years[1]), Number(years[2])].sort((x, y) => x - y) as [number, number];
    range = { from: `${a}-01-01`, to: `${b + 1}-01-01` };
    matched = years[0];
  } else {
    const parsed = chrono.parse(query, { instant: new Date(nowMs), timezone: offsetMinutes(nowMs, timeZone) }, { forwardDate: false })[0];
    if (parsed) {
      range = rangeOf(parsed, timeZone);
      matched = parsed.text;
    } else if (year?.[1]) {
      range = { from: `${year[1]}-01-01`, to: `${Number(year[1]) + 1}-01-01` };
      matched = year[0];
    }
  }

  const rest = matched ? q.replace(norm(matched), " ") : q;
  const timeOnly = range !== undefined && contentWords(rest).length === 0;
  return { range, includePast, timeOnly };
}

/** A chrono result as a date range: an explicit end, or the unit the text names, or the most precise certain component. */
function rangeOf(r: chrono.ParsedResult, timeZone: string): DateRange {
  const start = localDate(r.start.date().getTime(), timeZone);
  if (r.end) return { from: start, to: addDays(localDate(r.end.date().getTime(), timeZone), 1) };
  const [y, m] = start.split("-").map(Number) as [number, number];
  const unit = [...r.tags()].includes("result/relativeDate") ? RELATIVE_UNIT.exec(r.text.toLowerCase())?.[1] : undefined;
  if (unit === "week") return { from: start, to: addDays(start, 7) };
  if (unit === "year" || (!r.start.isCertain("month") && !r.start.isCertain("day"))) return { from: `${y}-01-01`, to: `${y + 1}-01-01` };
  if (unit === "month" || !r.start.isCertain("day")) return { from: `${start.slice(0, 7)}-01`, to: nextMonth(y, m) };
  return { from: start, to: addDays(start, 1) };
}

/** The zone's UTC offset in minutes at an instant (chrono takes minutes, not IANA names). */
function offsetMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ms);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * World-time overlap (retrieval.md §3): the version's interval [valid_from, valid_to) overlaps
 * [from, to). Partial dates compare by the start of their period; a missing `valid_from` is open.
 */
export function overlaps(validFrom: string | null, validTo: string | null, r: DateRange): boolean {
  const start = (v: string): string => (v.length === 4 ? `${v}-01-01` : v.length === 7 ? `${v}-01` : v.slice(0, 10));
  const beginsBeforeEnd = validFrom === null || start(validFrom) < r.to;
  const endsAfterStart = validTo === null || start(validTo) > r.from;
  return beginsBeforeEnd && endsAfterStart;
}

/** `as_of` (retrieval.md §3): true at that date. */
export const trueAt = (validFrom: string | null, validTo: string | null, date: string): boolean =>
  overlaps(validFrom, validTo, { from: date, to: addDays(date, 1) });
