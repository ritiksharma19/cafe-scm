import { WastageForm } from "@/components/stock/WastageForm";
import { loadCatalog } from "@/lib/catalog";

export const metadata = { title: "Wastage" };

export default async function WastePage() {
  const catalog = await loadCatalog();
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-xl font-bold">Record wastage</h1>
      <WastageForm catalog={catalog} />
    </div>
  );
}
