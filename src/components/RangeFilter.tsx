import Link from "next/link";
import { RANGE_PRESETS, rangeQuery, type DateRange } from "@/lib/range";

/**
 * One consistent filter row for admin screens: range presets, custom dates, and
 * optional location filter. Plain links/GET form — works without JavaScript.
 */
export function RangeFilter({
  path,
  range,
  locations,
  locationId,
}: {
  path: string;
  range: DateRange;
  locations?: { id: string; name: string }[];
  locationId?: string;
}) {
  const extra: Record<string, string> = locationId ? { location: locationId } : {};
  return (
    <div className="flex flex-col gap-3">
      <nav aria-label="Period" className="flex flex-wrap gap-1.5">
        {RANGE_PRESETS.map((p) => (
          <Link
            key={p.key}
            href={`${path}${rangeQuery({ key: p.key }, extra)}`}
            aria-current={range.key === p.key ? "true" : undefined}
            className={`inline-flex min-h-10 items-center rounded-full border px-3.5 text-sm font-semibold ${
              range.key === p.key ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface hover:bg-bg"
            }`}
          >
            {p.label}
          </Link>
        ))}
      </nav>
      <form action={path} className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">From</span>
          <input type="date" name="from" defaultValue={range.fromDate} className="field min-h-10 py-1 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">To</span>
          <input type="date" name="to" defaultValue={range.toDate} className="field min-h-10 py-1 text-sm" />
        </label>
        {locations && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Location</span>
            <select name="location" defaultValue={locationId ?? ""} className="field min-h-10 py-1 text-sm">
              <option value="">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className="btn btn-secondary min-h-10 text-sm">
          Apply
        </button>
      </form>
    </div>
  );
}
