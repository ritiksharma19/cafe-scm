import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Business, Location, Profile, UserRole } from "@/lib/types";

export interface CurrentUser {
  profile: Profile;
  location: Location | null;
  business: Business;
}

/** The signed-in user's profile, business and assigned location, or null. Deduplicated per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return null;

  const [{ data: profile }, { data: businessData }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, username, full_name, role, location_id, business_id, is_active, created_at")
      .eq("id", userId)
      .maybeSingle<Profile>(),
    // Returned even when the business is suspended, so the app can say so.
    supabase.rpc("current_business"),
  ]);
  const business = businessData as Business | null;
  if (!profile || !profile.is_active || !business) return null;

  let location: Location | null = null;
  if (profile.location_id && business.status === "active") {
    const { data: loc } = await supabase
      .from("locations")
      .select("id, code, name, type, sort_order, is_active")
      .eq("id", profile.location_id)
      .maybeSingle<Location>();
    location = loc;
  }
  return { profile, location, business };
});

export function homePathFor(role: UserRole): string {
  return role === "admin" ? "/admin" : "/worker";
}

/**
 * Guards a server route. Redirects anonymous users to /login, users of a suspended
 * business to /suspended, and wrong roles to their own home.
 */
export async function requireRole(role: UserRole): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.business.status !== "active") redirect("/suspended");
  if (user.profile.role !== role) redirect(homePathFor(user.profile.role));
  return user;
}

/** Guards the platform pages (the product owner only). */
export async function requirePlatformAdmin(): Promise<CurrentUser> {
  const user = await requireRole("admin");
  if (!user.business.is_platform_admin) redirect("/admin");
  return user;
}
