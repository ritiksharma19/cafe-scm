#!/usr/bin/env node
/**
 * Live check against Supabase (the in-process test DB cannot run truly parallel transactions).
 * Signs in as a cart worker and fires 20 Burger sales at once — 15 distinct orders, 5 of them
 * sent twice — then confirms exactly 15 were recorded and Veg Patty dropped by exactly 15.
 *
 *   npm run check:concurrency -- <worker-username>
 *
 * Run BEFORE going live (it records real test orders; void them afterwards under Admin → Orders).
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit } from "node:process";

const [, , rawUsername] = process.argv;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const domain = process.env.LOGIN_EMAIL_DOMAIN;
if (!rawUsername || !url || !key || !domain) {
  console.error("Usage: npm run check:concurrency -- <worker-username>");
  exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const pin = process.env.WORKER_PIN ?? (await rl.question(`PIN for ${rawUsername}: `));
rl.close();

const supabase = createClient(url, key, { auth: { persistSession: false } });
const { data: auth, error: signInError } = await supabase.auth.signInWithPassword({
  email: `${rawUsername.trim().toLowerCase()}@${domain}`,
  password: pin,
});
if (signInError) {
  console.error(`Sign-in failed: ${signInError.message}`);
  exit(1);
}

const { data: profile } = await supabase.from("profiles").select("location_id").eq("id", auth.user.id).single();
const { data: burger } = await supabase.from("products").select("id").eq("name", "Burger").single();
const { data: patty } = await supabase.from("raw_materials").select("id").eq("name", "Veg Patty").single();
if (!profile?.location_id || !burger || !patty) {
  console.error("Needs a worker with a cart and the sample data (npm run seed:sample).");
  exit(1);
}

async function pattyStock() {
  const { data } = await supabase
    .from("stock_levels")
    .select("quantity")
    .eq("location_id", profile.location_id)
    .eq("material_id", patty.id)
    .maybeSingle();
  return Number(data?.quantity ?? 0);
}

const before = await pattyStock();
const ids = Array.from({ length: 15 }, () => randomUUID());
const requests = [...ids, ...ids.slice(0, 5)].map((id) =>
  supabase.rpc("record_sale", { p_order_id: id, p_items: [{ product_id: burger.id, quantity: 1 }] }),
);
const results = await Promise.all(requests);
const errors = results.filter((r) => r.error);
const created = results.filter((r) => r.data?.status === "created").length;
const duplicates = results.filter((r) => r.data?.status === "duplicate").length;
const after = await pattyStock();

console.log(`Sent 20 requests: ${created} created, ${duplicates} duplicates, ${errors.length} errors`);
console.log(`Veg Patty: ${before} → ${after} (expected ${before - 15})`);
for (const e of errors) console.log("  error:", e.error.message);

const pass = errors.length === 0 && created === 15 && duplicates === 5 && after === before - 15;
console.log(pass ? "PASS" : "FAIL");
console.log("Test order ids (void under Admin → Orders):", ids.join(", "));
await supabase.auth.signOut();
exit(pass ? 0 : 1);
