"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Re-renders the current server page when any of the given tables changes
 * (Supabase Realtime; RLS decides which rows this user hears about).
 * Changes are debounced so a burst of ledger rows causes one refresh.
 */
export function LiveRefresh({ tables, debounceMs = 1500 }: { tables: string[]; debounceMs?: number }) {
  const router = useRouter();
  const [live, setLive] = useState(false);
  const key = tables.join(",");

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), debounceMs);
    };
    let channel = supabase.channel(`live:${key}:${Math.random().toString(36).slice(2)}`);
    for (const table of key.split(",")) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, refresh);
    }
    channel.subscribe((status) => setLive(status === "SUBSCRIBED"));
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [key, debounceMs, router]);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted" title="Updates automatically">
      <span aria-hidden className={`size-2 rounded-full ${live ? "bg-ok" : "bg-line"}`} />
      {live ? "Live" : "Connecting…"}
    </span>
  );
}
