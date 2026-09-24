import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Location, Profile, UserRole } from "@/lib/types";

export interface CurrentUser {
  profile: Profile;
  location: Location | null;
}

/** The signed-in user's profile and assigned location, or null. Deduplicated per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, username, full_name, role, location_id, is_active, created_at")
    .eq("id", userId)
    .maybeSingle<Profile>();
  if (!profile || !profile.is_active) return null;

  let location: Location | null = null;
  if (profile.location_id) {
    const { data: loc } = await supabase
      .from("locations")
      .select("id, code, name, type, sort_order, is_active")
      .eq("id", profile.location_id)
      .maybeSingle<Location>();
    location = loc;
  }
  return { profile, location };
});

export function homePathFor(role: UserRole): string {
  return role === "admin" ? "/admin" : "/worker";
}

/** Guards a server route. Redirects anonymous users to /login and wrong roles to their own home. */
export async function requireRole(role: UserRole): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.profile.role !== role) redirect(homePathFor(user.profile.role));
  return user;
}
