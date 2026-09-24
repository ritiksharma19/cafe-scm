#!/usr/bin/env node
/**
 * Loads the dummy menu into Supabase for trying the app:
 *   - recipes from data/sample-recipes.xlsx (Burger, Roll, Fries, Shake, Mojito)
 *   - sample selling prices and ingredient costs
 *   - opening stock at Central Storage and each cart (only where none exists yet)
 *
 *   npm run seed:sample -- <admin-username>
 *
 * Signs in AS the admin (publishable key), so every change goes through the same
 * permission checks and audit trail as the app. Safe to run more than once.
 */
import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit } from "node:process";
import * as fs from "node:fs";
import * as XLSX from "xlsx";
import { parseRecipeSheet } from "../src/lib/recipe-sheet.ts";

const [, , rawUsername] = process.argv;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const domain = process.env.LOGIN_EMAIL_DOMAIN;
if (!rawUsername || !url || !key || !domain) {
  console.error("Usage: npm run seed:sample -- <admin-username>   (needs .env.local, see .env.example)");
  exit(1);
}

const PRICES = { Burger: 120, Roll: 100, Fries: 80, Shake: 110, Mojito: 90 };

// Sample weighted-average cost per BASE unit (₹ per pc / g / ml).
const COSTS = {
  "Burger Bun": 8, "Veg Patty": 25, "Cheese Slice": 10, Mayonnaise: 0.25, Lettuce: 0.12, Tomato: 0.04,
  Onion: 0.035, Paratha: 10, Paneer: 0.4, "Green Chutney": 0.15, "Frozen Fries": 0.18, "Peri Peri Masala": 0.6,
  "Tomato Ketchup": 0.12, "Cooking Oil": 0.15, Milk: 0.06, "Vanilla Ice Cream": 0.3, "Chocolate Syrup": 0.4,
  Sugar: 0.045, Ice: 0.01, "Mint Leaves": 0.4, Lemon: 5, "Sugar Syrup": 0.1, Soda: 0.05,
};

// Opening stock per cart in BASE units; Central Storage gets 4×.
const CART_STOCK = {
  "Burger Bun": 60, "Veg Patty": 60, "Cheese Slice": 60, Mayonnaise: 2000, Lettuce: 1000, Tomato: 2000,
  Onion: 3000, Paratha: 50, Paneer: 3000, "Green Chutney": 1000, "Frozen Fries": 5000, "Peri Peri Masala": 250,
  "Tomato Ketchup": 2000, "Cooking Oil": 5000, Milk: 5000, "Vanilla Ice Cream": 2000, "Chocolate Syrup": 1000,
  Sugar: 2000, Ice: 10000, "Mint Leaves": 300, Lemon: 30, "Sugar Syrup": 2000, Soda: 6000,
};

function fail(step, error) {
  console.error(`${step} failed: ${error.message}`);
  exit(1);
}

// 1. Sign in as the admin.
const username = rawUsername.trim().toLowerCase();
const rl = createInterface({ input: stdin, output: stdout });
const password = process.env.ADMIN_PASSWORD ?? (await rl.question(`Password for ${username}: `));
rl.close();

const supabase = createClient(url, key, { auth: { persistSession: false } });
const { error: signInError } = await supabase.auth.signInWithPassword({ email: `${username}@${domain}`, password });
if (signInError) fail("Sign-in", signInError);

// 2. Import the recipe sheet.
XLSX.set_fs(fs);
const wb = XLSX.readFile("data/sample-recipes.xlsx");
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
const sheet = parseRecipeSheet(rows);
if (sheet.errors.length) {
  console.error("Recipe sheet problems:\n  " + sheet.errors.join("\n  "));
  exit(1);
}
const { data: imported, error: importError } = await supabase.rpc("import_recipe_sheet", {
  p_sheet: {
    materials: sheet.materials.map((m) => ({ name: m.name, base_unit: m.baseUnit })),
    products: sheet.products.map((p) => ({
      name: p.name,
      items: p.items.map((i) => ({
        material: i.material,
        quantity: i.quantity,
        entered_qty: i.enteredQty,
        entered_unit: i.enteredUnit,
      })),
    })),
  },
});
if (importError) fail("Recipe import", importError);
console.log("Recipes:", imported);

// 3. Prices and costs.
for (const [name, price] of Object.entries(PRICES)) {
  const { error } = await supabase.from("products").update({ selling_price: price }).eq("name", name);
  if (error) fail(`Price for ${name}`, error);
}
const { data: materials, error: matError } = await supabase.from("raw_materials").select("id, name, avg_unit_cost");
if (matError) fail("Loading materials", matError);
for (const m of materials) {
  if (COSTS[m.name] !== undefined && Number(m.avg_unit_cost) === 0) {
    const { error } = await supabase.from("raw_materials").update({ avg_unit_cost: COSTS[m.name] }).eq("id", m.id);
    if (error) fail(`Cost for ${m.name}`, error);
  }
}
console.log("Prices and sample costs set.");

// 4. Opening stock where a location has none yet for a material.
const { data: locations, error: locError } = await supabase.from("locations").select("id, name, type");
if (locError) fail("Loading locations", locError);
const { data: levels, error: levelError } = await supabase.from("stock_levels").select("location_id, material_id");
if (levelError) fail("Loading stock", levelError);
const hasStock = new Set(levels.map((l) => `${l.location_id}:${l.material_id}`));

let posted = 0;
for (const loc of locations) {
  for (const m of materials) {
    const base = CART_STOCK[m.name];
    if (base === undefined || hasStock.has(`${loc.id}:${m.id}`)) continue;
    const { error } = await supabase.rpc("admin_adjust_stock", {
      p_location_id: loc.id,
      p_material_id: m.id,
      p_qty_delta: loc.type === "central" ? base * 4 : base,
      p_type: "OPENING_BALANCE",
      p_notes: "Sample opening stock",
    });
    if (error) fail(`Opening stock ${m.name} @ ${loc.name}`, error);
    posted++;
  }
}
console.log(`Opening stock rows posted: ${posted}`);

const { data: drift, error: verifyError } = await supabase.rpc("verify_stock_levels");
if (verifyError) fail("Verification", verifyError);
console.log(drift.length === 0 ? "Ledger check: OK" : `Ledger check: ${drift.length} mismatches!`);
await supabase.auth.signOut();
