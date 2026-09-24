export type StockStatus = "critical" | "low" | "ok" | "unknown";

const STYLE: Record<StockStatus, { cls: string; icon: string; label: string }> = {
  critical: { cls: "bg-danger/10 text-danger", icon: "●", label: "Critical" },
  low: { cls: "bg-warn/10 text-warn", icon: "▲", label: "Low" },
  ok: { cls: "bg-ok/10 text-ok", icon: "✓", label: "OK" },
  unknown: { cls: "bg-bg text-muted", icon: "?", label: "No data" },
};

/** Status is always icon + word, never colour alone. */
export function StatusPill({ status }: { status: StockStatus }) {
  const s = STYLE[status] ?? STYLE.unknown;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}
