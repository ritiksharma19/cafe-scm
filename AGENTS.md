<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project conventions (Cafe SCM)

- Read `docs/ARCHITECTURE.md` before changing the data model.
- Workers record events; inventory changes ONLY through SECURITY DEFINER Postgres functions that write
  `stock_movements` + `stock_levels` in one transaction. Never write stock from the frontend.
- `stock_movements` / `audit_logs` are append-only; documents are voided/reversed, never deleted.
- Quantities: `numeric(14,3)` in the material's base unit (g / ml / pcs). No floats for stock maths.
- Worker-created documents use client-generated UUIDs as idempotency keys.
- New DB changes = new file in `supabase/migrations/` plus tests in `tests/db/` (PGlite harness).
- Run `npm run check` before finishing a change.
