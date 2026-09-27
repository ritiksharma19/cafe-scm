"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/admin/stock-actions";
import { getCurrentUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { businessLoginEmail, normalizeBusinessCode, normalizeUsername, USERNAME_PATTERN } from "@/lib/username";

// Business rows are changed through platform_* functions, which re-check that the
// caller is a platform admin. Owner logins need the auth service (service role).

async function requirePlatform() {
  const user = await getCurrentUser();
  if (!user || !user.business.is_platform_admin || user.business.status !== "active") throw new Error("Not authorised");
  return user;
}

const text = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const optionalInt = (fd: FormData, k: string) => (text(fd, k) === "" ? null : Number(text(fd, k)));

async function createOwner(businessId: string, code: string, fd: FormData, actorId: string): Promise<string | null> {
  const username = normalizeUsername(text(fd, "owner_username"));
  const fullName = text(fd, "owner_name");
  const password = String(fd.get("owner_password") ?? "");
  if (!USERNAME_PATTERN.test(username)) return "Owner username: 2–32 lower-case letters, digits, dot, dash or underscore.";
  if (!fullName) return "Enter the owner's name.";
  if (password.length < 8) return "Owner password: at least 8 characters.";
  const domain = process.env.LOGIN_EMAIL_DOMAIN;
  if (!domain) return "LOGIN_EMAIL_DOMAIN is not set on the server.";

  const service = createAdminClient();
  const { data: taken } = await service.from("profiles").select("id").eq("business_id", businessId).eq("username", username).maybeSingle();
  if (taken) return `Username "${username}" already exists in this business.`;

  const { data, error } = await service.auth.admin.createUser({
    email: businessLoginEmail(code, username, domain),
    password,
    email_confirm: true,
    app_metadata: { username, full_name: fullName, role: "admin" },
  });
  if (error) return `Could not create the owner login: ${error.message}`;
  const { error: profileError } = await service
    .from("profiles")
    .insert({ id: data.user.id, username, full_name: fullName, role: "admin", business_id: businessId });
  if (profileError) {
    await service.auth.admin.deleteUser(data.user.id); // never leave a half-created account
    return `Could not create the owner profile: ${profileError.message}`;
  }
  await service.rpc("log_admin_action", {
    p_actor_id: actorId,
    p_action: "create_owner",
    p_entity: "profiles",
    p_entity_id: data.user.id,
    p_new_value: { username, full_name: fullName, role: "admin", business_id: businessId },
  });
  return null;
}

export async function createBusiness(_p: ActionState, fd: FormData): Promise<ActionState> {
  const me = await requirePlatform();
  const code = normalizeBusinessCode(text(fd, "code"));
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("platform_create_business", {
    p_name: text(fd, "name"),
    p_code: code,
    p_plan: text(fd, "plan") || "standard",
    p_cart_limit: optionalInt(fd, "cart_limit"),
    p_carts: optionalInt(fd, "carts") ?? 1,
  });
  if (error) return { error: error.message };

  const ownerError = await createOwner(id as string, code, fd, me.profile.id);
  revalidatePath("/admin/platform");
  if (ownerError) return { error: `Business ${code} created, but: ${ownerError} Add the owner from its card below.` };
  return { ok: `Created ${code}. The owner signs in with cafe code ${code}, username "${normalizeUsername(text(fd, "owner_username"))}" and the password you set.` };
}

export async function addOwner(_p: ActionState, fd: FormData): Promise<ActionState> {
  const me = await requirePlatform();
  const service = createAdminClient();
  const { data: b } = await service.from("businesses").select("id, code").eq("id", text(fd, "business_id")).maybeSingle<{ id: string; code: string }>();
  if (!b) return { error: "Business not found." };
  const err = await createOwner(b.id, b.code, fd, me.profile.id);
  if (err) return { error: err };
  revalidatePath("/admin/platform");
  return { ok: "Owner login created." };
}

export async function updateBusiness(_p: ActionState, fd: FormData): Promise<ActionState> {
  await requirePlatform();
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_update_business", {
    p_id: text(fd, "id"),
    p_name: text(fd, "name"),
    p_code: normalizeBusinessCode(text(fd, "code")),
    p_plan: text(fd, "plan"),
    p_cart_limit: optionalInt(fd, "cart_limit"),
    p_status: fd.get("suspended") === "on" ? "suspended" : "active",
    p_notes: text(fd, "notes") || null,
  });
  if (error) return { error: error.message };
  revalidatePath("/admin/platform");
  return { ok: "Saved." };
}
