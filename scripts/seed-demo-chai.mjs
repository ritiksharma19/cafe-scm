#!/usr/bin/env node
/**
 * Fills a business with 30 days of realistic demo data for a tea-stall chain
 * ("Chai Point"), for showing the app to clients:
 *   - chai / coffee / snacks menu, recipes, menu sections, 2 sizes, 4 add-ons
 *   - 5 suppliers, daily milk & bakery deliveries, weekly restocks with price changes
 *   - 3 carts with workers, ~3,500 orders (cash / UPI / card, add-ons, discounts, voids)
 *   - transfers, wastage, expenses (rent, wages, gas, fees…), weekly stock counts,
 *     stock requests; plus open items for today (count to approve, request, transfer)
 *
 *   npm run seed:demo -- <CAFECODE> <admin-username>
 *   e.g. npm run seed:demo -- CHAIPOINT ravi
 *
 * How: runs scripts/demo/chai-demo.sql on the linked Supabase project with
 * `supabase db query --linked` (the Supabase CLI must be logged in and linked — the
 * same setup as `npm run db:push`). Workers are created through Supabase Auth.
 * Only runs the 30-day history when the business has no orders yet.
 * Needs .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, LOGIN_EMAIL_DOMAIN).
 */
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exit } from "node:process";

const [, , rawCode, rawAdmin] = process.argv;
const code = (rawCode ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const adminUsername = (rawAdmin ?? "").trim().toLowerCase();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const domain = process.env.LOGIN_EMAIL_DOMAIN;
if (!/^[A-Z0-9]{3,16}$/.test(code) || !/^[a-z0-9._-]{2,32}$/.test(adminUsername) || !url || !secret || !domain) {
  console.error("Usage: npm run seed:demo -- <CAFECODE> <admin-username>   (needs .env.local)");
  exit(1);
}

const WORKERS = [
  { username: "arjun", name: "Arjun Yadav", pin: "111111", cart: "CART1" },
  { username: "neha", name: "Neha Gupta", pin: "444444", cart: "CART1" },
  { username: "priya", name: "Priya Singh", pin: "222222", cart: "CART2" },
  { username: "sameer", name: "Sameer Khan", pin: "333333", cart: "CART3" },
];

const service = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
const work = mkdtempSync(join(tmpdir(), "cafe-demo-"));
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  exit(1);
};

/** Runs SQL on the linked project as the database owner; returns the parsed rows. */
function sql(text, label) {
  const file = join(work, `${label.replace(/\W+/g, "-")}.sql`);
  writeFileSync(file, text);
  const r = spawnSync("npx", ["supabase", "db", "query", "--linked", "--output-format", "json", "-f", file], {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}`;
  if (r.status !== 0) fail(`${label} failed:\n${(r.stderr || out).trim()}`);
  const start = out.indexOf("{");
  try {
    return JSON.parse(out.slice(start, out.lastIndexOf("}") + 1)).rows ?? [];
  } catch {
    return [];
  }
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// 1. Business and admin
const { data: business } = await service.from("businesses").select("id, code").eq("code", code).maybeSingle();
if (!business) fail(`No business with code ${code}. Create it first (docs/create-customer.md).`);
const { data: admin } = await service
  .from("profiles").select("id, role, is_active").eq("business_id", business.id).eq("username", adminUsername).maybeSingle();
if (!admin || admin.role !== "admin" || !admin.is_active) fail(`${adminUsername} is not an active admin of ${code}.`);

// 2. Setup (menu, carts, suppliers, sizes, add-ons) through the app's own functions
process.stdout.write("Setting up menu, carts, suppliers, sizes and add-ons… ");
sql(`${readFileSync("scripts/demo/chai-demo.sql", "utf8")}\nselect demo_seed.setup(${q(code)}, ${q(adminUsername)});`, "setup");
console.log("done");

// 3. Workers (created the way Admin → Users does)
const { data: locations } = await service.from("locations").select("id, code").eq("business_id", business.id);
for (const w of WORKERS) {
  const cart = locations.find((l) => l.code === w.cart);
  const { data: existing } = await service.from("profiles").select("id").eq("business_id", business.id).eq("username", w.username).maybeSingle();
  if (existing) continue;
  const { data, error } = await service.auth.admin.createUser({
    email: `${code.toLowerCase()}.${w.username}@${domain}`,
    password: w.pin,
    email_confirm: true,
    app_metadata: { username: w.username, full_name: w.name, role: "worker", location_id: cart.id },
  });
  if (error) fail(`Creating worker ${w.username}: ${error.message}`);
  const { error: pErr } = await service.from("profiles").insert({
    id: data.user.id, username: w.username, full_name: w.name, role: "worker", location_id: cart.id, business_id: business.id,
  });
  if (pErr) {
    await service.auth.admin.deleteUser(data.user.id);
    fail(`Creating profile ${w.username}: ${pErr.message}`);
  }
}
console.log(`Workers ready: ${WORKERS.map((w) => `${w.username} (${w.cart})`).join(", ")}`);

// 4. 30 days of history, oldest first, in small chunks
const { count: orders } = await service.from("orders").select("id", { count: "exact", head: true }).eq("business_id", business.id);
if (orders) {
  console.log(`${code} already has ${orders} orders — skipping the history (it is only added once).`);
} else {
  for (let from = 30; from >= 0; from -= 3) {
    const to = Math.max(0, from - 2);
    const [row] = sql(`select demo_seed.run_days(${q(code)}, ${from}, ${to}) as result;`, `days-${from}`);
    console.log(`  ${row?.result ?? `days ${from}..${to} done`}`);
  }
  const [row] = sql(`select demo_seed.finish(${q(code)})::text as summary;`, "finish");
  if (row?.summary) {
    const s = JSON.parse(row.summary);
    console.log(
      `\nLast 30 days: ${s.orders} orders · net sales ₹${s.net_sales} · gross profit ₹${s.gross_profit} (${s.gross_margin_pct}%) · ` +
        `expenses ₹${s.expenses} · net profit ₹${s.net_profit} (${s.net_margin_pct}%)`,
    );
  }
}

// 5. Remove the temporary seeding functions
sql("drop schema if exists demo_seed cascade;", "cleanup");

console.log(`\nSign in with cafe code ${code}:`);
console.log(`  owner   ${adminUsername.padEnd(8)} (your password)`);
for (const w of WORKERS) console.log(`  worker  ${w.username.padEnd(8)} PIN ${w.pin}   ${w.cart}`);
