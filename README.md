# Cafe SCM

Internal supply-chain and inventory PWA for 3 food carts and a central store.
Workers record events (sales, receipts, wastage); the database calculates inventory.

- Architecture and data model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Stack: Next.js 16 (App Router) · TypeScript · Tailwind 4 · Supabase (Postgres, Auth, RLS, Realtime) · Vercel

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Foundation: schema, RLS, auth (username + PIN), roles, PWA shell, user admin | ✅ |
| 2 | Worker sales + atomic recipe-based deduction, recipe versioning, void, orders/products admin | ✅ |
| 3 | Receiving (weighted-average cost), wastage, transfers, requests, blind stock counts + approval, suppliers | ✅ |
| 4 | Dashboard ("needs attention", KPIs, alerts, carts), inventory matrix + history, runway, analytics, live updates, materials/recipes/settings admin | ✅ |
| 5 | Excel import (preview, row-level validation, all-or-nothing, prices) and CSV/Excel exports of 7 reports | ✅ |
| 6 | Offline: sales, receipts and wastage saved on the phone first, synced with idempotent ids; worker screens open without signal; pending/failed status and sync screen | ✅ |

## One-time setup

### 1. Supabase project (free tier is fine)

1. Create a project at <https://supabase.com/dashboard> (region: **Mumbai / ap-south-1**).
2. **Authentication → Sign In / Providers → Email**:
   - turn **off** "Allow new users to sign up" (only the owner creates accounts),
   - turn **off** "Confirm email",
   - password minimum length **6**, no required character classes (worker PINs are 6 digits).
3. **Project Settings → API Keys**: copy the project URL, the publishable key and the secret key.

### 2. Local environment

```bash
cp .env.example .env.local      # then fill in the three Supabase values
npm install
```

### 3. Apply the database migrations (no Docker needed)

```bash
npx supabase login
npm run db:link -- --project-ref <your-project-ref>
npm run db:push
```

### 4. Create the owner account

```bash
npm run create-admin -- owner "Owner Name"
```

Then `npm run dev`, open <http://localhost:3000>, sign in as `owner`, and add one worker per cart under **Users**.

### 5. Load the sample menu (optional, for trying it out)

```bash
npm run seed:sample -- owner          # Burger, Roll, Fries, Shake, Mojito + prices, costs, opening stock
npm run check:concurrency -- <worker> # live check: 20 parallel sales incl. 5 retries → exactly 15 recorded
```

Sign in as a worker on a phone, sell a few items, then compare **Stock** before/after and open
**Admin → Orders** to see each order's ingredient deductions.

## Go-live checklist

1. Supabase project created, auth settings as above, `npm run db:push` applied.
2. Owner account created; one worker per cart under **Users** (6-digit PINs).
3. Real menu imported under **Admin → Import from Excel**; prices checked under **Products**.
4. Raw materials: reorder levels, lead times and default suppliers set; opening stock entered
   (a stock count per location, or **Inventory → material → Adjust stock**).
5. Deployed to Vercel; each worker opens the URL on their phone, signs in, taps **Add to Home Screen**,
   and opens every tab once while online (so the screens are saved for offline use).
6. Try offline once: airplane mode → sell an item (amber “Saved on this phone”) → back online → the
   pill returns to ONLINE and the order appears under **Admin → Orders** exactly once.
7. Optional before real sales: `npm run check:concurrency -- <worker>` on the sample data, then void the test orders.

## Offline behaviour

- Sales, stock receipts and wastage are saved on the phone **before** anything is sent, then synced
  automatically (on reconnect, when the app is opened, and every 30 s while items wait).
- Each document keeps its id across retries and the server ignores repeats, so nothing is ever counted twice.
- The header pill shows `ONLINE`, `OFFLINE — N PENDING SYNC`, `SYNCING N…` or `⚠ N FAILED`; tap it to see
  the items. A document the server refuses (e.g. a product was removed) is kept as FAILED for the worker to
  retry or remove — never dropped silently.
- Requests, transfers, stock counts and all admin screens need a connection.
- Sync within 3 days: older documents are recorded with the time they sync (the server rejects back-dating
  beyond 72 hours).

## Deploy (Vercel)

1. Push this repo to GitHub.
2. Import it in Vercel. Add the env vars from `.env.example` (`SUPABASE_SECRET_KEY` must **not** be `NEXT_PUBLIC_`).
3. Workers open the `*.vercel.app` URL on their phone → **Add to Home Screen**.

## Development

```bash
npm run dev          # local app
npm test             # unit + database tests (PGlite: real Postgres in-process, no Docker)
npm run check        # typecheck + lint + tests (same as CI)
npm run sample:excel # regenerate data/sample-recipes.xlsx
```

Database changes go in a **new** file under `supabase/migrations/` (never edit an applied migration),
with tests under `tests/db/`. The test harness (`tests/db/harness.ts`) emulates Supabase's
`auth.uid()` and roles, so RLS is tested exactly as it runs in production.

## Recipe sheet format

`data/sample-recipes.xlsx` shows the layout the importer accepts:

| Product | Burger Bun | Mayonnaise | Milk  | Lemon |
|---------|-----------:|-----------:|------:|------:|
| Burger  | 1          | 20gm       |       |       |
| Shake   |            |            | 200ml |       |
| Mojito  |            |            |       | 0.5   |

Plain numbers are pieces; `g/gm/kg` and `ml/l` suffixes are converted to grams / millilitres.
An optional **Price** column (also `Selling price` / `MRP`) sets product prices.

Import it under **Admin → Import from Excel**: the app shows every new material, new product, recipe change
and price change before saving, and saves all-or-nothing. **Admin → Reports & export** downloads sales,
inventory, stock movements, purchases, wastage, ingredient consumption and the recipes (in this same
format, so they can be edited and re-imported) as Excel or CSV.
