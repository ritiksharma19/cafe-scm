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
