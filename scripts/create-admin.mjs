#!/usr/bin/env node
/**
 * Creates the owner/admin account (one-time bootstrap).
 *
 *   node --env-file=.env.local scripts/create-admin.mjs <username> "<Full Name>"
 *
 * Prompts for the password (min 8 characters). Uses SUPABASE_SECRET_KEY, so run it only on a trusted machine.
 */
import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit } from "node:process";

const [, , rawUsername, fullName] = process.argv;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const domain = process.env.LOGIN_EMAIL_DOMAIN;

if (!rawUsername || !fullName) {
  console.error('Usage: node --env-file=.env.local scripts/create-admin.mjs <username> "<Full Name>"');
  exit(1);
}
if (!url || !secret || !domain) {
  console.error("NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and LOGIN_EMAIL_DOMAIN must be set (see .env.example).");
  exit(1);
}

const username = rawUsername.trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username)) {
  console.error("Username: 2–32 characters, lower-case letters, digits, dot, dash or underscore.");
  exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const password = process.env.ADMIN_PASSWORD ?? (await rl.question("Password (min 8 characters): "));
rl.close();
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  exit(1);
}

const supabase = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
const { data, error } = await supabase.auth.admin.createUser({
  email: `${username}@${domain}`,
  password,
  email_confirm: true,
  app_metadata: { username, full_name: fullName, role: "admin" },
});
if (error) {
  console.error(`Failed: ${error.message}`);
  exit(1);
}
console.log(`Admin "${username}" created (id ${data.user.id}). Sign in with username "${username}".`);
