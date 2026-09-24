"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Material } from "@/lib/units";

const RECENT_KEY = "cafe-scm:recent-materials";

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 8)));
  } catch {
    // Storage unavailable (private mode): recents are a convenience only.
  }
}

/** Big tappable field that opens a full-screen, searchable list (recently used first). */
export function MaterialPicker({
  materials,
  value,
  onChange,
  disabled,
  label = "Raw material",
}: {
  materials: Material[];
  value: Material | null;
  onChange: (m: Material) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable on the client
    setRecent(readRecent());
    searchRef.current?.focus();
  }, [open]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = materials.filter((m) => !q || m.name.toLowerCase().includes(q));
    if (q) return matches;
    const rank = new Map(recent.map((id, i) => [id, i]));
    return [...matches].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99) || a.name.localeCompare(b.name));
  }, [materials, query, recent]);

  function choose(m: Material) {
    remember(m.id);
    onChange(m);
    setOpen(false);
    setQuery("");
  }

  return (
    <>
      <div>
        <span className="mb-1.5 block text-sm font-medium">{label}</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="field flex items-center justify-between text-left disabled:opacity-60"
        >
          <span className={value ? "font-semibold" : "text-muted"}>{value?.name ?? "Tap to choose…"}</span>
          <span aria-hidden className="text-muted">
            ›
          </span>
        </button>
      </div>

      {open && (
        <div role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-30 flex flex-col bg-bg">
          <div className="flex items-center gap-2 border-b border-line bg-surface px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search materials"
              className="field"
              autoComplete="off"
              enterKeyHint="search"
            />
            <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary shrink-0 px-4">
              Close
            </button>
          </div>
          <ul className="flex-1 divide-y divide-line overflow-y-auto bg-surface pb-[env(safe-area-inset-bottom)]">
            {list.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => choose(m)}
                  className={`flex min-h-14 w-full items-center justify-between px-4 text-left text-base ${
                    value?.id === m.id ? "bg-brand/10 font-bold text-brand" : "font-medium"
                  }`}
                >
                  {m.name}
                  <span className="text-sm text-muted">{m.display_unit}</span>
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="p-4 text-muted">No material matches “{query}”.</li>}
          </ul>
        </div>
      )}
    </>
  );
}
