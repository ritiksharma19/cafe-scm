/**
 * Ranked horizontal bars with the value printed on every row — the labels ARE the
 * table, so no hover is needed. One series colour; text stays in ink tokens.
 */
export function BarList({
  rows,
  format = (v) => String(v),
  secondary,
  emptyText = "No data for this period.",
  max,
}: {
  rows: { key: string; label: string; value: number }[];
  format?: (v: number) => string;
  secondary?: (key: string) => string | null;
  emptyText?: string;
  max?: number;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted">{emptyText}</p>;
  const top = max ?? Math.max(...rows.map((r) => r.value), 0);
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => {
        const pct = top > 0 ? Math.max(0, (r.value / top) * 100) : 0;
        const extra = secondary?.(r.key);
        return (
          <li key={r.key} className="grid grid-cols-[minmax(6rem,9rem)_1fr_8.5rem] items-center gap-3 text-sm">
            <span className="truncate font-medium" title={r.label}>
              {r.label}
            </span>
            <span className="h-3 rounded-r bg-grid/60" aria-hidden>
              <span className="block h-full rounded-r bg-series-1" style={{ width: `${pct}%`, minWidth: r.value > 0 ? 2 : 0 }} />
            </span>
            <span className="text-right tabular-nums">
              <b>{format(r.value)}</b>
              {extra && <span className="ml-2 text-xs text-muted">{extra}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
