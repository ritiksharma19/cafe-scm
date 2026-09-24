import Link from "next/link";
import { TransferForm } from "@/components/stock/TransferForm";
import { requireRole } from "@/lib/auth";
import { loadCatalog } from "@/lib/catalog";

export const metadata = { title: "Send stock" };

export default async function SendPage() {
  const { location } = await requireRole("worker");
  const catalog = await loadCatalog();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Send stock</h1>
        <Link href="/worker/more" className="text-sm font-semibold text-brand">
          Back
        </Link>
      </div>
      <p className="text-sm text-muted">
        Stock leaves this cart now and is added to the other location when they tap “Received”.
      </p>
      <TransferForm catalog={catalog} fixedFromId={location?.id ?? ""} />
    </div>
  );
}
