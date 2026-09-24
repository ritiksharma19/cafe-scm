import Link from "next/link";
import { RequestForm } from "@/components/stock/RequestForm";
import { loadCatalog } from "@/lib/catalog";
import { formatDateTime } from "@/lib/format";
import { formatQuantity } from "@/lib/quantity";
import { loadRequests, REQUEST_STATUS_LABEL, REQUEST_STATUS_STYLE } from "@/lib/requests";
import { CancelRequestButton } from "./CancelRequestButton";

export const metadata = { title: "Stock requests" };

export default async function RequestsPage() {
  const [catalog, requests] = await Promise.all([loadCatalog(), loadRequests({ limit: 20 })]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Request stock</h1>
        <Link href="/worker/more" className="text-sm font-semibold text-brand">
          Back
        </Link>
      </div>
      <RequestForm catalog={catalog} />

      <h2 className="mt-2 text-lg font-bold">My requests</h2>
      {requests.length === 0 && <p className="card p-4 text-muted">No requests yet.</p>}
      <ul className="flex flex-col gap-2">
        {requests.map((r) => (
          <li key={r.id} className="card flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted">{formatDateTime(r.created_at)}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${REQUEST_STATUS_STYLE[r.status]}`}>
                {REQUEST_STATUS_LABEL[r.status]}
              </span>
            </div>
            <p className="font-medium">{r.items.map((i) => `${i.name} ${formatQuantity(i.quantity, i.unit)}`).join(", ")}</p>
            {r.resolution_note && <p className="text-sm text-muted">Owner: {r.resolution_note}</p>}
            {r.status === "pending" && <CancelRequestButton requestId={r.id} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
