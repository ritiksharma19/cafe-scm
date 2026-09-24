import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Location } from "@/lib/types";
import type { Conversion, Material, Unit } from "@/lib/units";

export interface Supplier {
  id: string;
  name: string;
}

export interface Catalog {
  materials: Material[];
  units: Unit[];
  conversions: Conversion[];
  suppliers: Supplier[];
  locations: Location[];
}

/** Reference data the stock forms need, read as the signed-in user (RLS applies). */
export async function loadCatalog(): Promise<Catalog> {
  const supabase = await createClient();
  const [materials, units, conversions, suppliers, locations] = await Promise.all([
    supabase
      .from("raw_materials")
      .select("id, name, base_unit, display_unit, is_active")
      .eq("is_active", true)
      .order("name")
      .returns<Material[]>(),
    supabase.from("units").select("code, name, base_code, factor_to_base").order("sort_order").returns<Unit[]>(),
    supabase.from("material_unit_conversions").select("material_id, unit_label, factor_to_base").returns<Conversion[]>(),
    supabase.from("suppliers").select("id, name").eq("is_active", true).order("name").returns<Supplier[]>(),
    supabase
      .from("locations")
      .select("id, code, name, type, sort_order, is_active")
      .eq("is_active", true)
      .order("sort_order")
      .returns<Location[]>(),
  ]);
  const failed = [materials, units, conversions, suppliers, locations].find((r) => r.error);
  if (failed?.error) throw new Error(`Could not load catalog: ${failed.error.message}`);
  return {
    materials: materials.data ?? [],
    units: units.data ?? [],
    conversions: conversions.data ?? [],
    suppliers: suppliers.data ?? [],
    locations: locations.data ?? [],
  };
}
