"use server";

import { redirect } from "next/navigation";
import { getCurrentUser, homePathFor } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loginEmail } from "@/lib/username";

export interface SignInState {
  error?: string;
  username?: string;
}

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return { error: "Enter your username and PIN.", username };

  const domain = process.env.LOGIN_EMAIL_DOMAIN;
  if (!domain) throw new Error("Missing environment variable LOGIN_EMAIL_DOMAIN. See .env.example.");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: loginEmail(username, domain), password });
  if (error) {
    const tooMany = error.status === 429;
    return { error: tooMany ? "Too many attempts. Wait a minute and try again." : "Wrong username or PIN.", username };
  }

  const user = await getCurrentUser();
  if (!user) {
    await supabase.auth.signOut();
    return { error: "This account is disabled. Ask the owner.", username };
  }
  redirect(homePathFor(user.profile.role));
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
