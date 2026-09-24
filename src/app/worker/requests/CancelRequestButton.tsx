"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function CancelRequestButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    const { error: e } = await createClient().rpc("update_stock_request", {
      p_request_id: requestId,
      p_status: "cancelled",
    });
    setBusy(false);
    if (e) return setError(e.message);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <button type="button" onClick={cancel} disabled={busy} className="text-sm font-semibold text-danger">
        {busy ? "Cancelling…" : "Cancel request"}
      </button>
      {error && <span className="text-sm text-danger">{error}</span>}
    </div>
  );
}
