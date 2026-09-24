import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

/** Supabase client for Client Components. Acts as the signed-in user; RLS applies. */
export function createClient() {
  return createBrowserClient(publicEnv.supabaseUrl(), publicEnv.supabaseKey());
}
