// Menu grouping and order-line maths for the worker Sell screen (pure, unit-tested).

export interface MenuProduct {
  id: string;
  name: string;
  category: string | null;
  selling_price: string;
  variant_of: string | null;
  variant_label: string | null;
}

export interface MenuAddon {
  id: string;
  name: string;
  price: string;
  productIds: string[];
}

/** One tile: a product and its sizes. options[0] is the main product. */
export interface MenuGroup<P extends MenuProduct = MenuProduct> {
  key: string;
  name: string;
  category: string | null;
  options: P[];
}

export interface CartLine {
  key: string;
  productId: string;
  qty: number;
  addons: Record<string, number>; // addon id → quantity per product
}

/** Groups sizes under their main product. A size whose main product is not on sale stands alone. */
export function groupMenu<P extends MenuProduct>(products: P[]): MenuGroup<P>[] {
  const sellable = new Set(products.map((p) => p.id));
  const groups: MenuGroup<P>[] = [];
  const byBase = new Map<string, MenuGroup<P>>();
  for (const p of products) {
    if (p.variant_of && sellable.has(p.variant_of)) continue;
    const g: MenuGroup<P> = { key: p.id, name: p.name, category: p.category, options: [p] };
    groups.push(g);
    byBase.set(p.id, g);
  }
  for (const p of products) {
    if (p.variant_of && sellable.has(p.variant_of)) byBase.get(p.variant_of)!.options.push(p);
  }
  return groups;
}

/** Label of a size on the picker ("Regular" when the main product has no size name). */
export function sizeLabel(p: MenuProduct, group: MenuGroup): string {
  if (p.variant_label) return p.variant_label;
  return group.options.length > 1 ? "Regular" : p.name;
}

/** Add-ons offered with a product (a size also offers its main product's add-ons). */
export function addonsFor(product: MenuProduct, addons: MenuAddon[]): MenuAddon[] {
  return addons.filter((a) => a.productIds.includes(product.id) || (product.variant_of !== null && a.productIds.includes(product.variant_of)));
}

/** Same product + same add-ons = same line (mirrors record_sale's merging). */
export function lineKey(productId: string, addons: Record<string, number>): string {
  const parts = Object.entries(addons)
    .filter(([, q]) => q > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, q]) => `${id}x${q}`);
  return [productId, ...parts].join("|");
}

/** Price of ONE unit of a line (product + its add-ons), in rupees. */
export function unitPrice(line: Pick<CartLine, "productId" | "addons">, products: Map<string, MenuProduct>, addons: Map<string, MenuAddon>): number {
  const base = Number(products.get(line.productId)?.selling_price ?? 0);
  return Object.entries(line.addons).reduce((s, [id, q]) => s + Number(addons.get(id)?.price ?? 0) * q, base);
}

/** Adds (or merges) a line; returns a new array. */
export function addLine(lines: CartLine[], productId: string, addons: Record<string, number>, qty: number): CartLine[] {
  const clean = Object.fromEntries(Object.entries(addons).filter(([, q]) => q > 0));
  const key = lineKey(productId, clean);
  const existing = lines.find((l) => l.key === key);
  if (existing) return lines.map((l) => (l.key === key ? { ...l, qty: Math.min(999, l.qty + qty) } : l));
  return [...lines, { key, productId, qty, addons: clean }];
}

/** Changes a line's quantity; a line at zero disappears. */
export function changeLine(lines: CartLine[], key: string, delta: number): CartLine[] {
  return lines.map((l) => (l.key === key ? { ...l, qty: Math.min(999, l.qty + delta) } : l)).filter((l) => l.qty > 0);
}

/** record_sale's p_items. */
export function toSaleItems(lines: CartLine[]) {
  return lines.map((l) => ({
    product_id: l.productId,
    quantity: l.qty,
    addons: Object.entries(l.addons).map(([addon_id, quantity]) => ({ addon_id, quantity })),
  }));
}

/** "Burger + 2× Extra cheese × 3" for order lists (admin orders, worker activity, exports). */
export function describeLine(item: {
  quantity: number;
  product: { name: string } | null;
  order_item_addons?: { quantity: number; addon: { name: string } | null }[] | null;
}): string {
  const extras = (item.order_item_addons ?? []).map((a) => `${a.quantity > 1 ? `${a.quantity}× ` : ""}${a.addon?.name ?? "?"}`);
  return `${item.product?.name ?? "?"}${extras.length ? ` + ${extras.join(", ")}` : ""} × ${item.quantity}`;
}
