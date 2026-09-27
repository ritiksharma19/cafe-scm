"use client";

import { useActionState } from "react";
import { createProduct, createSize, updateProduct, type ProductResult } from "./actions";

export function ProductForm({
  id,
  price,
  sortOrder,
  active,
  category,
  categories,
  sizeLabel,
  showSizeLabel,
}: {
  id: string;
  price: string;
  sortOrder: number;
  active: boolean;
  category: string | null;
  categories: string[];
  sizeLabel: string | null;
  showSizeLabel: boolean;
}) {
  const [state, action, pending] = useActionState<ProductResult, FormData>(updateProduct, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="id" value={id} />
      <label className="block w-32">
        <span className="mb-1.5 block text-sm font-medium">Price (₹)</span>
        <input
          name="selling_price"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          defaultValue={Number(price)}
          className="field"
          required
        />
      </label>
      <label className="block w-40">
        <span className="mb-1.5 block text-sm font-medium">Menu section</span>
        <input name="category" defaultValue={category ?? ""} list="product-categories" className="field" placeholder="e.g. Burgers" maxLength={30} />
        <CategoryOptions categories={categories} />
      </label>
      {showSizeLabel ? (
        <label className="block w-28">
          <span className="mb-1.5 block text-sm font-medium">Size name</span>
          <input name="variant_label" defaultValue={sizeLabel ?? ""} className="field" placeholder="Regular" maxLength={20} />
        </label>
      ) : (
        <input type="hidden" name="variant_label" value={sizeLabel ?? ""} />
      )}
      <label className="block w-24">
        <span className="mb-1.5 block text-sm font-medium">Order</span>
        <input name="sort_order" type="number" inputMode="numeric" step="1" defaultValue={sortOrder} className="field" />
      </label>
      <label className="flex min-h-12 items-center gap-2">
        <input type="checkbox" name="is_active" defaultChecked={active} className="size-5 accent-brand" />
        <span className="text-sm font-medium">On sale</span>
      </label>
      <button type="submit" className="btn btn-secondary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
      {state.error && <p className="w-full text-sm font-medium text-danger">{state.error}</p>}
      {state.ok && <p className="w-full text-sm font-medium text-ok">Saved.</p>}
    </form>
  );
}

/** Suggestions for the menu-section field (sections become tabs on the worker's Sell screen). */
function CategoryOptions({ categories }: { categories: string[] }) {
  return (
    <datalist id="product-categories">
      {categories.map((c) => (
        <option key={c} value={c} />
      ))}
    </datalist>
  );
}

/** Creates a product, then opens its recipe editor (it cannot be sold until it has a recipe). */
export function NewProductForm({ categories }: { categories: string[] }) {
  const [state, action, pending] = useActionState<ProductResult, FormData>(createProduct, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="block min-w-48 flex-1">
        <span className="mb-1.5 block text-sm font-medium">Name</span>
        <input name="name" className="field" required />
      </label>
      <label className="block w-32">
        <span className="mb-1.5 block text-sm font-medium">Price (₹)</span>
        <input name="selling_price" type="number" inputMode="decimal" min="0" step="0.01" className="field" required />
      </label>
      <label className="block w-40">
        <span className="mb-1.5 block text-sm font-medium">Menu section</span>
        <input name="category" list="product-categories" className="field" placeholder="optional" maxLength={30} />
        <CategoryOptions categories={categories} />
      </label>
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Adding…" : "Add & set recipe"}
      </button>
      {state.error && <p className="w-full text-sm font-medium text-danger">{state.error}</p>}
    </form>
  );
}

/** Adds a size to a product (e.g. Large ₹150). Opens the new size's recipe afterwards. */
export function AddSizeForm({ baseId }: { baseId: string }) {
  const [state, action, pending] = useActionState<ProductResult, FormData>(createSize, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="base_id" value={baseId} />
      <label className="block w-32">
        <span className="mb-1.5 block text-sm font-medium">Size</span>
        <input name="label" className="field" placeholder="Large" maxLength={20} required />
      </label>
      <label className="block w-28">
        <span className="mb-1.5 block text-sm font-medium">Price (₹)</span>
        <input name="selling_price" type="number" inputMode="decimal" min="0" step="0.01" className="field" required />
      </label>
      <button type="submit" className="btn btn-secondary" disabled={pending}>
        {pending ? "Adding…" : "Add size"}
      </button>
      {state.error && <p className="w-full text-sm font-medium text-danger">{state.error}</p>}
    </form>
  );
}
