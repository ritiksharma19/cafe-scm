-- =============================================================================
-- Cafe SCM — several businesses in one installation (SaaS)
--
--  * businesses: one row per customer (cafe / restaurant chain). Every master,
--    document and ledger table carries business_id. Existing data becomes the
--    first business.
--  * Isolation is enforced three ways:
--      1. RLS: every policy is scoped to the caller's business.
--      2. enforce_business(): a trigger on every business-owned table that
--         (a) fills business_id, (b) rejects references to another business's
--         rows (a product, material, location, supplier …), and (c) rejects any
--         write by a signed-in user to a business that is not theirs. So even a
--         function that forgets a check cannot touch another business's data.
--      3. Admin analytics resolve the caller's business and filter by it.
--  * app_settings becomes a per-business table (business_settings); a view named
--    app_settings shows the caller's own row, so existing code keeps working.
--  * Platform admins (the product owner) create, rename, limit and suspend
--    businesses. A suspended business cannot read or write anything.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Businesses and platform admins
-- ---------------------------------------------------------------------------
create table public.businesses (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9]{3,16}$'),   -- typed on the login screen
  name        text not null check (length(trim(name)) between 1 and 60),
  status      text not null default 'active' check (status in ('active', 'suspended')),
  plan        text not null default 'standard',
  cart_limit  int check (cart_limit is null or cart_limit >= 1),        -- null = unlimited
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger set_updated_at before update on public.businesses for each row execute function public.set_updated_at();

-- The existing data becomes business #1. Its login code comes from the business name.
insert into public.businesses (code, name)
select case when length(c.code) >= 3 then c.code else 'CAFE1' end, left(s.business_name, 60)
  from public.app_settings s
 cross join lateral (select left(regexp_replace(upper(s.business_name), '[^A-Z0-9]', '', 'g'), 12) as code) c;

-- ---------------------------------------------------------------------------
-- business_id everywhere. Added with the first business as a default (no table
-- rewrite, no triggers fired on append-only tables), then the default is dropped.
-- ---------------------------------------------------------------------------
do $$
declare
  v_biz uuid := (select id from public.businesses order by created_at limit 1);
  t     text;
begin
  foreach t in array array[
    'locations', 'profiles', 'suppliers', 'raw_materials', 'products', 'product_recipes',
    'orders', 'purchase_receipts', 'wastage', 'stock_requests', 'stock_transfers', 'stock_counts',
    'expenses', 'stock_movements', 'stock_levels', 'app_settings'
  ] loop
    execute format('alter table public.%I add column business_id uuid not null default %L references public.businesses (id)', t, v_biz);
    execute format('alter table public.%I alter column business_id drop default', t);
    execute format('create index %I on public.%I (business_id)', t || '_business_idx', t);
  end loop;
  execute format('alter table public.audit_logs add column business_id uuid default %L references public.businesses (id)', v_biz);
  alter table public.audit_logs alter column business_id drop default;
end;
$$;

create index orders_business_time_idx on public.orders (business_id, occurred_at desc);
create index stock_movements_business_time_idx on public.stock_movements (business_id, occurred_at);
create index audit_logs_business_idx on public.audit_logs (business_id, created_at desc);

-- Uniqueness is per business: two cafes may both have "Cart 1", "Burger", "ravi".
alter table public.locations drop constraint locations_code_key;
create unique index locations_code_key on public.locations (business_id, code);
drop index public.locations_single_central;
create unique index locations_single_central on public.locations (business_id) where type = 'central';
drop index public.locations_name_key;
create unique index locations_name_key on public.locations (business_id, lower(name));
drop index public.profiles_username_key;
create unique index profiles_username_key on public.profiles (business_id, lower(username));
drop index public.suppliers_name_key;
create unique index suppliers_name_key on public.suppliers (business_id, lower(name));
drop index public.raw_materials_name_key;
create unique index raw_materials_name_key on public.raw_materials (business_id, lower(name));
alter table public.raw_materials drop constraint raw_materials_sku_key;
create unique index raw_materials_sku_key on public.raw_materials (business_id, sku);
drop index public.products_name_key;
create unique index products_name_key on public.products (business_id, lower(name));

create table public.platform_admins (
  user_id     uuid primary key references public.profiles (id),
  created_at  timestamptz not null default now()
);
-- Today's owner account(s) run the platform.
insert into public.platform_admins (user_id) select id from public.profiles where role = 'admin' and is_active;

-- ---------------------------------------------------------------------------
-- Settings per business. The table is renamed; a view with the old name shows
-- only the caller's row, so functions reading public.app_settings get their own
-- business's settings without being rewritten.
-- ---------------------------------------------------------------------------
alter table public.app_settings rename to business_settings;
alter table public.business_settings drop constraint app_settings_pkey;
alter table public.business_settings drop column id;
alter table public.business_settings add primary key (business_id);
drop index public.app_settings_business_idx;

-- ---------------------------------------------------------------------------
-- Identity helpers (now business-aware). A suspended business behaves like a
-- signed-out user for every policy.
-- ---------------------------------------------------------------------------
create function public.my_business_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.business_id
    from public.profiles p join public.businesses b on b.id = p.business_id
   where p.id = auth.uid() and p.is_active and b.status = 'active'
$$;

create or replace function public.current_role_name() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select p.role
    from public.profiles p join public.businesses b on b.id = p.business_id
   where p.id = auth.uid() and p.is_active and b.status = 'active'
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role = 'admin'
                     from public.profiles p join public.businesses b on b.id = p.business_id
                    where p.id = auth.uid() and p.is_active and b.status = 'active'), false)
$$;

create or replace function public.my_location_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.location_id
    from public.profiles p join public.businesses b on b.id = p.business_id
   where p.id = auth.uid() and p.is_active and b.status = 'active'
$$;

-- Admin: any location of their business. Worker: their own cart.
create or replace function public.can_access_location(p_location_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_location_id is not null
     and exists (select 1 from public.locations l where l.id = p_location_id and l.business_id = public.my_business_id())
     and (public.is_admin() or p_location_id = public.my_location_id())
$$;

create function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins pa join public.profiles p on p.id = pa.user_id
                  where pa.user_id = auth.uid() and p.is_active)
$$;

create or replace function public.require_profile() returns public.profiles
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.profiles;
begin
  select * into v from public.profiles where id = auth.uid() and is_active;
  if not found then
    raise exception 'Not signed in or account disabled' using errcode = '42501';
  end if;
  if not exists (select 1 from public.businesses where id = v.business_id and status = 'active') then
    raise exception 'This business account is suspended. Please contact support.' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- Admin analytics: the caller's business id; a location filter must be one of theirs.
create function public.admin_scope(p_location_id uuid default null) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_admin public.profiles := public.require_admin();
begin
  if p_location_id is not null
     and not exists (select 1 from public.locations where id = p_location_id and business_id = v_admin.business_id) then
    raise exception 'Unknown location' using errcode = '22023';
  end if;
  return v_admin.business_id;
end;
$$;

-- The signed-in user's business, even when suspended (so the app can say so).
create function public.current_business() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'status', b.status, 'plan', b.plan,
                            'cart_limit', b.cart_limit, 'is_platform_admin', public.is_platform_admin())
    from public.profiles p join public.businesses b on b.id = p.business_id
   where p.id = auth.uid() and p.is_active
$$;

create view public.app_settings with (security_invoker = true) as
  select * from public.business_settings where business_id = public.my_business_id();

-- The business name lives on businesses; Settings edits it through business_settings.
create function public.sync_business_name() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.businesses set name = new.business_name where id = new.business_id and name <> new.business_name;
  return new;
end;
$$;
create trigger sync_business_name after update of business_name on public.business_settings
  for each row execute function public.sync_business_name();

-- ---------------------------------------------------------------------------
-- enforce_business(): the isolation guard.
--   tg_argv[0]  'own'   = table has business_id (filled in when missing)
--               'child' = line table; its business is its parent's (first pair)
--   then pairs  (column, referenced table), e.g. 'location_id', 'locations'
-- ---------------------------------------------------------------------------
create function public.enforce_business() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new    jsonb := to_jsonb(new);
  v_old    jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_own    boolean := tg_argv[0] = 'own';
  v_biz    uuid := case when v_own then (v_new ->> 'business_id')::uuid end;
  v_ref    text;
  v_refbiz uuid;
  i        int := 1;
begin
  while i < tg_nargs loop
    v_ref := v_new ->> tg_argv[i];
    -- A child row always resolves its parent; other references only when new or changed.
    if v_ref is not null
       and (tg_op = 'INSERT' or (not v_own and i = 1) or v_ref is distinct from v_old ->> tg_argv[i]) then
      execute format('select business_id from public.%I where id = $1', tg_argv[i + 1]) into v_refbiz using v_ref::uuid;
      if v_refbiz is not null then
        if v_biz is null then
          v_biz := v_refbiz;
        elsif v_biz <> v_refbiz then
          raise exception 'Not allowed: % belongs to another business', replace(tg_argv[i], '_id', '')
            using errcode = '42501';
        end if;
      end if;
    end if;
    i := i + 2;
  end loop;

  if v_own then
    if tg_op = 'UPDATE' and v_biz is distinct from (v_old ->> 'business_id')::uuid then
      raise exception 'A record cannot move to another business' using errcode = '42501';
    end if;
    v_biz := coalesce(v_biz, public.my_business_id());
    if v_biz is null then
      raise exception 'business_id is required for %', tg_table_name using errcode = '23502';
    end if;
    new.business_id := v_biz;
  end if;

  -- A signed-in user writes only to their own business (platform operations excepted).
  if auth.uid() is not null
     and v_biz is distinct from public.my_business_id()
     and coalesce(current_setting('app.platform_op', true), '') <> 'on' then
    raise exception 'Not allowed: this belongs to another business' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger enforce_business before insert or update on public.locations          for each row execute function public.enforce_business('own');
create trigger enforce_business before insert or update on public.business_settings  for each row execute function public.enforce_business('own');
create trigger enforce_business before insert or update on public.profiles           for each row execute function public.enforce_business('own', 'location_id', 'locations');
create trigger enforce_business before insert or update on public.suppliers          for each row execute function public.enforce_business('own');
create trigger enforce_business before insert or update on public.raw_materials      for each row execute function public.enforce_business('own', 'default_supplier_id', 'suppliers');
create trigger enforce_business before insert or update on public.products           for each row execute function public.enforce_business('own');
create trigger enforce_business before insert or update on public.product_recipes    for each row execute function public.enforce_business('own', 'product_id', 'products');
create trigger enforce_business before insert or update on public.orders             for each row execute function public.enforce_business('own', 'location_id', 'locations', 'worker_id', 'profiles');
create trigger enforce_business before insert or update on public.purchase_receipts  for each row execute function public.enforce_business('own', 'location_id', 'locations', 'supplier_id', 'suppliers', 'received_by', 'profiles');
create trigger enforce_business before insert or update on public.wastage            for each row execute function public.enforce_business('own', 'location_id', 'locations', 'material_id', 'raw_materials');
create trigger enforce_business before insert or update on public.stock_requests     for each row execute function public.enforce_business('own', 'location_id', 'locations');
create trigger enforce_business before insert or update on public.stock_transfers    for each row execute function public.enforce_business('own', 'from_location_id', 'locations', 'to_location_id', 'locations');
create trigger enforce_business before insert or update on public.stock_counts       for each row execute function public.enforce_business('own', 'location_id', 'locations');
create trigger enforce_business before insert or update on public.expenses           for each row execute function public.enforce_business('own', 'location_id', 'locations');
create trigger enforce_business before insert or update on public.stock_movements    for each row execute function public.enforce_business('own', 'location_id', 'locations', 'material_id', 'raw_materials');
create trigger enforce_business before insert or update on public.stock_levels       for each row execute function public.enforce_business('own', 'location_id', 'locations', 'material_id', 'raw_materials');

create trigger enforce_business before insert or update on public.order_items            for each row execute function public.enforce_business('child', 'order_id', 'orders', 'product_id', 'products', 'recipe_id', 'product_recipes');
create trigger enforce_business before insert or update on public.recipe_items           for each row execute function public.enforce_business('child', 'recipe_id', 'product_recipes', 'material_id', 'raw_materials');
create trigger enforce_business before insert or update on public.purchase_receipt_items for each row execute function public.enforce_business('child', 'receipt_id', 'purchase_receipts', 'material_id', 'raw_materials');
create trigger enforce_business before insert or update on public.stock_request_items    for each row execute function public.enforce_business('child', 'request_id', 'stock_requests', 'material_id', 'raw_materials');
create trigger enforce_business before insert or update on public.stock_transfer_items   for each row execute function public.enforce_business('child', 'transfer_id', 'stock_transfers', 'material_id', 'raw_materials');
create trigger enforce_business before insert or update on public.stock_count_items      for each row execute function public.enforce_business('child', 'count_id', 'stock_counts', 'material_id', 'raw_materials');
create trigger enforce_business before insert or update on public.material_unit_conversions  for each row execute function public.enforce_business('child', 'material_id', 'raw_materials');
create trigger enforce_business before insert or update on public.location_material_settings for each row execute function public.enforce_business('child', 'location_id', 'locations', 'material_id', 'raw_materials');

-- ---------------------------------------------------------------------------
-- Audit trail records which business a change belongs to.
-- ---------------------------------------------------------------------------
create or replace function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_j jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_j jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  row_j jsonb := coalesce(new_j, old_j);
begin
  if tg_op = 'UPDATE' and old_j = new_j then
    return new;
  end if;
  insert into public.audit_logs (actor_id, action, entity, entity_id, old_value, new_value, business_id)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    case when tg_table_name = 'business_settings' then row_j ->> 'business_id'
         else coalesce(row_j ->> 'id', row_j ->> 'code', concat_ws(':', row_j ->> 'location_id', row_j ->> 'material_id')) end,
    old_j,
    new_j,
    coalesce((row_j ->> 'business_id')::uuid,
             case when tg_table_name = 'businesses' then (row_j ->> 'id')::uuid end,
             public.my_business_id())
  );
  return coalesce(new, old);
end;
$$;

create function public.audit_log_business() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.business_id := coalesce(new.business_id, public.my_business_id(),
                              (select business_id from public.profiles where id = new.actor_id));
  return new;
end;
$$;
create trigger audit_log_business before insert on public.audit_logs for each row execute function public.audit_log_business();
create trigger audit after insert or update on public.businesses for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------------
-- Row level security, scoped to the business
-- ---------------------------------------------------------------------------
alter table public.businesses enable row level security;
alter table public.platform_admins enable row level security;   -- no policies: functions only

create policy read_own on public.businesses for select to authenticated
  using (id = (select public.my_business_id()) or public.is_platform_admin());

do $$
declare
  t text;
begin
  foreach t in array array['locations', 'business_settings', 'suppliers', 'raw_materials', 'products', 'product_recipes'] loop
    execute format('drop policy if exists read_all on public.%I', t);
    execute format('create policy read_all on public.%I for select to authenticated
                      using (public.current_role_name() is not null and business_id = (select public.my_business_id()))', t);
  end loop;
  foreach t in array array['locations', 'suppliers', 'raw_materials', 'products'] loop
    execute format('drop policy admin_insert on public.%I', t);
    execute format('drop policy admin_update on public.%I', t);
    execute format('create policy admin_insert on public.%I for insert to authenticated
                      with check (public.is_admin() and business_id = (select public.my_business_id()))', t);
    execute format('create policy admin_update on public.%I for update to authenticated
                      using (public.is_admin() and business_id = (select public.my_business_id()))
                      with check (public.is_admin() and business_id = (select public.my_business_id()))', t);
  end loop;
end;
$$;

drop policy admin_update on public.business_settings;
create policy admin_update on public.business_settings for update to authenticated
  using (public.is_admin() and business_id = (select public.my_business_id()))
  with check (public.is_admin() and business_id = (select public.my_business_id()));

drop policy read_all on public.recipe_items;
create policy read_all on public.recipe_items for select to authenticated using (
  exists (select 1 from public.product_recipes r where r.id = recipe_id and r.business_id = (select public.my_business_id())));

drop policy read_all on public.material_unit_conversions;
drop policy admin_all on public.material_unit_conversions;
create policy read_all on public.material_unit_conversions for select to authenticated using (
  exists (select 1 from public.raw_materials m where m.id = material_id and m.business_id = (select public.my_business_id())));
create policy admin_all on public.material_unit_conversions for all to authenticated
  using (public.is_admin() and exists (select 1 from public.raw_materials m where m.id = material_id and m.business_id = (select public.my_business_id())))
  with check (public.is_admin() and exists (select 1 from public.raw_materials m where m.id = material_id and m.business_id = (select public.my_business_id())));

drop policy read_all on public.location_material_settings;
drop policy admin_all on public.location_material_settings;
create policy read_all on public.location_material_settings for select to authenticated using (
  exists (select 1 from public.locations l where l.id = location_id and l.business_id = (select public.my_business_id())));
create policy admin_all on public.location_material_settings for all to authenticated
  using (public.is_admin() and exists (select 1 from public.locations l where l.id = location_id and l.business_id = (select public.my_business_id())))
  with check (public.is_admin() and exists (select 1 from public.locations l where l.id = location_id and l.business_id = (select public.my_business_id())));

-- Units are shared by every business; only the platform may change them.
drop policy admin_insert on public.units;
drop policy admin_update on public.units;
create policy platform_insert on public.units for insert to authenticated with check (public.is_platform_admin());
create policy platform_update on public.units for update to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy read_self_or_admin on public.profiles;
create policy read_self_or_admin on public.profiles for select to authenticated
  using (id = auth.uid() or (public.is_admin() and business_id = (select public.my_business_id())));

drop policy read_scoped on public.expenses;
create policy read_scoped on public.expenses for select to authenticated
  using (business_id = (select public.my_business_id()) and (public.is_admin() or location_id = public.my_location_id()));

drop policy admin_read on public.audit_logs;
create policy admin_read on public.audit_logs for select to authenticated
  using (public.is_admin() and business_id = (select public.my_business_id()));

-- ---------------------------------------------------------------------------
-- Functions that look things up by name or scan whole tables, now per business
-- ---------------------------------------------------------------------------

-- Workers always act on their own cart; admins must name an active location of their business.
create or replace function public.resolve_location(p_profile public.profiles, p_location_id uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_profile.role = 'worker' then
    if p_location_id is not null and p_location_id <> p_profile.location_id then
      raise exception 'Workers can only record stock for their own cart' using errcode = '42501';
    end if;
    return p_profile.location_id;
  end if;
  if p_location_id is null or not exists (
       select 1 from public.locations where id = p_location_id and is_active and business_id = p_profile.business_id) then
    raise exception 'Choose a valid location' using errcode = '22023';
  end if;
  return p_location_id;
end;
$$;

create or replace function public.import_recipe_sheet(p_sheet jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin        public.profiles := public.require_admin();
  v_biz          uuid := v_admin.business_id;
  v_mat          record;
  v_prod         record;
  v_existing     public.raw_materials;
  v_product      public.products;
  v_current      uuid;
  v_items        jsonb;
  v_same         boolean;
  v_next_sort    int;
  n_mat_created  int := 0;
  n_prod_created int := 0;
  n_rec_created  int := 0;
  n_rec_same     int := 0;
  n_prices       int := 0;
begin
  for v_mat in
    select trim(x.name) as name, x.base_unit
      from jsonb_to_recordset(coalesce(p_sheet -> 'materials', '[]'::jsonb)) as x(name text, base_unit text)
  loop
    if v_mat.base_unit not in ('g', 'ml', 'pcs') then
      raise exception 'Material "%": unsupported unit %', v_mat.name, v_mat.base_unit using errcode = '22023';
    end if;
    select * into v_existing from public.raw_materials where business_id = v_biz and lower(name) = lower(v_mat.name);
    if not found then
      insert into public.raw_materials (business_id, name, base_unit, display_unit)
      values (v_biz, v_mat.name, v_mat.base_unit,
              case v_mat.base_unit when 'g' then 'kg' when 'ml' then 'l' else 'pcs' end);
      n_mat_created := n_mat_created + 1;
    elsif v_existing.base_unit <> v_mat.base_unit then
      raise exception 'Material "%" is measured in % in the app but % in the sheet',
        v_existing.name, v_existing.base_unit, v_mat.base_unit using errcode = '22023';
    end if;
  end loop;

  for v_prod in
    select trim(x.name) as name, x.items, x.selling_price
      from jsonb_to_recordset(coalesce(p_sheet -> 'products', '[]'::jsonb))
           as x(name text, items jsonb, selling_price numeric)
  loop
    if v_prod.selling_price is not null and v_prod.selling_price < 0 then
      raise exception 'Product "%": price cannot be negative', v_prod.name using errcode = '22023';
    end if;

    select * into v_product from public.products where business_id = v_biz and lower(name) = lower(v_prod.name);
    if not found then
      select coalesce(max(sort_order), 0) + 1 into v_next_sort from public.products where business_id = v_biz;
      insert into public.products (business_id, name, sort_order, selling_price)
      values (v_biz, v_prod.name, v_next_sort, coalesce(round(v_prod.selling_price, 2), 0))
      returning * into v_product;
      n_prod_created := n_prod_created + 1;
    elsif v_prod.selling_price is not null and v_product.selling_price <> round(v_prod.selling_price, 2) then
      update public.products set selling_price = round(v_prod.selling_price, 2) where id = v_product.id;
      n_prices := n_prices + 1;
    end if;

    select jsonb_agg(jsonb_build_object(
             'material_id', m.id,
             'quantity', (i ->> 'quantity')::numeric,
             'entered_qty', i ->> 'entered_qty',
             'entered_unit', i ->> 'entered_unit'))
      into v_items
      from jsonb_array_elements(v_prod.items) i
      join public.raw_materials m on m.business_id = v_biz and lower(m.name) = lower(trim(i ->> 'material'));

    if coalesce(jsonb_array_length(v_items), 0) <> coalesce(jsonb_array_length(v_prod.items), 0)
       or v_items is null then
      raise exception 'Product "%": an ingredient is not in the materials list', v_prod.name using errcode = '22023';
    end if;

    select id into v_current from public.product_recipes
     where product_id = v_product.id and effective_to is null;

    v_same := v_current is not null
      and (select count(*) from public.recipe_items where recipe_id = v_current) = jsonb_array_length(v_items)
      and not exists (
        select 1 from jsonb_array_elements(v_items) i
         where not exists (
           select 1 from public.recipe_items ri
            where ri.recipe_id = v_current
              and ri.material_id = (i ->> 'material_id')::uuid
              and ri.quantity = round((i ->> 'quantity')::numeric, 3)));

    if v_same then
      n_rec_same := n_rec_same + 1;
    else
      perform public.save_recipe(v_product.id, v_items, 'Imported from recipe sheet');
      n_rec_created := n_rec_created + 1;
    end if;
  end loop;

  insert into public.audit_logs (actor_id, action, entity, entity_id, new_value)
  values (v_admin.id, 'import', 'recipe_sheet', null, jsonb_build_object(
    'materials_created', n_mat_created, 'products_created', n_prod_created,
    'recipes_created', n_rec_created, 'recipes_unchanged', n_rec_same, 'prices_updated', n_prices));

  return jsonb_build_object(
    'materials_created', n_mat_created, 'products_created', n_prod_created,
    'recipes_created', n_rec_created, 'recipes_unchanged', n_rec_same, 'prices_updated', n_prices);
end;
$$;

create or replace function public.verify_stock_levels()
returns table (location_id uuid, material_id uuid, cached numeric, ledger numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_biz uuid := public.admin_scope(null);
begin
  return query
    select coalesce(sl.location_id, l.location_id), coalesce(sl.material_id, l.material_id),
           coalesce(sl.quantity, 0), coalesce(l.qty, 0)
      from (select * from public.stock_levels x where x.business_id = v_biz) sl
      full join (select sm.location_id, sm.material_id, sum(sm.qty_delta) as qty
                   from public.stock_movements sm where sm.business_id = v_biz group by 1, 2) l
        on l.location_id = sl.location_id and l.material_id = sl.material_id
     where coalesce(sl.quantity, 0) <> coalesce(l.qty, 0);
end;
$$;

-- Adding a cart respects the business's plan limit; codes and names are per business.
create or replace function public.admin_save_location(
  p_id         uuid,
  p_name       text,
  p_sort_order int default null,
  p_is_active  boolean default true
) returns public.locations
language plpgsql security definer set search_path = '' as $$
declare
  v_admin public.profiles := public.require_admin();
  v_biz   uuid := v_admin.business_id;
  v_limit int := (select cart_limit from public.businesses where id = v_admin.business_id);
  v_name  text := trim(coalesce(p_name, ''));
  v_loc   public.locations;
  v_n     int;
  v_code  text;
begin
  if v_name = '' or length(v_name) > 40 then
    raise exception 'Enter a name (up to 40 characters)' using errcode = '22023';
  end if;
  if exists (select 1 from public.locations
              where business_id = v_biz and lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'A location called "%" already exists', v_name using errcode = '23505';
  end if;

  if p_id is null then
    if v_limit is not null
       and (select count(*) from public.locations where business_id = v_biz and type = 'cart' and is_active) >= v_limit then
      raise exception 'Your plan allows % active cart(s). Contact support to add more.', v_limit using errcode = '22023';
    end if;
    select coalesce(max(nullif(regexp_replace(code, '^CART', ''), '')::int), 0) + 1 into v_n
      from public.locations where business_id = v_biz and code ~ '^CART[0-9]+$';
    v_code := 'CART' || v_n;
    insert into public.locations (business_id, code, name, type, sort_order, is_active)
    values (v_biz, v_code, v_name, 'cart',
            coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 1 from public.locations where business_id = v_biz)), true)
    returning * into v_loc;
    return v_loc;
  end if;

  select * into v_loc from public.locations where id = p_id and business_id = v_biz for update;
  if not found then
    raise exception 'Location not found' using errcode = 'P0002';
  end if;

  if not v_loc.is_active and coalesce(p_is_active, true) and v_loc.type = 'cart' and v_limit is not null
     and (select count(*) from public.locations where business_id = v_biz and type = 'cart' and is_active) >= v_limit then
    raise exception 'Your plan allows % active cart(s). Contact support to add more.', v_limit using errcode = '22023';
  end if;

  if v_loc.is_active and not coalesce(p_is_active, true) then
    if v_loc.type = 'central' then
      raise exception 'Central Storage cannot be deactivated' using errcode = '22023';
    end if;
    select count(*) into v_n from public.profiles where location_id = p_id and is_active;
    if v_n > 0 then
      raise exception 'Move or disable the % worker(s) at % first', v_n, v_loc.name using errcode = '22023';
    end if;
    if exists (select 1 from public.stock_levels where location_id = p_id and quantity <> 0) then
      raise exception '% still holds stock. Send it to another location (or count it to zero) first', v_loc.name
        using errcode = '22023';
    end if;
    if exists (select 1 from public.stock_transfers
                where status = 'in_transit' and (from_location_id = p_id or to_location_id = p_id)) then
      raise exception '% has transfers on the way. Receive or cancel them first', v_loc.name using errcode = '22023';
    end if;
  end if;

  update public.locations
     set name = v_name,
         sort_order = coalesce(p_sort_order, sort_order),
         is_active = coalesce(p_is_active, true)
   where id = p_id
  returning * into v_loc;
  return v_loc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Analytics, scoped to the caller's business
-- ---------------------------------------------------------------------------
create or replace function public.stock_status(p_location_id uuid default null)
returns table (
  material_id       uuid,
  name              text,
  base_unit         text,
  display_unit      text,
  quantity          numeric,
  avg_daily_use     numeric,
  days_of_data      int,
  days_left         numeric,
  min_level         numeric,
  reorder_level     numeric,
  target_level      numeric,
  lead_time_days    int,
  status            text,
  suggested_reorder numeric,
  unit_cost         numeric,
  stock_value       numeric
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(p_location_id);
  s     public.app_settings;
begin
  select * into s from public.app_settings;

  return query
  with qty as (
    select m.id as mid, coalesce(sum(sl.quantity), 0) as q, count(sl.material_id) as held
      from public.raw_materials m
      left join public.stock_levels sl
        on sl.material_id = m.id and (p_location_id is null or sl.location_id = p_location_id)
     where m.is_active and m.business_id = v_biz
     group by m.id
  ),
  usage_w as (
    select sm.material_id as mid,
           sum(-sm.qty_delta) as used,
           count(distinct (sm.occurred_at at time zone s.timezone)::date)::int as days
      from public.stock_movements sm
     where sm.business_id = v_biz
       and sm.movement_type in ('SALE_CONSUMPTION', 'SALE_REVERSAL', 'WASTAGE', 'WASTAGE_REVERSAL')
       and sm.occurred_at >= now() - make_interval(days => s.runway_window_days)
       and (p_location_id is null or sm.location_id = p_location_id)
     group by sm.material_id
  ),
  first_use as (
    select sm.material_id as mid, min(sm.occurred_at) as first_at
      from public.stock_movements sm
     where sm.business_id = v_biz
       and sm.movement_type in ('SALE_CONSUMPTION', 'WASTAGE')
       and (p_location_id is null or sm.location_id = p_location_id)
     group by sm.material_id
  ),
  base as (
    select m.id as mid, m.name as mname, m.base_unit as bu, m.display_unit as du, m.lead_time_days as lead,
           m.avg_unit_cost as cost, q.q,
           coalesce(u.days, 0) as days,
           case when p_location_id is null then m.min_level     else lms.min_level     end as min_l,
           case when p_location_id is null then m.reorder_level else lms.reorder_level end as reorder_l,
           case when p_location_id is null then m.target_level  else lms.target_level  end as target_l,
           case
             when coalesce(u.days, 0) < s.min_history_days or coalesce(u.used, 0) <= 0 then null
             else round(u.used / greatest(1, least(s.runway_window_days,
                        ceil(extract(epoch from (now() - f.first_at)) / 86400.0))), 3)
           end as avg_use,
           q.held
      from public.raw_materials m
      join qty q on q.mid = m.id
      left join usage_w u on u.mid = m.id
      left join first_use f on f.mid = m.id
      left join public.location_material_settings lms
        on lms.material_id = m.id and lms.location_id = p_location_id
  ),
  calc as (
    select b.*, case when b.avg_use > 0 then round(greatest(b.q, 0) / b.avg_use, 1) end as dleft
      from base b
     where b.held > 0 or b.days > 0 or coalesce(b.min_l, 0) > 0 or coalesce(b.reorder_l, 0) > 0
  )
  select c.mid, c.mname, c.bu, c.du, c.q, c.avg_use, c.days, c.dleft,
         c.min_l, c.reorder_l, c.target_l, c.lead,
         case
           when c.q < 0 then 'critical'
           when coalesce(c.min_l, 0) > 0 and c.q <= c.min_l then 'critical'
           when c.dleft is not null and c.dleft <= c.lead then 'critical'
           when coalesce(c.reorder_l, 0) > 0 and c.q <= c.reorder_l then 'low'
           when c.dleft is not null and c.dleft <= c.lead + 2 then 'low'
           when c.avg_use is null and coalesce(c.min_l, 0) = 0 and coalesce(c.reorder_l, 0) = 0 then 'unknown'
           else 'ok'
         end,
         case
           when c.target_l is not null then greatest(0, c.target_l - c.q)
           when c.avg_use is not null then greatest(0, ceil(c.avg_use * (c.lead + s.reorder_cover_days) - c.q))
         end,
         c.cost,
         round(greatest(c.q, 0) * c.cost, 2)
    from calc c
   order by c.mname;
end;
$$;

create or replace function public.dashboard_summary(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_biz       uuid := public.admin_scope(null);
  v_prev_from timestamptz := p_from - (p_to - p_from);
  v_result    jsonb;
begin
  if p_to <= p_from then
    raise exception 'Invalid period' using errcode = '22023';
  end if;

  with periods(label, f, t) as (values ('current', p_from, p_to), ('previous', v_prev_from, p_from)),
  ord as (
    select p.label, o.location_id, count(*) as orders, sum(o.item_count) as items, sum(o.total_amount) as sales
      from periods p join public.orders o
        on o.business_id = v_biz and o.status = 'completed' and o.occurred_at >= p.f and o.occurred_at < p.t
     group by 1, 2
  ),
  mov as (
    select p.label, sm.location_id,
           sum(case when sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL') then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as wastage_cost,
           sum(case when sm.movement_type in ('SALE_CONSUMPTION', 'SALE_REVERSAL') then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as consumption_cost
      from periods p join public.stock_movements sm
        on sm.business_id = v_biz and sm.occurred_at >= p.f and sm.occurred_at < p.t
       and sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL', 'SALE_CONSUMPTION', 'SALE_REVERSAL')
     group by 1, 2
  ),
  pur as (
    select p.label, sum(r.total_cost) as purchases
      from periods p join public.purchase_receipts r
        on r.business_id = v_biz and r.status = 'posted' and r.occurred_at >= p.f and r.occurred_at < p.t
     group by 1
  ),
  totals as (
    select p.label,
           coalesce((select sum(orders) from ord where ord.label = p.label), 0) as orders,
           coalesce((select sum(items) from ord where ord.label = p.label), 0) as items,
           coalesce((select sum(sales) from ord where ord.label = p.label), 0) as sales,
           round(coalesce((select sum(wastage_cost) from mov where mov.label = p.label), 0), 2) as wastage_cost,
           round(coalesce((select sum(consumption_cost) from mov where mov.label = p.label), 0), 2) as consumption_cost,
           coalesce((select purchases from pur where pur.label = p.label), 0) as purchases
      from periods p
  )
  select jsonb_build_object(
    'current',  (select to_jsonb(t) - 'label' from totals t where t.label = 'current'),
    'previous', (select to_jsonb(t) - 'label' from totals t where t.label = 'previous'),
    'carts', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'location_id', l.id, 'name', l.name,
               'orders', coalesce(o.orders, 0), 'items', coalesce(o.items, 0), 'sales', coalesce(o.sales, 0),
               'wastage_cost', round(coalesce(m.wastage_cost, 0), 2),
               'negative_items', (select count(*) from public.stock_levels sl where sl.location_id = l.id and sl.quantity < 0)
             ) order by l.sort_order), '[]'::jsonb)
        from public.locations l
        left join ord o on o.location_id = l.id and o.label = 'current'
        left join mov m on m.location_id = l.id and m.label = 'current'
       where l.business_id = v_biz and l.type = 'cart' and l.is_active),
    'pending_requests', (select count(*) from public.stock_requests where business_id = v_biz and status = 'pending'),
    'in_transit', (select count(*) from public.stock_transfers where business_id = v_biz and status = 'in_transit'),
    'oldest_in_transit', (select min(dispatched_at) from public.stock_transfers where business_id = v_biz and status = 'in_transit'),
    'stale_in_transit', (select count(*) from public.stock_transfers
                          where business_id = v_biz and status = 'in_transit' and dispatched_at < now() - interval '6 hours'),
    'counts_to_review', (select count(*) from public.stock_counts where business_id = v_biz and status = 'draft'),
    'negative_stock', (select count(*) from public.stock_levels where business_id = v_biz and quantity < 0)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.product_sales(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (product_id uuid, name text, quantity bigint, sales numeric, orders bigint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(p_location_id);
begin
  return query
    select p.id, p.name, sum(oi.quantity)::bigint, sum(oi.line_total), count(distinct o.id)
      from public.orders o
      join public.order_items oi on oi.order_id = o.id
      join public.products p on p.id = oi.product_id
     where o.business_id = v_biz and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
       and (p_location_id is null or o.location_id = p_location_id)
     group by p.id, p.name
     order by 3 desc, p.name;
end;
$$;

create or replace function public.material_flow(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (
  material_id uuid, name text, base_unit text, display_unit text,
  consumed numeric, consumed_cost numeric, wasted numeric, wasted_cost numeric,
  purchased numeric, purchased_cost numeric, transfer_in numeric, transfer_out numeric,
  count_adjust numeric, count_adjust_cost numeric, current_qty numeric
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(p_location_id);
begin
  return query
    with f as (
      select sm.material_id as mid,
        sum(case when sm.movement_type in ('SALE_CONSUMPTION', 'SALE_REVERSAL') then -sm.qty_delta else 0 end) as consumed,
        sum(case when sm.movement_type in ('SALE_CONSUMPTION', 'SALE_REVERSAL') then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as consumed_cost,
        sum(case when sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL') then -sm.qty_delta else 0 end) as wasted,
        sum(case when sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL') then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as wasted_cost,
        sum(case when sm.movement_type in ('PURCHASE', 'PURCHASE_REVERSAL') then sm.qty_delta else 0 end) as purchased,
        sum(case when sm.movement_type in ('PURCHASE', 'PURCHASE_REVERSAL') then sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as purchased_cost,
        sum(case when sm.movement_type = 'TRANSFER_IN' then sm.qty_delta else 0 end) as t_in,
        sum(case when sm.movement_type in ('TRANSFER_OUT', 'TRANSFER_CANCEL') then -sm.qty_delta else 0 end) as t_out,
        sum(case when sm.movement_type in ('COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT') then sm.qty_delta else 0 end) as adj,
        sum(case when sm.movement_type in ('COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT') then sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as adj_cost
      from public.stock_movements sm
      where sm.business_id = v_biz and sm.occurred_at >= p_from and sm.occurred_at < p_to
        and (p_location_id is null or sm.location_id = p_location_id)
      group by sm.material_id
    )
    select m.id, m.name, m.base_unit, m.display_unit,
           f.consumed, round(f.consumed_cost, 2), f.wasted, round(f.wasted_cost, 2),
           f.purchased, round(f.purchased_cost, 2), f.t_in, f.t_out, f.adj, round(f.adj_cost, 2),
           (select coalesce(sum(sl.quantity), 0) from public.stock_levels sl
             where sl.material_id = m.id and (p_location_id is null or sl.location_id = p_location_id))
      from f join public.raw_materials m on m.id = f.mid
     where f.consumed <> 0 or f.wasted <> 0 or f.purchased <> 0 or f.t_in <> 0 or f.t_out <> 0 or f.adj <> 0
     order by f.consumed_cost desc, m.name;
end;
$$;

create or replace function public.daily_trend(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (day date, orders bigint, items bigint, sales numeric, consumption_cost numeric, wastage_cost numeric, purchase_cost numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(p_location_id);
  tz    text := (select timezone from public.app_settings);
begin
  return query
    with days as (
      select generate_series((p_from at time zone tz)::date, ((p_to - interval '1 second') at time zone tz)::date, interval '1 day')::date as d
    ),
    o as (
      select (o.occurred_at at time zone tz)::date as d, count(*) as n, sum(o.item_count) as items, sum(o.total_amount) as sales
        from public.orders o
       where o.business_id = v_biz and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
         and (p_location_id is null or o.location_id = p_location_id)
       group by 1
    ),
    m as (
      select (sm.occurred_at at time zone tz)::date as d,
             sum(case when sm.movement_type in ('SALE_CONSUMPTION', 'SALE_REVERSAL') then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as cc,
             sum(case when sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL') then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as wc
        from public.stock_movements sm
       where sm.business_id = v_biz and sm.occurred_at >= p_from and sm.occurred_at < p_to
         and (p_location_id is null or sm.location_id = p_location_id)
       group by 1
    ),
    r as (
      select (r.occurred_at at time zone tz)::date as d, sum(r.total_cost) as pc
        from public.purchase_receipts r
       where r.business_id = v_biz and r.status = 'posted' and r.occurred_at >= p_from and r.occurred_at < p_to
         and (p_location_id is null or r.location_id = p_location_id)
       group by 1
    )
    select days.d, coalesce(o.n, 0), coalesce(o.items, 0)::bigint, coalesce(o.sales, 0),
           round(coalesce(m.cc, 0), 2), round(coalesce(m.wc, 0), 2), coalesce(r.pc, 0)
      from days
      left join o on o.d = days.d
      left join m on m.d = days.d
      left join r on r.d = days.d
     order by days.d;
end;
$$;

create or replace function public.hourly_orders(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (hour int, orders bigint, items bigint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(p_location_id);
  tz    text := (select timezone from public.app_settings);
begin
  return query
    select h::int, coalesce(x.n, 0), coalesce(x.items, 0)
      from generate_series(0, 23) h
      left join (
        select extract(hour from o.occurred_at at time zone tz)::int as hr, count(*) as n, sum(o.item_count)::bigint as items
          from public.orders o
         where o.business_id = v_biz and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
           and (p_location_id is null or o.location_id = p_location_id)
         group by 1
      ) x on x.hr = h
     order by h;
end;
$$;

create or replace function public.product_costs(p_compare_at timestamptz)
returns table (product_id uuid, name text, selling_price numeric, cost_now numeric, cost_then numeric,
               then_complete boolean, ingredients jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(null);
begin
  return query
    with p as (
      select pr.id, pr.name, pr.selling_price,
             public.recipe_version_at(pr.id, now()) as r_now,
             (select r.id from public.product_recipes r
               where r.product_id = pr.id and r.effective_from <= p_compare_at
               order by r.effective_from desc limit 1) as r_then
        from public.products pr
       where pr.is_active and pr.business_id = v_biz
    ),
    lines as (
      select p.id as pid, m.id as mid, m.name as mname, m.base_unit,
             ri_now.quantity as q_now, ri_then.quantity as q_then,
             m.avg_unit_cost as c_now, public.material_cost_at(m.id, p_compare_at) as c_then
        from p
        cross join lateral (
          select material_id from public.recipe_items where recipe_id in (p.r_now, p.r_then)
        ) mats
        join public.raw_materials m on m.id = mats.material_id
        left join public.recipe_items ri_now  on ri_now.recipe_id  = p.r_now  and ri_now.material_id  = m.id
        left join public.recipe_items ri_then on ri_then.recipe_id = p.r_then and ri_then.material_id = m.id
       group by p.id, m.id, m.name, m.base_unit, ri_now.quantity, ri_then.quantity, m.avg_unit_cost
    )
    select p.id, p.name, p.selling_price,
           round(coalesce((select sum(l.q_now * l.c_now) from lines l where l.pid = p.id), 0), 2),
           case when p.r_then is not null then
             round((select coalesce(sum(l.q_then * coalesce(l.c_then, 0)), 0) from lines l where l.pid = p.id and l.q_then is not null), 2)
           end,
           p.r_then is not null and not exists (
             select 1 from lines l where l.pid = p.id and l.q_then is not null and l.c_then is null and l.c_now > 0),
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'material', l.mname, 'base_unit', l.base_unit,
                     'qty_now', l.q_now, 'qty_then', l.q_then,
                     'cost_now', round(coalesce(l.q_now * l.c_now, 0), 2),
                     'cost_then', case when l.q_then is not null and l.c_then is not null then round(l.q_then * l.c_then, 2) end
                   ) order by coalesce(l.q_now * l.c_now, 0) desc), '[]'::jsonb)
              from lines l where l.pid = p.id)
      from p
     where p.r_now is not null
     order by p.name;
end;
$$;

create or replace function public.purchases_by_material(p_from timestamptz, p_to timestamptz)
returns table (material_id uuid, name text, base_unit text, display_unit text, quantity numeric, value numeric,
               receipts bigint, last_unit_cost numeric, last_date timestamptz, prev_unit_cost numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(null);
begin
  return query
    with items as (
      select ri.material_id as mid, ri.quantity as q, ri.line_cost as lc, ri.unit_cost as uc, r.occurred_at as at, r.id as rid
        from public.purchase_receipt_items ri
        join public.purchase_receipts r on r.id = ri.receipt_id
       where r.status = 'posted' and r.business_id = v_biz
    ),
    priced as (
      select i.mid, i.uc, i.at, row_number() over (partition by i.mid order by i.at desc) as rn
        from items i where i.uc is not null and i.at < p_to
    )
    select m.id, m.name, m.base_unit, m.display_unit,
           sum(i.q), coalesce(sum(i.lc), 0), count(distinct i.rid),
           (select pr.uc from priced pr where pr.mid = m.id and pr.rn = 1),
           (select pr.at from priced pr where pr.mid = m.id and pr.rn = 1),
           (select pr.uc from priced pr where pr.mid = m.id and pr.rn = 2)
      from items i join public.raw_materials m on m.id = i.mid
     where i.at >= p_from and i.at < p_to
     group by m.id, m.name, m.base_unit, m.display_unit
     order by 6 desc, m.name;
end;
$$;

create or replace function public.purchases_by_supplier(p_from timestamptz, p_to timestamptz)
returns table (supplier_id uuid, name text, receipts bigint, value numeric, materials text[], last_date timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(null);
begin
  return query
    select s.id, coalesce(s.name, 'Not specified'), count(distinct r.id), coalesce(sum(ri.line_cost), 0),
           array_agg(distinct m.name order by m.name), max(r.occurred_at)
      from public.purchase_receipts r
      join public.purchase_receipt_items ri on ri.receipt_id = r.id
      join public.raw_materials m on m.id = ri.material_id
      left join public.suppliers s on s.id = r.supplier_id
     where r.business_id = v_biz and r.status = 'posted' and r.occurred_at >= p_from and r.occurred_at < p_to
     group by s.id, s.name
     order by 4 desc;
end;
$$;

-- Profit: internal totals now take the business explicitly.
drop function public.profit_totals(timestamptz, timestamptz, uuid);

create function public.profit_totals(p_from timestamptz, p_to timestamptz, p_business_id uuid, p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  tz         text := (select timezone from public.business_settings where business_id = p_business_id);
  v_from_d   date := (p_from at time zone tz)::date;
  v_last_d   date := ((p_to - interval '1 microsecond') at time zone tz)::date;   -- inclusive
  v_orders   bigint;
  v_gross    numeric;
  v_disc     numeric;
  v_net      numeric;
  v_cogs     numeric;
  v_waste    numeric;
  v_var      numeric;
  v_exp      numeric;
  v_shared   numeric;
  v_gp       numeric;
  v_np       numeric;
begin
  select count(*), coalesce(sum(o.total_amount + o.discount_amount), 0), coalesce(sum(o.discount_amount), 0),
         coalesce(sum(o.total_amount), 0)
    into v_orders, v_gross, v_disc, v_net
    from public.orders o
   where o.business_id = p_business_id and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
     and (p_location_id is null or o.location_id = p_location_id);

  select coalesce(sum(-sm.qty_delta * coalesce(sm.unit_cost, 0)), 0) into v_cogs
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    join public.stock_movements sm on sm.ref_type = 'order_item' and sm.ref_id = oi.id and sm.movement_type = 'SALE_CONSUMPTION'
   where o.business_id = p_business_id and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
     and (p_location_id is null or o.location_id = p_location_id);

  select coalesce(sum(case when sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL')
                           then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end), 0),
         coalesce(sum(case when sm.movement_type in ('COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT')
                           then sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end), 0)
    into v_waste, v_var
    from public.stock_movements sm
   where sm.business_id = p_business_id and sm.occurred_at >= p_from and sm.occurred_at < p_to
     and sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL', 'COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT')
     and (p_location_id is null or sm.location_id = p_location_id);

  select coalesce(sum(e.amount) filter (where p_location_id is null or e.location_id = p_location_id), 0),
         coalesce(sum(e.amount) filter (where p_location_id is not null and e.location_id is null), 0)
    into v_exp, v_shared
    from public.expenses e
   where e.business_id = p_business_id and e.status = 'posted' and e.spent_on >= v_from_d and e.spent_on <= v_last_d;

  v_cogs  := round(v_cogs, 2);
  v_waste := round(v_waste, 2);
  v_var   := round(v_var, 2);
  v_gp    := v_net - v_cogs;
  v_np    := v_gp - v_waste + v_var - v_exp;

  return jsonb_build_object(
    'orders', v_orders,
    'gross_sales', v_gross,
    'discounts', v_disc,
    'net_sales', v_net,
    'cogs', v_cogs,
    'gross_profit', v_gp,
    'gross_margin_pct', case when v_net > 0 then round(v_gp / v_net * 100, 1) end,
    'wastage_cost', v_waste,
    'stock_variance', v_var,
    'expenses', v_exp,
    'shared_expenses', v_shared,
    'net_profit', v_np,
    'net_margin_pct', case when v_net > 0 then round(v_np / v_net * 100, 1) end
  );
end;
$$;

create or replace function public.profit_summary(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_biz    uuid := public.admin_scope(p_location_id);
  tz       text := (select timezone from public.app_settings);
  v_from_d date := (p_from at time zone tz)::date;
  v_last_d date := ((p_to - interval '1 microsecond') at time zone tz)::date;
begin
  if p_to <= p_from then
    raise exception 'Invalid period' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'current',  public.profit_totals(p_from, p_to, v_biz, p_location_id),
    'previous', public.profit_totals(p_from - (p_to - p_from), p_from, v_biz, p_location_id),

    'expenses_by_category', (
      select coalesce(jsonb_agg(jsonb_build_object('category', x.category, 'amount', x.amount) order by x.amount desc), '[]'::jsonb)
        from (select e.category, sum(e.amount) as amount
                from public.expenses e
               where e.business_id = v_biz and e.status = 'posted' and e.spent_on >= v_from_d and e.spent_on <= v_last_d
                 and (p_location_id is null or e.location_id = p_location_id)
               group by e.category) x),

    'payments', (
      select coalesce(jsonb_agg(jsonb_build_object('method', x.payment_method, 'orders', x.n, 'amount', x.amount)
                                order by x.amount desc), '[]'::jsonb)
        from (select o.payment_method, count(*) as n, sum(o.total_amount) as amount
                from public.orders o
               where o.business_id = v_biz and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
                 and (p_location_id is null or o.location_id = p_location_id)
               group by o.payment_method) x),

    'by_location', (
      select coalesce(jsonb_agg(public.profit_totals(p_from, p_to, v_biz, l.id)
                                || jsonb_build_object('location_id', l.id, 'name', l.name, 'type', l.type)
                                order by l.sort_order), '[]'::jsonb)
        from public.locations l
       where p_location_id is null and l.business_id = v_biz
         and (l.is_active or exists (select 1 from public.orders o where o.location_id = l.id
                                       and o.occurred_at >= p_from and o.occurred_at < p_to))),

    'daily', (
      with days as (
        select generate_series(v_from_d, v_last_d, interval '1 day')::date as d
      ),
      s as (
        select (o.occurred_at at time zone tz)::date as d, sum(o.total_amount) as net
          from public.orders o
         where o.business_id = v_biz and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
           and (p_location_id is null or o.location_id = p_location_id)
         group by 1
      ),
      c as (
        select (o.occurred_at at time zone tz)::date as d, sum(-sm.qty_delta * coalesce(sm.unit_cost, 0)) as cogs
          from public.orders o
          join public.order_items oi on oi.order_id = o.id
          join public.stock_movements sm on sm.ref_type = 'order_item' and sm.ref_id = oi.id and sm.movement_type = 'SALE_CONSUMPTION'
         where o.business_id = v_biz and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
           and (p_location_id is null or o.location_id = p_location_id)
         group by 1
      ),
      -- Wastage and stock-variance losses (a count that found extra stock is a negative loss).
      w as (
        select (sm.occurred_at at time zone tz)::date as d, sum(-sm.qty_delta * coalesce(sm.unit_cost, 0)) as loss
          from public.stock_movements sm
         where sm.business_id = v_biz and sm.occurred_at >= p_from and sm.occurred_at < p_to
           and sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL', 'COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT')
           and (p_location_id is null or sm.location_id = p_location_id)
         group by 1
      ),
      e as (
        select ex.spent_on as d, sum(ex.amount) as amount
          from public.expenses ex
         where ex.business_id = v_biz and ex.status = 'posted' and ex.spent_on >= v_from_d and ex.spent_on <= v_last_d
           and (p_location_id is null or ex.location_id = p_location_id)
         group by 1
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', days.d,
               'net_sales', coalesce(s.net, 0),
               'cogs', round(coalesce(c.cogs, 0), 2),
               'gross_profit', round(coalesce(s.net, 0) - coalesce(c.cogs, 0), 2),
               'stock_loss', round(coalesce(w.loss, 0), 2),
               'expenses', coalesce(e.amount, 0),
               'net_profit', round(coalesce(s.net, 0) - coalesce(c.cogs, 0) - coalesce(w.loss, 0) - coalesce(e.amount, 0), 2)
             ) order by days.d), '[]'::jsonb)
        from days
        left join s on s.d = days.d
        left join c on c.d = days.d
        left join w on w.d = days.d
        left join e on e.d = days.d)
  );
end;
$$;

create or replace function public.product_profit(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (product_id uuid, name text, category text, quantity bigint, sales numeric, cogs numeric,
               profit numeric, margin_pct numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(p_location_id);
begin
  return query
    with lines as (
      select oi.id, oi.product_id, oi.quantity, oi.line_total
        from public.orders o
        join public.order_items oi on oi.order_id = o.id
       where o.business_id = v_biz and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
         and (p_location_id is null or o.location_id = p_location_id)
    ),
    cost as (
      select l.id, sum(-sm.qty_delta * coalesce(sm.unit_cost, 0)) as c
        from lines l
        join public.stock_movements sm on sm.ref_type = 'order_item' and sm.ref_id = l.id and sm.movement_type = 'SALE_CONSUMPTION'
       group by l.id
    ),
    agg as (
      select l.product_id as pid, sum(l.quantity)::bigint as q, sum(l.line_total) as s, round(coalesce(sum(cost.c), 0), 2) as c
        from lines l left join cost on cost.id = l.id
       group by l.product_id
    )
    select p.id, p.name, p.category, agg.q, agg.s, agg.c, agg.s - agg.c,
           case when agg.s > 0 then round((agg.s - agg.c) / agg.s * 100, 1) end
      from agg join public.products p on p.id = agg.pid
     order by agg.s - agg.c desc, p.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Platform administration (the product owner)
-- ---------------------------------------------------------------------------
create function public.require_platform_admin() returns public.profiles
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.profiles := public.require_profile();
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin only' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- Creates a business with its settings, Central Storage and p_carts carts.
-- The owner's login is created next by the server (it needs the auth service).
create function public.platform_create_business(
  p_name       text,
  p_code       text,
  p_plan       text default 'standard',
  p_cart_limit int default null,
  p_carts      int default 1
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_admin public.profiles := public.require_platform_admin();
  v_code  text := upper(trim(coalesce(p_code, '')));
  v_name  text := trim(coalesce(p_name, ''));
  v_id    uuid;
  i       int;
begin
  if v_code !~ '^[A-Z0-9]{3,16}$' then
    raise exception 'Code: 3–16 letters or digits' using errcode = '22023';
  end if;
  if v_name = '' or length(v_name) > 60 then
    raise exception 'Enter a business name (up to 60 characters)' using errcode = '22023';
  end if;
  if exists (select 1 from public.businesses where code = v_code) then
    raise exception 'The code % is already taken', v_code using errcode = '23505';
  end if;
  if coalesce(p_carts, 0) < 0 or coalesce(p_carts, 0) > 50 or (p_cart_limit is not null and coalesce(p_carts, 0) > p_cart_limit) then
    raise exception 'Invalid number of carts' using errcode = '22023';
  end if;

  perform set_config('app.platform_op', 'on', true);
  insert into public.businesses (code, name, plan, cart_limit)
  values (v_code, v_name, coalesce(nullif(trim(p_plan), ''), 'standard'), p_cart_limit)
  returning id into v_id;
  insert into public.business_settings (business_id, business_name) values (v_id, v_name);
  insert into public.locations (business_id, code, name, type, sort_order) values (v_id, 'CENTRAL', 'Central Storage', 'central', 0);
  for i in 1 .. coalesce(p_carts, 0) loop
    insert into public.locations (business_id, code, name, type, sort_order) values (v_id, 'CART' || i, 'Cart ' || i, 'cart', i);
  end loop;
  perform set_config('app.platform_op', '', true);

  insert into public.audit_logs (actor_id, action, entity, entity_id, new_value, business_id)
  values (v_admin.id, 'create', 'businesses', v_id::text,
          jsonb_build_object('code', v_code, 'name', v_name, 'plan', p_plan, 'cart_limit', p_cart_limit), v_id);
  return v_id;
end;
$$;

create function public.platform_update_business(
  p_id         uuid,
  p_name       text,
  p_code       text,
  p_plan       text,
  p_cart_limit int,
  p_status     text,
  p_notes      text default null
) returns public.businesses
language plpgsql security definer set search_path = '' as $$
declare
  v_admin public.profiles := public.require_platform_admin();
  v_code  text := upper(trim(coalesce(p_code, '')));
  v_b     public.businesses;
begin
  if v_code !~ '^[A-Z0-9]{3,16}$' then
    raise exception 'Code: 3–16 letters or digits' using errcode = '22023';
  end if;
  if p_status not in ('active', 'suspended') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  if p_id = v_admin.business_id and p_status = 'suspended' then
    raise exception 'You cannot suspend your own business' using errcode = '22023';
  end if;
  if exists (select 1 from public.businesses where code = v_code and id <> p_id) then
    raise exception 'The code % is already taken', v_code using errcode = '23505';
  end if;

  update public.businesses
     set name = trim(p_name), code = v_code, plan = coalesce(nullif(trim(p_plan), ''), plan),
         cart_limit = p_cart_limit, status = p_status, notes = nullif(trim(p_notes), '')
   where id = p_id
  returning * into v_b;
  if not found then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;
  perform set_config('app.platform_op', 'on', true);
  update public.business_settings set business_name = v_b.name where business_id = p_id and business_name <> v_b.name;
  perform set_config('app.platform_op', '', true);
  return v_b;
end;
$$;

create function public.platform_businesses()
returns table (id uuid, code text, name text, status text, plan text, cart_limit int, notes text, created_at timestamptz,
               carts bigint, users bigint, orders_30d bigint, sales_30d numeric, last_order_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.require_platform_admin();
  return query
    select b.id, b.code, b.name, b.status, b.plan, b.cart_limit, b.notes, b.created_at,
           (select count(*) from public.locations l where l.business_id = b.id and l.type = 'cart' and l.is_active),
           (select count(*) from public.profiles p where p.business_id = b.id and p.is_active),
           (select count(*) from public.orders o where o.business_id = b.id and o.status = 'completed'
               and o.occurred_at >= now() - interval '30 days'),
           (select coalesce(sum(o.total_amount), 0) from public.orders o where o.business_id = b.id and o.status = 'completed'
               and o.occurred_at >= now() - interval '30 days'),
           (select max(o.occurred_at) from public.orders o where o.business_id = b.id)
      from public.businesses b
     order by b.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  public.enforce_business(), public.audit_log_business(), public.sync_business_name(),
  public.profit_totals(timestamptz, timestamptz, uuid, uuid), public.admin_scope(uuid),
  public.require_platform_admin()
from public, anon, authenticated;

grant execute on function
  public.my_business_id(), public.is_platform_admin(), public.current_business(),
  public.platform_create_business(text, text, text, int, int),
  public.platform_update_business(uuid, text, text, text, int, text, text),
  public.platform_businesses()
to authenticated;

grant select on public.businesses to authenticated;
grant select, update on public.app_settings to authenticated;
grant all on public.businesses, public.platform_admins, public.app_settings to service_role;
grant execute on all functions in schema public to service_role;
