import { istDayStart } from "@/lib/format";

export const RANGE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
] as const;

export type RangeKey = (typeof RANGE_PRESETS)[number]["key"] | "custom";

export interface DateRange {
  key: RangeKey;
  label: string;
  from: Date; // inclusive, 00:00 IST
  to: Date; // exclusive, 00:00 IST of the day after the last day
  fromDate: string; // YYYY-MM-DD (IST)
  toDate: string; // YYYY-MM-DD (IST), inclusive
  days: number;
}

const DAY = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const istDate = (d: Date) => new Date(d.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
const istMidnight = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);

/** Resolves ?range=today|yesterday|7d|30d or ?from=YYYY-MM-DD&to=YYYY-MM-DD (IST days). */
export function resolveRange(params: Record<string, string | string[] | undefined>, now: Date = new Date(), fallback: RangeKey = "today"): DateRange {
  const today = istDayStart(now);
  const tomorrow = new Date(today.getTime() + DAY);
  const make = (key: RangeKey, label: string, from: Date, to: Date): DateRange => ({
    key,
    label,
    from,
    to,
    fromDate: istDate(from),
    toDate: istDate(new Date(to.getTime() - DAY)),
    days: Math.round((to.getTime() - from.getTime()) / DAY),
  });

  const from = typeof params.from === "string" && DATE.test(params.from) ? params.from : null;
  const to = typeof params.to === "string" && DATE.test(params.to) ? params.to : null;
  if (from && to && from <= to) {
    return make("custom", `${from} – ${to}`, istMidnight(from), new Date(istMidnight(to).getTime() + DAY));
  }

  const key = (typeof params.range === "string" ? params.range : fallback) as RangeKey;
  switch (key) {
    case "yesterday":
      return make("yesterday", "Yesterday", new Date(today.getTime() - DAY), today);
    case "7d":
      return make("7d", "Last 7 days", new Date(today.getTime() - 6 * DAY), tomorrow);
    case "30d":
      return make("30d", "Last 30 days", new Date(today.getTime() - 29 * DAY), tomorrow);
    default:
      return make("today", "Today", today, tomorrow);
  }
}

/** Query string for a range, preserving other filters. */
export function rangeQuery(range: { key: RangeKey; fromDate?: string; toDate?: string }, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (range.key === "custom" && range.fromDate && range.toDate) {
    q.set("from", range.fromDate);
    q.set("to", range.toDate);
  } else {
    q.set("range", range.key);
  }
  return `?${q.toString()}`;
}
