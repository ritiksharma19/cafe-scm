"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loginEmail, normalizeUsername, PIN_PATTERN, USERNAME_PATTERN } from "@/lib/username";

export interface ActionResult {
  ok?: string;
  error?: string;
}

const BANNED_FOREVER = "876000h"; // ~100 years; "none" lifts the ban.

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || user.profile.role !== "admin") throw new Error("Not authorised");
  return user;
}

function emailDomain(): string {
  const domain = process.env.LOGIN_EMAIL_DOMAIN;
  if (!domain) throw new Error("Missing environment variable LOGIN_EMAIL_DOMAIN. See .env.example.");
  return domain;
}

export async function createWorker(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const username = normalizeUsername(String(formData.get("username") ?? ""));
  const fullName = String(formData.get("full_name") ?? "").trim();
  const locationId = String(formData.get("location_id") ?? "");
  const pin = String(formData.get("pin") ?? "");

  if (!USERNAME_PATTERN.test(username)) {
    return { error: "Username: 2–32 characters, lower-case letters, digits, dot, dash or underscore." };
  }
  if (!fullName) return { error: "Enter the worker's name." };
  if (!locationId) return { error: "Choose a cart." };
  if (!PIN_PATTERN.test(pin)) return { error: "PIN must be exactly 6 digits." };

  const supabase = await createClient();
  const { data: cart } = await supabase
    .from("locations")
    .select("id")
    .eq("id", locationId)
    .eq("type", "cart")
    .eq("is_active", true)
    .maybeSingle();
  if (!cart) return { error: "Choose an active cart." };

  const service = createAdminClient();
  const { data: existing } = await service.from("profiles").select("id").ilike("username", username).maybeSingle();
  if (existing) return { error: `Username "${username}" is already taken.` };

  const { data, error } = await service.auth.admin.createUser({
    email: loginEmail(username, emailDomain()),
    password: pin,
    email_confirm: true,
    app_metadata: { username, full_name: fullName, role: "worker", location_id: locationId },
  });
  if (error) {
    const taken = /already|exists|registered/i.test(error.message);
    return { error: taken ? `Username "${username}" is already taken.` : `Could not create user: ${error.message}` };
  }

  // The profile carries role and cart; without it the login has no access at all.
  const { error: profileError } = await service
    .from("profiles")
    .insert({ id: data.user.id, username, full_name: fullName, role: "worker", location_id: locationId });
  if (profileError) {
    await service.auth.admin.deleteUser(data.user.id); // never leave a half-created account
    return {
      error: profileError.code === "23505" ? `Username "${username}" is already taken.` : `Could not create user: ${profileError.message}`,
    };
  }

  await service.rpc("log_admin_action", {
    p_actor_id: admin.profile.id,
    p_action: "create_user",
    p_entity: "profiles",
    p_entity_id: data.user.id,
    p_new_value: { username, full_name: fullName, role: "worker", location_id: locationId },
  });

  revalidatePath("/admin/users");
  revalidatePath("/admin");
  return { ok: `Created ${fullName}. They sign in with username "${username}" and the PIN you set.` };
}

export async function updateWorker(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const fullName = String(formData.get("full_name") ?? "").trim();
  const locationId = String(formData.get("location_id") ?? "") || null;
  const isActive = formData.get("is_active") === "on";

  // Runs as the signed-in admin so the audit log records who made the change.
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_update_profile", {
    p_user_id: userId,
    p_full_name: fullName,
    p_location_id: locationId,
    p_is_active: isActive,
  });
  if (error) return { error: error.message };

  // Also block sign-in / token refresh at the auth layer for deactivated users.
  const service = createAdminClient();
  const { error: banError } = await service.auth.admin.updateUserById(userId, {
    ban_duration: isActive ? "none" : BANNED_FOREVER,
  });
  if (banError) return { error: `Saved, but could not update sign-in access: ${banError.message}` };

  revalidatePath("/admin/users");
  revalidatePath("/admin");
  return { ok: "Saved." };
}

export async function resetPin(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const pin = String(formData.get("pin") ?? "");
  if (!PIN_PATTERN.test(pin)) return { error: "PIN must be exactly 6 digits." };

  const service = createAdminClient();
  const { data: target } = await service.from("profiles").select("role").eq("id", userId).maybeSingle();
  if (!target) return { error: "User not found." };
  if (target.role !== "worker") return { error: "Admin passwords are changed from the Supabase dashboard." };

  const { error } = await service.auth.admin.updateUserById(userId, { password: pin });
  if (error) return { error: `Could not reset PIN: ${error.message}` };

  await service.rpc("log_admin_action", {
    p_actor_id: admin.profile.id,
    p_action: "reset_pin",
    p_entity: "profiles",
    p_entity_id: userId,
    p_new_value: null,
  });
  return { ok: "PIN updated." };
}
