"use client";

import { useState } from "react";
import { formatINR } from "@/lib/format";
import type { Column } from "./ColumnChart";

const inr = (v: number) => `${v < 0 ? "−" : ""}${formatINR(Math.abs(v).toFixed(0))}`;

/**
 * Profit per period: bars above the zero line are profit, below are loss.
 * Polarity is carried by position and the tooltip/table wording, not colour alone.
 */
export function ProfitChart({ data, height = 180, ariaLabel, maxXLabels = 8 }: { data: Column[]; height?: number; ariaLabel: string; maxXLabels?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...data.map((d) => d.value));
  const min = Math.min(0, ...data.map((d) => d.value));
  const span = max - min;
  const every = Math.max(1, Math.ceil(data.length / maxXLabels));
  const hovered = active !== null ? data[active] : null;

  if (data.length === 0 || span === 0) {
    return <p className="py-6 text-sm text-muted">No data for this period.</p>;
  }
  const zeroTop = (max / span) * height; // px from the top to the zero line

  return (
    <figure className="flex flex-col gap-2">
      <div className="relative" style={{ height: height + 24 }}>
        {max > 0 && (
          <span className="absolute left-0 top-0 -translate-y-full bg-surface pr-1 text-[11px] text-muted">{inr(max)}</span>
        )}
        {min < 0 && (
          <span className="absolute bottom-6 left-0 translate-y-full bg-surface pr-1 text-[11px] text-muted">{inr(min)}</span>
        )}
        <div className="absolute inset-x-0 border-t border-line" style={{ top: zeroTop }} aria-hidden />
        <div role="img" aria-label={ariaLabel} className="absolute inset-x-0 top-0 flex gap-[2px]" style={{ height }} onMouseLeave={() => setActive(null)}>
          {data.map((d, i) => {
            const h = (Math.abs(d.value) / span) * height;
            const positive = d.value >= 0;
            return (
              <button
                key={d.key}
                type="button"
                aria-label={`${d.title}: ${positive ? "profit" : "loss"} ${inr(d.value)}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="group relative h-full min-w-0 flex-1 focus:outline-none"
              >
                <span
                  className={`absolute inset-x-0 mx-auto block w-full max-w-10 group-focus-visible:ring-2 group-focus-visible:ring-ink ${
                    positive ? "rounded-t-[4px] bg-series-1" : "rounded-b-[4px] bg-danger"
                  } ${active === i ? "" : "opacity-85"}`}
                  style={{ top: positive ? zeroTop - h : zeroTop, height: Math.max(h, d.value !== 0 ? 2 : 0) }}
                />
              </button>
            );
          })}
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
            <p className="whitespace-nowrap font-bold tabular-nums text-ink">
              {hovered.value >= 0 ? "Profit" : "Loss"} {inr(hovered.value)}
            </p>
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
                <td className={`py-1 text-right tabular-nums ${d.value < 0 ? "text-danger" : ""}`}>{inr(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
