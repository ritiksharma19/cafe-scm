"use server";

import { redirect } from "next/navigation";
import { getCurrentUser, homePathFor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { BUSINESS_CODE_PATTERN, normalizeBusinessCode, normalizeUsername } from "@/lib/username";

export interface SignInState {
  error?: string;
  username?: string;
  code?: string;
}

const WRONG = "Wrong cafe code, username or PIN.";

/**
 * The sign-in address of cafe code + username. Looked up (not rebuilt), so accounts
 * created before multi-business keep their original address. Null = no such user;
 * the caller shows one generic message so codes and usernames cannot be probed.
 */
async function lookupEmail(code: string, username: string): Promise<string | null> {
  const service = createAdminClient();
  const { data: business } = await service.from("businesses").select("id").eq("code", code).maybeSingle<{ id: string }>();
  if (!business) return null;
  const { data: profile } = await service
    .from("profiles")
    .select("id")
    .eq("business_id", business.id)
    .eq("username", username)
    .maybeSingle<{ id: string }>();
  if (!profile) return null;
  const { data } = await service.auth.admin.getUserById(profile.id);
  return data.user?.email ?? null;
}

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const login = String(formData.get("username") ?? "").trim();
  const code = normalizeBusinessCode(String(formData.get("code") ?? ""));
  const password = String(formData.get("password") ?? "");
  const back = { username: login, code };
  if (!login || !password) return { ...back, error: "Enter your username and PIN." };

  // Owners may sign in with a real email address; everyone else uses cafe code + username.
  let email: string | null;
  if (login.includes("@")) {
    email = login.toLowerCase();
  } else {
    if (!BUSINESS_CODE_PATTERN.test(code)) return { ...back, error: "Enter your cafe code (ask the owner)." };
    email = await lookupEmail(code, normalizeUsername(login));
    if (!email) return { ...back, error: WRONG };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { ...back, error: error.status === 429 ? "Too many attempts. Wait a minute and try again." : WRONG };
  }

  const user = await getCurrentUser();
  if (!user) {
    await supabase.auth.signOut();
    return { ...back, error: "This account is disabled. Ask the owner." };
  }
  if (user.business.status !== "active") redirect("/suspended");
  redirect(homePathFor(user.profile.role));
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
