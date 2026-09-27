/** Usernames are lower-case letters/digits plus . _ - (2–32 chars), matching profiles_username_format. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const PIN_PATTERN = /^\d{6}$/;

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Workers sign in with username + PIN. Supabase Auth needs an email, so each username maps to a
 * synthetic address on a domain we never send mail to. Real emails (containing "@") pass through.
 */
export function loginEmail(usernameOrEmail: string, domain: string): string {
  const value = normalizeUsername(usernameOrEmail);
  return value.includes("@") ? value : `${value}@${domain}`;
}

/** Cafe codes, typed once on each phone at login (matches businesses.code). */
export const BUSINESS_CODE_PATTERN = /^[A-Z0-9]{3,16}$/;

export function normalizeBusinessCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Sign-in address for users created from inside the app. The cafe code keeps
 * usernames independent between businesses ("ravi" can exist in every cafe).
 * Sign-in never rebuilds this address: it looks the user up by code + username,
 * so accounts created before multi-business (plain username@domain) keep working.
 */
export function businessLoginEmail(code: string, username: string, domain: string): string {
  return `${normalizeBusinessCode(code).toLowerCase()}.${normalizeUsername(username)}@${domain}`;
}
