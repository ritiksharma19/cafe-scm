/**
 * In-process Postgres (PGlite) with a minimal Supabase shim, so database logic
 * and RLS can be tested without Docker or a network connection.
 *
 * The shim mirrors what Supabase provides: the anon / authenticated / service_role
 * roles, auth.users, and auth.uid() reading the `sub` claim from request.jwt.claims.
 */
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

const SUPABASE_SHIM = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;

  create table auth.users (
    id                  uuid primary key default gen_random_uuid(),
    email               text unique,
    raw_app_meta_data   jsonb default '{}'::jsonb,
    raw_user_meta_data  jsonb default '{}'::jsonb,
    created_at          timestamptz default now()
  );

  create function auth.uid() returns uuid language sql stable as $$
    select nullif(
      coalesce(
        current_setting('request.jwt.claim.sub', true),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      ), ''
    )::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

export type Db = PGlite;
export type Tx = Transaction;

export async function createTestDb(): Promise<Db> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_SHIM);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    }
  }
  return db;
}

/** The business created from the original data (every test runs in it unless told otherwise). */
export async function firstBusinessId(db: Db): Promise<string> {
  const r = await db.query<{ id: string }>("select id from public.businesses order by created_at, code limit 1");
  return r.rows[0].id;
}

async function businessId(db: Db, code?: string): Promise<string> {
  if (!code) return firstBusinessId(db);
  const r = await db.query<{ id: string }>("select id from public.businesses where code = $1", [code]);
  if (!r.rows[0]) throw new Error(`No business ${code}`);
  return r.rows[0].id;
}

/**
 * A second (third …) business with settings, Central Storage and carts, created the
 * way the platform does it. Returns its id.
 */
export async function createBusiness(db: Db, code: string, carts = 2): Promise<string> {
  const r = await db.query<{ id: string }>("insert into public.businesses (code, name) values ($1, $2) returning id", [code, `${code} Cafe`]);
  const id = r.rows[0].id;
  await db.query("insert into public.business_settings (business_id, business_name) values ($1, $2)", [id, `${code} Cafe`]);
  await db.query("insert into public.locations (business_id, code, name, type, sort_order) values ($1, 'CENTRAL', 'Central Storage', 'central', 0)", [id]);
  for (let i = 1; i <= carts; i++) {
    await db.query("insert into public.locations (business_id, code, name, type, sort_order) values ($1, $2, $3, 'cart', $4)", [id, `CART${i}`, `Cart ${i}`, i]);
  }
  return id;
}

export async function locationId(db: Db, code: string, businessCode?: string): Promise<string> {
  const r = await db.query<{ id: string }>("select id from public.locations where code = $1 and business_id = $2", [
    code,
    await businessId(db, businessCode),
  ]);
  if (!r.rows[0]) throw new Error(`No location ${code}`);
  return r.rows[0].id;
}

/**
 * Creates a user the way production does: Supabase Auth inserts the auth.users row
 * (custom app_metadata is NOT present at insert time), then the server inserts the
 * profile with the service role.
 */
export async function createUser(
  db: Db,
  opts: { username: string; role: "admin" | "worker"; locationCode?: string; fullName?: string; business?: string },
): Promise<string> {
  const id = randomUUID();
  await db.query("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, $3)", [
    id,
    `${opts.username}.${opts.business ?? "main"}@test.local`,
    JSON.stringify({ provider: "email", providers: ["email"] }),
  ]);
  await db.query(
    "insert into public.profiles (id, username, full_name, role, location_id, business_id) values ($1, $2, $3, $4, $5, $6)",
    [
      id,
      opts.username,
      opts.fullName ?? opts.username,
      opts.role,
      opts.locationCode ? await locationId(db, opts.locationCode, opts.business) : null,
      await businessId(db, opts.business),
    ],
  );
  return id;
}

/**
 * Runs `fn` as a signed-in user (or anon when userId is null) inside a transaction
 * that is always rolled back, so tests never leak state into each other.
 */
export async function as<T>(db: Db, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let result: T;
  const rollback = new Error("__rollback__");
  try {
    await db.transaction(async (tx) => {
      const role = userId ? "authenticated" : "anon";
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(userId ? { sub: userId, role } : { role }),
      ]);
      await tx.exec(`set local role ${role}`);
      result = await fn(tx);
      throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  }
  return result!;
}

/** Like `as`, but COMMITS — for fixture setup that later tests build on. */
export async function asCommitted<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await tx.exec("set local role authenticated");
    return fn(tx);
  });
}

/** Like `as`, but the transaction runs as the database owner (bypasses RLS) and is rolled back. */
export async function asOwner<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let result: T;
  const rollback = new Error("__rollback__");
  try {
    await db.transaction(async (tx) => {
      result = await fn(tx);
      throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  }
  return result!;
}

/** Expects the promise to reject with a message matching `pattern`. */
export async function rejects(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    const msg = (e as Error).message;
    if (!pattern.test(msg)) throw new Error(`Expected error matching ${pattern}, got: ${msg}`);
    return;
  }
  throw new Error(`Expected rejection matching ${pattern}, but it succeeded`);
}
