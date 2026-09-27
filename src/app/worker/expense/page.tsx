import Link from "next/link";
import { ExpenseEntry } from "@/components/stock/ExpenseEntry";
import { requireRole } from "@/lib/auth";

export const metadata = { title: "Record expense" };

export default async function ExpensePage() {
  await requireRole("worker");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Record expense</h1>
        <Link href="/worker/more" className="text-sm font-semibold text-brand">
          Back
        </Link>
      </div>
      <p className="text-sm text-muted">Money paid at this cart for something that is not stock — ice, gas, a repair. The owner sees it straight away.</p>
      <ExpenseEntry />
    </div>
  );
}
