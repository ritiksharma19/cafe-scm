import { ActionForm } from "@/components/ActionForm";
import { IncomingTransfer } from "@/components/stock/IncomingTransfer";
import { TransferForm } from "@/components/stock/TransferForm";
import { loadCatalog } from "@/lib/catalog";
import { formatDateTime } from "@/lib/format";
import { formatQuantity } from "@/lib/quantity";
import { loadTransfers } from "@/lib/transfers";
import { cancelTransfer } from "../stock-actions";

export const metadata = { title: "Transfers" };

export default async function TransfersPage() {
  const [catalog, inTransit, recent] = await Promise.all([
    loadCatalog(),
    loadTransfers({ status: "in_transit", limit: 100 }),
    loadTransfers({ limit: 60 }),
  ]);
  const history = recent.filter((t) => t.status !== "in_transit");

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Transfers</h1>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h2 className="font-bold">New transfer</h2>
          <TransferForm catalog={catalog} />
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="font-bold">In transit ({inTransit.length})</h2>
          {inTransit.length === 0 && <p className="card p-4 text-muted">Nothing on the way.</p>}
          {inTransit.map((t) => (
            <div key={t.id} className="flex flex-col gap-2">
              <p className="text-sm font-semibold">
                {t.from_name} → {t.to_name}
              </p>
              <IncomingTransfer transfer={t} />
              <ActionForm
                action={cancelTransfer}
                id={t.id}
                label="Cancel & return stock"
                tone="danger"
                reason={{ placeholder: "Reason for cancelling", required: true }}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-bold">Recent</h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase text-muted">
                <th className="p-3 font-semibold">Sent</th>
                <th className="p-3 font-semibold">Route</th>
                <th className="p-3 font-semibold">Items</th>
                <th className="p-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {history.map((t) => {
                const short = t.items.filter((i) => i.qty_received !== null && Number(i.qty_received) < Number(i.qty_sent));
                return (
                  <tr key={t.id}>
                    <td className="p-3 whitespace-nowrap">{formatDateTime(t.dispatched_at)}</td>
                    <td className="p-3 whitespace-nowrap">
                      {t.from_name} → {t.to_name}
                    </td>
                    <td className="p-3">
                      {t.items.map((i) => `${i.name} ${formatQuantity(i.qty_sent, i.unit)}`).join(", ")}
                      {short.length > 0 && (
                        <p className="mt-1 font-semibold text-danger">
                          Short:{" "}
                          {short
                            .map((i) => `${i.name} ${formatQuantity(Number(i.qty_sent) - Number(i.qty_received), i.unit)}`)
                            .join(", ")}
                        </p>
                      )}
                    </td>
                    <td className="p-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                          t.status === "received" ? "bg-ok/10 text-ok" : "bg-bg text-muted"
                        }`}
                      >
                        {t.status === "received" ? "RECEIVED" : "CANCELLED"}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {history.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-4 text-muted">
                    No completed transfers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
