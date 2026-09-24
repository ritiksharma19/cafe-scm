"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface MaterialResult {
  ok?: string;
  error?: string;
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Level typed in the display unit → base units; empty → null. Returns NaN on bad input. */
function level(fd: FormData, key: string, factor: number): number | null {
  const v = str(fd, key).replace(",", ".");
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * factor * 1000) / 1000 : NaN;
}

// All writes below are admin-only by RLS and recorded by the audit trigger.

export async function saveMaterial(_prev: MaterialResult, fd: FormData): Promise<MaterialResult> {
  const supabase = await createClient();
  const id = str(fd, "id");
  const name = str(fd, "name");
  const displayUnit = str(fd, "display_unit");
  const baseUnit = str(fd, "base_unit");
  if (!name) return { error: "Enter a name." };

  const { data: unit } = await supabase.from("units").select("base_code, factor_to_base").eq("code", displayUnit).maybeSingle();
  if (!unit) return { error: "Choose a unit." };
  const factor = Number(unit.factor_to_base);
  const minLevel = level(fd, "min_level", factor);
  const reorderLevel = level(fd, "reorder_level", factor);
  const targetLevel = level(fd, "target_level", factor);
  const lead = Number(str(fd, "lead_time_days") || "1");
  if ([minLevel, reorderLevel, targetLevel].some((v) => Number.isNaN(v))) return { error: "Levels must be numbers ≥ 0." };
  if (!Number.isInteger(lead) || lead < 0) return { error: "Lead time must be whole days." };
  if (minLevel !== null && reorderLevel !== null && reorderLevel > 0 && minLevel > reorderLevel) {
    return { error: "Minimum level should not be above the reorder level." };
  }

  const row = {
    name,
    display_unit: displayUnit,
    min_level: minLevel ?? 0,
    reorder_level: reorderLevel ?? 0,
    target_level: targetLevel,
    lead_time_days: lead,
    default_supplier_id: str(fd, "default_supplier_id") || null,
  };
  const { data, error } = id
    ? await supabase
        .from("raw_materials")
        .update({ ...row, is_active: fd.get("is_active") === "on" })
        .eq("id", id)
        .select("id")
    : await supabase
        .from("raw_materials")
        .insert({ ...row, base_unit: baseUnit || unit.base_code })
        .select("id");
  if (error) return { error: error.code === "23505" ? `"${name}" already exists.` : error.message };
  if (!data?.length) return { error: "Not allowed." };
  revalidatePath("/admin/materials");
  return { ok: "Saved." };
}

export async function saveLocationLevels(_prev: MaterialResult, fd: FormData): Promise<MaterialResult> {
  const supabase = await createClient();
  const materialId = str(fd, "material_id");
  const factor = Number(str(fd, "factor") || "1");
  const locationIds = fd.getAll("location_id").map(String);

  const upserts = [];
  const clears = [];
  for (const loc of locationIds) {
    const min = level(fd, `min_${loc}`, factor);
    const reorder = level(fd, `reorder_${loc}`, factor);
    const target = level(fd, `target_${loc}`, factor);
    if ([min, reorder, target].some((v) => Number.isNaN(v))) return { error: "Levels must be numbers ≥ 0." };
    if (min === null && reorder === null && target === null) clears.push(loc);
    else upserts.push({ location_id: loc, material_id: materialId, min_level: min ?? 0, reorder_level: reorder ?? 0, target_level: target });
  }
  if (upserts.length) {
    const { error } = await supabase.from("location_material_settings").upsert(upserts);
    if (error) return { error: error.message };
  }
  if (clears.length) {
    const { error } = await supabase
      .from("location_material_settings")
      .delete()
      .eq("material_id", materialId)
      .in("location_id", clears);
    if (error) return { error: error.message };
  }
  revalidatePath("/admin/materials");
  return { ok: "Saved." };
}
