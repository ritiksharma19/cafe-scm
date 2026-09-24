import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCatalog } from "@/lib/catalog";
import { formatDateTime } from "@/lib/format";
import { formatQuantity } from "@/lib/quantity";
import { createClient } from "@/lib/supabase/server";
import { RecipeEditor, type RecipeLine } from "./RecipeEditor";

export const metadata = { title: "Recipe" };

interface Version {
  id: string;
  version: number;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  recipe_items: (RecipeLine & { material: { name: string; base_unit: string } | null })[];
}

export default async function ProductRecipePage({ params }: PageProps<"/admin/products/[id]">) {
  const { id } = await params;
  const supabase = await createClient();
  const [{ data: product }, { data: versions }, catalog] = await Promise.all([
    supabase.from("products").select("id, name").eq("id", id).maybeSingle<{ id: string; name: string }>(),
    supabase
      .from("product_recipes")
      .select("id, version, effective_from, effective_to, notes, recipe_items(material_id, quantity, entered_qty, entered_unit, material:raw_materials(name, base_unit))")
      .eq("product_id", id)
      .order("version", { ascending: false })
      .returns<Version[]>(),
    loadCatalog(),
  ]);
  if (!product) notFound();
  const current = (versions ?? []).find((v) => v.effective_to === null);
  const unitOf = (code: string) => catalog.units.find((u) => u.code === code) ?? { code, factor_to_base: 1 };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/products" className="text-sm font-semibold text-brand">
          ← Products
        </Link>
        <h1 className="text-2xl font-bold">{product.name} — recipe</h1>
        <p className="text-sm text-muted">{current ? `Current: version ${current.version}` : "No recipe yet — this product cannot be sold until it has one."}</p>
      </div>

      <section className="card p-5">
        <RecipeEditor
          key={current?.id ?? "new"}
          productId={product.id}
          catalog={catalog}
          current={(current?.recipe_items ?? []).map(({ material_id, quantity, entered_qty, entered_unit }) => ({
            material_id,
            quantity,
            entered_qty,
            entered_unit,
          }))}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-bold">Version history</h2>
        {(versions ?? []).map((v) => (
          <article key={v.id} className="card p-4 text-sm">
            <p className="font-bold">
              Version {v.version}
              {v.effective_to === null && <span className="ml-2 rounded-full bg-ok/10 px-2 py-0.5 text-xs text-ok">CURRENT</span>}
            </p>
            <p className="text-xs text-muted">
              From {formatDateTime(v.effective_from)}
              {v.effective_to && ` to ${formatDateTime(v.effective_to)}`}
              {v.notes && ` · ${v.notes}`}
            </p>
            <p className="mt-2">
              {v.recipe_items
                .map((i) => `${i.material?.name ?? "?"} ${formatQuantity(i.quantity, unitOf(i.material?.base_unit ?? "pcs"))}`)
                .join(" · ")}
            </p>
          </article>
        ))}
      </section>
    </div>
  );
}
