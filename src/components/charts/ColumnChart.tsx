"use client";

import { useState } from "react";
import { formatINR } from "@/lib/format";

// Server pages render this client component, so formatting is chosen by name (props must be serializable).
const FORMATS = {
  number: (v: number) => new Intl.NumberFormat("en-IN").format(v),
  inr: (v: number) => formatINR(v.toFixed(0)),
} as const;

export interface Column {
  key: string;
  label: string; // axis label (short)
  title: string; // tooltip title (full)
  value: number;
}

/**
 * Single-series vertical bars over time or categories.
 * - Zero baseline, one recessive gridline at the max, sparse x labels.
 * - Hover / keyboard focus shows a tooltip; the table view carries every value.
 */
export function ColumnChart({
  data,
  valueFormat = "number",
  height = 160,
  ariaLabel,
  maxXLabels = 8,
}: {
  data: Column[];
  valueFormat?: keyof typeof FORMATS;
  height?: number;
  ariaLabel: string;
  maxXLabels?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const format = FORMATS[valueFormat];
  const max = Math.max(0, ...data.map((d) => d.value));
  const every = Math.max(1, Math.ceil(data.length / maxXLabels));
  const hovered = active !== null ? data[active] : null;

  if (data.length === 0 || max === 0) {
    return <p className="py-6 text-sm text-muted">No data for this period.</p>;
  }

  return (
    <figure className="flex flex-col gap-2">
      <div className="relative" style={{ height: height + 24 }}>
        <div className="absolute inset-x-0 top-0 flex justify-between border-t border-dashed border-grid text-[11px] text-muted">
          <span className="-translate-y-full bg-surface pr-1">{format(max)}</span>
        </div>
        <div
          role="img"
          aria-label={ariaLabel}
          className="absolute inset-x-0 top-0 flex items-end gap-[2px] border-b border-line"
          style={{ height }}
          onMouseLeave={() => setActive(null)}
        >
          {data.map((d, i) => (
            <button
              key={d.key}
              type="button"
              aria-label={`${d.title}: ${format(d.value)}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="group relative flex h-full min-w-0 flex-1 items-end justify-center focus:outline-none"
            >
              <span
                className={`mx-auto block w-full max-w-10 rounded-t-[4px] ${active === i ? "bg-series-1" : "bg-series-1/85"} group-focus-visible:ring-2 group-focus-visible:ring-ink`}
                style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value > 0 ? 2 : 0 }}
              />
            </button>
          ))}
        </div>
        <div className="absolute inset-x-0 flex gap-[2px] text-[11px] text-muted" style={{ top: height + 4 }}>
          {data.map((d, i) => (
            <span key={d.key} className="min-w-0 flex-1 truncate text-center">
              {i % every === 0 ? d.label : ""}
            </span>
          ))}
        </div>
        {hovered && active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: `${((active + 0.5) / data.length) * 100}%`, top: 0 }}
          >
            <p className="whitespace-nowrap text-muted">{hovered.title}</p>
            <p className="whitespace-nowrap font-bold tabular-nums text-ink">{format(hovered.value)}</p>
          </div>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-semibold text-muted">Show as table</summary>
        <table className="mt-2 w-full">
          <tbody className="divide-y divide-line">
            {data.map((d) => (
              <tr key={d.key}>
                <td className="py-1">{d.title}</td>
                <td className="py-1 text-right tabular-nums">{format(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
