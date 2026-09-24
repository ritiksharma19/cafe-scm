-- =============================================================================
-- Cafe SCM — core schema
-- Quantities: numeric(14,3) in the material's BASE unit (g / ml / pcs).
-- Money: numeric(12,2). Unit costs: numeric(14,4) per base unit.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.user_role       as enum ('admin', 'worker');
create type public.location_type   as enum ('central', 'cart');
create type public.movement_type   as enum (
  'OPENING_BALANCE',
  'PURCHASE',
  'SALE_CONSUMPTION',
  'SALE_REVERSAL',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'TRANSFER_CANCEL',
  'WASTAGE',
  'WASTAGE_REVERSAL',
  'COUNT_ADJUSTMENT',
  'MANUAL_ADJUSTMENT'
);
create type public.order_status    as enum ('completed', 'voided');
create type public.doc_status      as enum ('posted', 'voided');
create type public.wastage_reason  as enum ('dropped', 'spoiled', 'damaged', 'expired', 'prep_waste', 'other');
create type public.transfer_status as enum ('in_transit', 'received', 'cancelled');
create type public.request_status  as enum ('pending', 'approved', 'fulfilled', 'rejected', 'cancelled');
create type public.count_status    as enum ('draft', 'posted');

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Locations (Central Storage + carts) and people
-- ---------------------------------------------------------------------------
create table public.locations (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  type        public.location_type not null,
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index locations_single_central on public.locations (type) where type = 'central';

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    text not null,
  full_name   text not null,
  role        public.user_role not null,
  location_id uuid references public.locations (id),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9][a-z0-9._-]{1,31}$'),
  constraint profiles_worker_has_location check (role = 'admin' or location_id is not null)
);
create unique index profiles_username_key on public.profiles (lower(username));
create index profiles_location_idx on public.profiles (location_id);

create table public.app_settings (
  id                      boolean primary key default true check (id),
  business_name           text not null default 'Cafe SCM',
  timezone                text not null default 'Asia/Kolkata',
  currency                text not null default 'INR',
  runway_window_days      int  not null default 7  check (runway_window_days between 1 and 90),
  min_history_days        int  not null default 3  check (min_history_days between 1 and 90),
  -- Sales are recorded after food is handed over (and may sync late from offline),
  -- so they may push stock negative; this is flagged, not blocked.
  allow_negative_on_sale  boolean not null default true,
  -- Wastage / transfers / adjustments may not push stock negative by default.
  allow_negative_other    boolean not null default false,
  updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
create table public.units (
  code            text primary key,
  name            text not null,
  base_code       text not null references public.units (code),
  factor_to_base  numeric(14,6) not null check (factor_to_base > 0),
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  constraint units_base_is_self check (base_code <> code or factor_to_base = 1)
);

create table public.suppliers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index suppliers_name_key on public.suppliers (lower(name));

create table public.raw_materials (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  sku                  text unique,
  base_unit            text not null references public.units (code),
  display_unit         text not null references public.units (code),
  min_level            numeric(14,3) not null default 0 check (min_level >= 0),
  reorder_level        numeric(14,3) not null default 0 check (reorder_level >= 0),
  target_level         numeric(14,3) check (target_level >= 0),
  default_supplier_id  uuid references public.suppliers (id),
  lead_time_days       int not null default 1 check (lead_time_days >= 0),
  avg_unit_cost        numeric(14,4) not null default 0 check (avg_unit_cost >= 0),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index raw_materials_name_key on public.raw_materials (lower(name));

-- Material-specific packaging, e.g. Burger Bun "pack" = 6 pcs, Syrup "bottle" = 750 ml.
create table public.material_unit_conversions (
  material_id     uuid not null references public.raw_materials (id),
  unit_label      text not null,
  factor_to_base  numeric(14,6) not null check (factor_to_base > 0),
  created_at      timestamptz not null default now(),
  primary key (material_id, unit_label)
);

-- Optional per-location thresholds (a cart needs far less than Central Storage).
create table public.location_material_settings (
  location_id    uuid not null references public.locations (id),
  material_id    uuid not null references public.raw_materials (id),
  min_level      numeric(14,3) not null default 0 check (min_level >= 0),
  reorder_level  numeric(14,3) not null default 0 check (reorder_level >= 0),
  target_level   numeric(14,3) check (target_level >= 0),
  updated_at     timestamptz not null default now(),
  primary key (location_id, material_id)
);

create table public.products (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  category       text,
  selling_price  numeric(12,2) not null default 0 check (selling_price >= 0),
  sort_order     int not null default 0,
  color          text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index products_name_key on public.products (lower(name));

-- Recipes are versioned. Editing a recipe closes the open version and creates a new one,
-- so historical orders keep pointing at the recipe they actually consumed with.
create table public.product_recipes (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products (id),
  version         int  not null check (version > 0),
  effective_from  timestamptz not null default now(),
  effective_to    timestamptz,
  notes           text,
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now(),
  unique (product_id, version),
  constraint product_recipes_valid_range check (effective_to is null or effective_to > effective_from)
);
create unique index product_recipes_one_open on public.product_recipes (product_id) where effective_to is null;

create table public.recipe_items (
  id            uuid primary key default gen_random_uuid(),
  recipe_id     uuid not null references public.product_recipes (id),
  material_id   uuid not null references public.raw_materials (id),
  quantity      numeric(14,3) not null check (quantity > 0),   -- base unit, per 1 product
  entered_qty   numeric(14,3),
  entered_unit  text,
  created_at    timestamptz not null default now(),
  unique (recipe_id, material_id)
);
create index recipe_items_material_idx on public.recipe_items (material_id);

-- ---------------------------------------------------------------------------
-- Event documents. Ids of worker-created documents are generated on the device
-- and double as idempotency keys (safe offline retry).
-- ---------------------------------------------------------------------------
create table public.orders (
  id            uuid primary key,
  location_id   uuid not null references public.locations (id),
  worker_id     uuid not null references public.profiles (id),
  occurred_at   timestamptz not null,
  received_at   timestamptz not null default now(),
  status        public.order_status not null default 'completed',
  item_count    int not null default 0,
  total_amount  numeric(12,2) not null default 0,
  void_reason   text,
  voided_by     uuid references public.profiles (id),
  voided_at     timestamptz,
  created_at    timestamptz not null default now()
);
create index orders_location_time_idx on public.orders (location_id, occurred_at desc);
create index orders_time_idx on public.orders (occurred_at desc);

create table public.order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders (id),
  product_id  uuid not null references public.products (id),
  recipe_id   uuid references public.product_recipes (id),
  quantity    int not null check (quantity > 0),
  unit_price  numeric(12,2) not null default 0,
  line_total  numeric(12,2) not null default 0,
  created_at  timestamptz not null default now(),
  unique (order_id, product_id)
);
create index order_items_product_idx on public.order_items (product_id);

create table public.purchase_receipts (
  id           uuid primary key,
  location_id  uuid not null references public.locations (id),
  supplier_id  uuid references public.suppliers (id),
  invoice_ref  text,
  received_by  uuid not null references public.profiles (id),
  occurred_at  timestamptz not null,
  received_at  timestamptz not null default now(),
  status       public.doc_status not null default 'posted',
  total_cost   numeric(12,2) not null default 0,
  notes        text,
  void_reason  text,
  voided_by    uuid references public.profiles (id),
  voided_at    timestamptz,
  created_at   timestamptz not null default now()
);
create index purchase_receipts_location_time_idx on public.purchase_receipts (location_id, occurred_at desc);
create index purchase_receipts_supplier_idx on public.purchase_receipts (supplier_id);

create table public.purchase_receipt_items (
  id            uuid primary key default gen_random_uuid(),
  receipt_id    uuid not null references public.purchase_receipts (id),
  material_id   uuid not null references public.raw_materials (id),
  quantity      numeric(14,3) not null check (quantity > 0),   -- base unit
  entered_qty   numeric(14,3),
  entered_unit  text,
  unit_cost     numeric(14,4),                                  -- per base unit
  line_cost     numeric(12,2),
  created_at    timestamptz not null default now()
);
create index purchase_receipt_items_receipt_idx on public.purchase_receipt_items (receipt_id);
create index purchase_receipt_items_material_idx on public.purchase_receipt_items (material_id);

create table public.wastage (
  id            uuid primary key,
  location_id   uuid not null references public.locations (id),
  material_id   uuid not null references public.raw_materials (id),
  quantity      numeric(14,3) not null check (quantity > 0),   -- base unit
  entered_qty   numeric(14,3),
  entered_unit  text,
  reason        public.wastage_reason not null,
  notes         text,
  recorded_by   uuid not null references public.profiles (id),
  occurred_at   timestamptz not null,
  received_at   timestamptz not null default now(),
  status        public.doc_status not null default 'posted',
  void_reason   text,
  voided_by     uuid references public.profiles (id),
  voided_at     timestamptz,
  created_at    timestamptz not null default now()
);
create index wastage_location_time_idx on public.wastage (location_id, occurred_at desc);
create index wastage_material_idx on public.wastage (material_id);

create table public.stock_requests (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations (id),
  requested_by  uuid not null references public.profiles (id),
  status        public.request_status not null default 'pending',
  needed_by     date,
  notes         text,
  resolved_by   uuid references public.profiles (id),
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index stock_requests_location_idx on public.stock_requests (location_id, created_at desc);
create index stock_requests_pending_idx on public.stock_requests (status) where status = 'pending';

create table public.stock_request_items (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.stock_requests (id),
  material_id  uuid not null references public.raw_materials (id),
  quantity     numeric(14,3) not null check (quantity > 0),
  unique (request_id, material_id)
);

create table public.stock_transfers (
  id                uuid primary key default gen_random_uuid(),
  from_location_id  uuid not null references public.locations (id),
  to_location_id    uuid not null references public.locations (id),
  status            public.transfer_status not null default 'in_transit',
  request_id        uuid references public.stock_requests (id),
  notes             text,
  created_by        uuid not null references public.profiles (id),
  dispatched_at     timestamptz not null default now(),
  received_by       uuid references public.profiles (id),
  received_at       timestamptz,
  cancelled_by      uuid references public.profiles (id),
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now(),
  constraint stock_transfers_distinct_locations check (from_location_id <> to_location_id)
);
create index stock_transfers_from_idx on public.stock_transfers (from_location_id, created_at desc);
create index stock_transfers_to_idx on public.stock_transfers (to_location_id, created_at desc);

create table public.stock_transfer_items (
  id            uuid primary key default gen_random_uuid(),
  transfer_id   uuid not null references public.stock_transfers (id),
  material_id   uuid not null references public.raw_materials (id),
  qty_sent      numeric(14,3) not null check (qty_sent > 0),
  qty_received  numeric(14,3) check (qty_received >= 0),
  unique (transfer_id, material_id)
);

create table public.stock_counts (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations (id),
  counted_by   uuid not null references public.profiles (id),
  counted_at   timestamptz not null default now(),
  status       public.count_status not null default 'draft',
  notes        text,
  posted_at    timestamptz,
  created_at   timestamptz not null default now()
);
create index stock_counts_location_idx on public.stock_counts (location_id, counted_at desc);

create table public.stock_count_items (
  id            uuid primary key default gen_random_uuid(),
  count_id      uuid not null references public.stock_counts (id),
  material_id   uuid not null references public.raw_materials (id),
  expected_qty  numeric(14,3) not null,
  counted_qty   numeric(14,3) not null check (counted_qty >= 0),
  variance      numeric(14,3) generated always as (counted_qty - expected_qty) stored,
  unique (count_id, material_id)
);

-- ---------------------------------------------------------------------------
-- Ledger (source of truth) + cached balances
-- One row = one effect at one location. A transfer is two rows (OUT + IN).
-- ---------------------------------------------------------------------------
create table public.stock_movements (
  id                    uuid primary key default gen_random_uuid(),
  material_id           uuid not null references public.raw_materials (id),
  location_id           uuid not null references public.locations (id),
  qty_delta             numeric(14,3) not null check (qty_delta <> 0),
  movement_type         public.movement_type not null,
  unit_cost             numeric(14,4),
  ref_type              text not null check (ref_type in
                          ('order_item', 'receipt_item', 'wastage', 'transfer_item', 'count_item', 'adjustment', 'opening')),
  ref_id                uuid,
  reverses_movement_id  uuid references public.stock_movements (id),
  created_by            uuid references public.profiles (id),
  occurred_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  notes                 text
);
create index stock_movements_loc_mat_time_idx on public.stock_movements (location_id, material_id, occurred_at);
create index stock_movements_mat_time_idx on public.stock_movements (material_id, occurred_at);
create index stock_movements_time_idx on public.stock_movements (occurred_at);
create index stock_movements_ref_idx on public.stock_movements (ref_type, ref_id);
create unique index stock_movements_single_reversal on public.stock_movements (reverses_movement_id)
  where reverses_movement_id is not null;

create table public.stock_levels (
  location_id  uuid not null references public.locations (id),
  material_id  uuid not null references public.raw_materials (id),
  quantity     numeric(14,3) not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (location_id, material_id)
);
create index stock_levels_material_idx on public.stock_levels (material_id);

create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  action      text not null,
  entity      text not null,
  entity_id   text,
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_entity_idx on public.audit_logs (entity, entity_id);
create index audit_logs_time_idx on public.audit_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger set_updated_at before update on public.locations                  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.profiles                   for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.app_settings               for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.suppliers                  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.raw_materials              for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.location_material_settings for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.products                   for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.stock_requests             for each row execute function public.set_updated_at();
