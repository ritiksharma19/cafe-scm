import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";

/**
 * Privileged client (bypasses RLS). Server-only; use solely for auth administration
 * after the caller has been verified as an admin.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Missing environment variable SUPABASE_SECRET_KEY. See .env.example.");
  return createClient(publicEnv.supabaseUrl(), key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
