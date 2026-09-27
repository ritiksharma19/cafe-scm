#!/usr/bin/env node
/**
 * Creates an owner/admin account (bootstrap; afterwards use Admin → Platform → Businesses).
 *
 *   node --env-file=.env.local scripts/create-admin.mjs <CAFECODE> <username-or-email> "<Full Name>"
 *
 * If no business has that code yet, it is created (with Central Storage and one cart).
 * The very first admin ever created also becomes the platform admin (sees all businesses).
 *
 * With a real email (recommended for the owner) you sign in with that email and can use
 * Supabase password reset. With a plain username, a synthetic address is used instead.
 *
 * Prompts for the password (min 8 characters). Uses SUPABASE_SECRET_KEY, so run it only on a trusted machine.
 */
import { createClient } from "@supabase/supabase-js";
import { promptHidden } from "./prompt-hidden.mjs";
import { exit } from "node:process";

const [, , rawCode, rawUsername, fullName] = process.argv;
const code = (rawCode ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const domain = process.env.LOGIN_EMAIL_DOMAIN;

if (!rawUsername || !fullName || !/^[A-Z0-9]{3,16}$/.test(code)) {
  console.error('Usage: node --env-file=.env.local scripts/create-admin.mjs <CAFECODE> <username-or-email> "<Full Name>"');
  console.error("CAFECODE: 3–16 letters or digits, e.g. CHAIPOINT. Workers type it once when they sign in.");
  exit(1);
}
if (!url || !secret || !domain) {
  console.error("NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and LOGIN_EMAIL_DOMAIN must be set (see .env.example).");
  exit(1);
}

const login = rawUsername.trim().toLowerCase();
const isEmail = login.includes("@");
if (isEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login)) {
  console.error("That does not look like an email address.");
  exit(1);
}
// The app username (shown in Users) is the part before "@" for an email login.
const username = (isEmail ? login.split("@")[0] : login).replace(/[^a-z0-9._-]/g, "").slice(0, 32);
const email = isEmail ? login : `${code.toLowerCase()}.${username}@${domain}`;
if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username)) {
  console.error("Username: 2–32 characters, lower-case letters, digits, dot, dash or underscore.");
  exit(1);
}

let password = process.env.ADMIN_PASSWORD;
if (!password) {
  password = await promptHidden("Choose a password (min 8 characters, hidden): ");
  const again = await promptHidden("Type it again: ");
  if (again !== password) {
    console.error("The two passwords do not match. Nothing was created.");
    exit(1);
  }
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  exit(1);
}

const supabase = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });

let { data: business } = await supabase.from("businesses").select("id, name").eq("code", code).maybeSingle();
if (!business) {
  const name = code; // the owner renames it in Settings
  const { data: created, error: bizError } = await supabase.from("businesses").insert({ code, name }).select("id, name").single();
  if (bizError) {
    console.error(`Could not create business ${code}: ${bizError.message}`);
    exit(1);
  }
  business = created;
  const setup = await Promise.all([
    supabase.from("business_settings").insert({ business_id: business.id, business_name: name }),
    supabase.from("locations").insert([
      { business_id: business.id, code: "CENTRAL", name: "Central Storage", type: "central", sort_order: 0 },
      { business_id: business.id, code: "CART1", name: "Cart 1", type: "cart", sort_order: 1 },
    ]),
  ]);
  const failed = setup.find((r) => r.error);
  if (failed) {
    console.error(`Business ${code} was created but its setup failed: ${failed.error.message}`);
    exit(1);
  }
  console.log(`Created business ${code} (rename it in Settings).`);
}

const { data: taken } = await supabase
  .from("profiles")
  .select("id")
  .eq("business_id", business.id)
  .eq("username", username)
  .maybeSingle();
if (taken) {
  console.error(`The username "${username}" is already in use. Nothing was created.`);
  exit(1);
}

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  app_metadata: { username, full_name: fullName, role: "admin" },
});
if (error) {
  console.error(`Failed: ${error.message}`);
  exit(1);
}

// The profile carries the role; without it the account has no access at all.
const { error: profileError } = await supabase
  .from("profiles")
  .insert({ id: data.user.id, username, full_name: fullName, role: "admin", business_id: business.id });
if (profileError) {
  await supabase.auth.admin.deleteUser(data.user.id); // no half-created accounts
  console.error(`Failed to create the profile: ${profileError.message}. Nothing was kept.`);
  exit(1);
}
const { count } = await supabase.from("platform_admins").select("user_id", { count: "exact", head: true });
if (!count) {
  await supabase.from("platform_admins").insert({ user_id: data.user.id });
  console.log("This is the first admin, so it is also the platform admin (Admin → Businesses).");
}
console.log(`Admin created (id ${data.user.id}). Sign in with ${isEmail ? `"${email}"` : `cafe code ${code} and username "${username}"`}.`);
