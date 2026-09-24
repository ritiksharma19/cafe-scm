-- =============================================================================
-- Cafe SCM — create profiles explicitly, not from an auth.users trigger
--
-- Supabase Auth inserts the auth.users row first and writes app_metadata (role,
-- cart) in a later statement, so a trigger on INSERT never saw the role and every
-- account creation failed. Profiles are now inserted by the server (service role)
-- right after the auth user is created (see scripts/create-admin.mjs and
-- Admin → Users). An auth user without a profile has no access: every policy and
-- function requires an active profile.
-- =============================================================================

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_auth_user();
