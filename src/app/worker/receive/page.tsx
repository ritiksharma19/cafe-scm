import { ReceiptForm } from "@/components/stock/ReceiptForm";
import { loadCatalog } from "@/lib/catalog";

export const metadata = { title: "Receive stock" };

export default async function ReceivePage() {
  const catalog = await loadCatalog();
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-xl font-bold">Receive stock</h1>
      <p className="text-sm text-muted">Record items bought from a shop or supplier and brought to this cart.</p>
      <ReceiptForm catalog={catalog} />
    </div>
  );
}
