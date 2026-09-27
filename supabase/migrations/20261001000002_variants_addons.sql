-- =============================================================================
-- Cafe SCM — sizes (variants) and add-ons
--
-- Sizes: a size is an ordinary product (own price, own versioned recipe, own
--   profit line) linked to a base product with variant_of. "Cold Coffee" (Regular)
--   + "Cold Coffee Large". The Sell screen shows one tile and asks which size.
--   One level only: a size cannot have sizes.
--
-- Add-ons: "Extra cheese +₹20" with its own ingredients (e.g. 20 g cheese).
--   Offered per product (a size also offers its base product's add-ons).
--   Each order line may carry add-ons; their price is added to the order and
--   their ingredients are deducted as SALE_CONSUMPTION rows on the same order
--   line, so voiding the order and product profit include them automatically.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Sizes
-- ---------------------------------------------------------------------------
alter table public.products
  add column variant_of    uuid references public.products (id),
  add column variant_label text check (variant_label is null or length(trim(variant_label)) between 1 and 20);
create index products_variant_of_idx on public.products (variant_of);

create function public.check_product_variant() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.variant_of is not null then
    if new.variant_of = new.id then
      raise exception 'A product cannot be a size of itself' using errcode = '22023';
    end if;
    if exists (select 1 from public.products where id = new.variant_of and variant_of is not null) then
      raise exception 'Sizes cannot have their own sizes' using errcode = '22023';
    end if;
    if exists (select 1 from public.products where variant_of = new.id) then
      raise exception 'This product already has sizes, so it cannot become a size' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger check_product_variant before insert or update of variant_of on public.products
  for each row execute function public.check_product_variant();

drop trigger enforce_business on public.products;
create trigger enforce_business before insert or update on public.products
  for each row execute function public.enforce_business('own', 'variant_of', 'products');

-- ---------------------------------------------------------------------------
-- Add-ons
-- ---------------------------------------------------------------------------
create table public.addons (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id),
  name        text not null check (length(trim(name)) between 1 and 40),
  price       numeric(12,2) not null default 0 check (price >= 0),
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index addons_name_key on public.addons (business_id, lower(name));

-- Ingredients of one add-on (base units). Editing replaces the rows: past orders
-- are unaffected because their consumption is already in the ledger.
create table public.addon_items (
  addon_id      uuid not null references public.addons (id),
  material_id   uuid not null references public.raw_materials (id),
  quantity      numeric(14,3) not null check (quantity > 0),
  entered_qty   numeric(14,3),
  entered_unit  text,
  primary key (addon_id, material_id)
);

-- Which products offer which add-ons.
create table public.product_addons (
  product_id  uuid not null references public.products (id),
  addon_id    uuid not null references public.addons (id),
  primary key (product_id, addon_id)
);
create index product_addons_addon_idx on public.product_addons (addon_id);

-- The same product with different add-ons is a separate order line.
alter table public.order_items drop constraint order_items_order_id_product_id_key;
alter table public.order_items add column addons_amount numeric(12,2) not null default 0;

create table public.order_item_addons (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders (id),
  order_item_id  uuid not null references public.order_items (id),
  addon_id       uuid not null references public.addons (id),
  quantity       int not null check (quantity between 1 and 10),   -- per one product
  unit_price     numeric(12,2) not null,
  line_total     numeric(12,2) not null,                           -- unit_price × quantity × item quantity
  created_at     timestamptz not null default now(),
  unique (order_item_id, addon_id)
);
create index order_item_addons_order_idx on public.order_item_addons (order_id);

create trigger set_updated_at before update on public.addons for each row execute function public.set_updated_at();
create trigger audit after insert or update on public.addons for each row execute function public.audit_row_change();
create trigger no_delete before delete on public.addons for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.order_item_addons for each row execute function public.prevent_mutation();

create trigger enforce_business before insert or update on public.addons            for each row execute function public.enforce_business('own');
create trigger enforce_business before insert or update on public.addon_items       for each row execute function public.enforce_business('child', 'addon_id', 'addons', 'material_id', 'raw_materials');
create trigger enforce_business before insert or update on public.product_addons    for each row execute function public.enforce_business('child', 'product_id', 'products', 'addon_id', 'addons');
create trigger enforce_business before insert or update on public.order_item_addons for each row execute function public.enforce_business('child', 'order_id', 'orders', 'addon_id', 'addons', 'order_item_id', 'order_items_business');

-- order_items has no business_id of its own; a tiny view lets the guard check it via its order.
create view public.order_items_business as
  select oi.id, o.business_id from public.order_items oi join public.orders o on o.id = oi.order_id;
revoke all on public.order_items_business from anon, authenticated;

alter table public.addons            enable row level security;
alter table public.addon_items       enable row level security;
alter table public.product_addons    enable row level security;
alter table public.order_item_addons enable row level security;

create policy read_all on public.addons for select to authenticated
  using (public.current_role_name() is not null and business_id = (select public.my_business_id()));
create policy read_all on public.addon_items for select to authenticated using (
  exists (select 1 from public.addons a where a.id = addon_id and a.business_id = (select public.my_business_id())));
create policy read_all on public.product_addons for select to authenticated using (
  exists (select 1 from public.addons a where a.id = addon_id and a.business_id = (select public.my_business_id())));
create policy read_scoped on public.order_item_addons for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_id and public.can_access_location(o.location_id)));

grant select on public.addons, public.addon_items, public.product_addons, public.order_item_addons to authenticated;
grant all on public.addons, public.addon_items, public.product_addons, public.order_item_addons to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.addons;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- save_addon — admin. Creates or updates an add-on, its ingredients and the
-- products that offer it, in one transaction.
-- p_items: [{"material_id", "quantity" (base unit, per one add-on), "entered_qty", "entered_unit"}]
-- ---------------------------------------------------------------------------
create function public.save_addon(
  p_id          uuid,
  p_name        text,
  p_price       numeric,
  p_is_active   boolean default true,
  p_items       jsonb default '[]'::jsonb,
  p_product_ids uuid[] default '{}'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_admin public.profiles := public.require_admin();
  v_name  text := trim(coalesce(p_name, ''));
  v_id    uuid := p_id;
begin
  if v_name = '' or length(v_name) > 40 then
    raise exception 'Enter a name (up to 40 characters)' using errcode = '22023';
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'Enter a price of zero or more' using errcode = '22023';
  end if;
  if exists (select 1 from public.addons where business_id = v_admin.business_id and lower(name) = lower(v_name)
               and id is distinct from p_id) then
    raise exception 'An add-on called "%" already exists', v_name using errcode = '23505';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array'
     or exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
                 where (e ->> 'quantity') is null or (e ->> 'quantity')::numeric <= 0) then
    raise exception 'Ingredient quantities must be greater than zero' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.addons (business_id, name, price, is_active, sort_order)
    values (v_admin.business_id, v_name, round(p_price, 2), coalesce(p_is_active, true),
            (select coalesce(max(sort_order), 0) + 1 from public.addons where business_id = v_admin.business_id))
    returning id into v_id;
  else
    update public.addons set name = v_name, price = round(p_price, 2), is_active = coalesce(p_is_active, true)
     where id = v_id;
    if not found then
      raise exception 'Add-on not found' using errcode = 'P0002';
    end if;
  end if;

  delete from public.addon_items where addon_id = v_id;
  insert into public.addon_items (addon_id, material_id, quantity, entered_qty, entered_unit)
  select v_id, (e ->> 'material_id')::uuid, round(sum((e ->> 'quantity')::numeric), 3),
         max(nullif(e ->> 'entered_qty', '')::numeric), max(nullif(e ->> 'entered_unit', ''))
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
   group by 2;

  delete from public.product_addons where addon_id = v_id;
  insert into public.product_addons (product_id, addon_id)
  select distinct unnest(coalesce(p_product_ids, '{}')), v_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, new_value)
  values (v_admin.id, case when p_id is null then 'create' else 'update' end, 'addon_setup', v_id::text,
          jsonb_build_object('items', coalesce(p_items, '[]'::jsonb), 'products', to_jsonb(coalesce(p_product_ids, '{}'))));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_variant — admin. Adds a size to a base product. The new size copies the
-- base product's current recipe (edit it afterwards) so it can be sold at once.
-- ---------------------------------------------------------------------------
create function public.create_variant(p_base_id uuid, p_label text, p_price numeric, p_copy_recipe boolean default true)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_admin  public.profiles := public.require_admin();
  v_base   public.products;
  v_label  text := trim(coalesce(p_label, ''));
  v_id     uuid;
  v_items  jsonb;
begin
  select * into v_base from public.products where id = p_base_id and business_id = v_admin.business_id;
  if not found then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if v_base.variant_of is not null then
    raise exception 'Add sizes to the main product, not to a size' using errcode = '22023';
  end if;
  if v_label = '' or length(v_label) > 20 then
    raise exception 'Size name: 1–20 characters, e.g. Large' using errcode = '22023';
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'Enter a price of zero or more' using errcode = '22023';
  end if;

  insert into public.products (business_id, name, category, selling_price, sort_order, color, variant_of, variant_label)
  values (v_admin.business_id, v_base.name || ' ' || v_label, v_base.category, round(p_price, 2), v_base.sort_order,
          v_base.color, v_base.id, v_label)
  returning id into v_id;

  if coalesce(p_copy_recipe, true) then
    select jsonb_agg(jsonb_build_object('material_id', ri.material_id, 'quantity', ri.quantity,
                                        'entered_qty', ri.entered_qty, 'entered_unit', ri.entered_unit))
      into v_items
      from public.product_recipes r join public.recipe_items ri on ri.recipe_id = r.id
     where r.product_id = v_base.id and r.effective_to is null;
    if v_items is not null then
      perform public.save_recipe(v_id, v_items, 'Copied from ' || v_base.name);
    end if;
  end if;
  return v_id;
end;
$$;

-- What one order consumes: each line's recipe × quantity, plus each add-on's
-- ingredients × add-on quantity × line quantity.
create function public.sale_consumption(p_order_id uuid)
returns table (order_item_id uuid, material_id uuid, qty numeric, unit_cost numeric)
language sql stable security definer set search_path = '' as $$
  select oi.id, ri.material_id, ri.quantity * oi.quantity, m.avg_unit_cost
    from public.order_items oi
    join public.recipe_items ri on ri.recipe_id = oi.recipe_id
    join public.raw_materials m on m.id = ri.material_id
   where oi.order_id = p_order_id
  union all
  select oia.order_item_id, ai.material_id, ai.quantity * oia.quantity * oi.quantity, m.avg_unit_cost
    from public.order_item_addons oia
    join public.order_items oi on oi.id = oia.order_item_id
    join public.addon_items ai on ai.addon_id = oia.addon_id
    join public.raw_materials m on m.id = ai.material_id
   where oia.order_id = p_order_id
$$;

-- ---------------------------------------------------------------------------
-- record_sale — now with add-ons per line.
-- p_items: [{"product_id", "quantity", "addons": [{"addon_id", "quantity"}]}]
-- Lines with the same product AND the same add-ons are merged.
-- ---------------------------------------------------------------------------
create or replace function public.record_sale(
  p_order_id       uuid,
  p_items          jsonb,
  p_occurred_at    timestamptz default null,
  p_payment_method public.payment_method default 'cash',
  p_discount       numeric default 0
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_profile    public.profiles := public.require_profile();
  v_settings   public.app_settings;
  v_now        timestamptz := clock_timestamp();
  v_occurred   timestamptz;
  v_existing   public.orders;
  v_line       record;
  v_addon      record;
  v_product    public.products;
  v_recipe_id  uuid;
  v_item_id    uuid;
  v_addons_amt numeric(12,2);
  v_gross      numeric(12,2) := 0;
  v_discount   numeric(12,2) := round(coalesce(p_discount, 0), 2);
  v_count      int := 0;
  v_materials  uuid[];
  v_move       record;
  v_negative   jsonb;
begin
  if v_profile.role <> 'worker' or v_profile.location_id is null then
    raise exception 'Only a cart worker can record sales' using errcode = '42501';
  end if;
  if p_order_id is null then
    raise exception 'Order id is required' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order has no items' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'Too many lines in one order' using errcode = '22023';
  end if;
  if v_discount < 0 then
    raise exception 'Discount cannot be negative' using errcode = '22023';
  end if;

  -- Device clocks can be wrong: never in the future, at most 72 hours back.
  v_occurred := least(greatest(coalesce(p_occurred_at, v_now), v_now - interval '72 hours'), v_now);

  insert into public.orders (id, location_id, worker_id, occurred_at, received_at, payment_method)
  values (p_order_id, v_profile.location_id, v_profile.id, v_occurred, v_now, coalesce(p_payment_method, 'cash'))
  on conflict (id) do nothing;

  if not found then
    select * into v_existing from public.orders where id = p_order_id;
    if v_existing.worker_id <> v_profile.id then
      raise exception 'Order id already used' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'status', 'duplicate',
      'order_id', v_existing.id,
      'item_count', v_existing.item_count,
      'total_amount', v_existing.total_amount,
      'negative_materials', '[]'::jsonb
    );
  end if;

  for v_line in
    select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'quantity')::int) as quantity, x.addons
      from jsonb_array_elements(p_items) e
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('addon_id', a ->> 'addon_id',
                                                     'quantity', coalesce((a ->> 'quantity')::int, 1))
                                  order by a ->> 'addon_id'), '[]'::jsonb) as addons
          from jsonb_array_elements(coalesce(e -> 'addons', '[]'::jsonb)) a
      ) x
     group by 1, 3
     order by 1, x.addons::text
  loop
    if v_line.product_id is null then
      raise exception 'Order line without product' using errcode = '22023';
    end if;
    if v_line.quantity is null or v_line.quantity < 1 or v_line.quantity > 999 then
      raise exception 'Invalid quantity % for a product', v_line.quantity using errcode = '22023';
    end if;

    select * into v_product from public.products where id = v_line.product_id;
    if not found then
      raise exception 'Unknown product %', v_line.product_id using errcode = '22023';
    end if;

    v_recipe_id := public.recipe_version_at(v_product.id, v_occurred);
    if v_recipe_id is null then
      raise exception 'Product "%" has no recipe yet', v_product.name using errcode = '22023';
    end if;

    insert into public.order_items (order_id, product_id, recipe_id, quantity, unit_price, line_total)
    values (p_order_id, v_product.id, v_recipe_id, v_line.quantity, v_product.selling_price,
            v_product.selling_price * v_line.quantity)
    returning id into v_item_id;

    v_addons_amt := 0;
    if (select count(distinct a ->> 'addon_id') from jsonb_array_elements(v_line.addons) a) <> jsonb_array_length(v_line.addons) then
      raise exception 'The same add-on is listed twice on one item' using errcode = '22023';
    end if;
    for v_addon in
      select ad.*, (a ->> 'quantity')::int as qty
        from jsonb_array_elements(v_line.addons) a
        left join public.addons ad on ad.id = (a ->> 'addon_id')::uuid
    loop
      if v_addon.id is null or not v_addon.is_active then
        raise exception 'An add-on on "%" is not available', v_product.name using errcode = '22023';
      end if;
      if not exists (select 1 from public.product_addons pa
                      where pa.addon_id = v_addon.id and pa.product_id in (v_product.id, v_product.variant_of)) then
        raise exception '"%" is not offered with "%"', v_addon.name, v_product.name using errcode = '22023';
      end if;
      if v_addon.qty is null or v_addon.qty < 1 or v_addon.qty > 10 then
        raise exception 'Add-on quantity must be 1 to 10' using errcode = '22023';
      end if;
      insert into public.order_item_addons (order_id, order_item_id, addon_id, quantity, unit_price, line_total)
      values (p_order_id, v_item_id, v_addon.id, v_addon.qty, v_addon.price, v_addon.price * v_addon.qty * v_line.quantity);
      v_addons_amt := v_addons_amt + v_addon.price * v_addon.qty * v_line.quantity;
    end loop;
    if v_addons_amt > 0 then
      update public.order_items set addons_amount = v_addons_amt where id = v_item_id;
    end if;

    v_gross := v_gross + v_product.selling_price * v_line.quantity + v_addons_amt;
    v_count := v_count + v_line.quantity;
  end loop;

  select * into v_settings from public.app_settings;
  if v_discount > v_gross then
    raise exception 'Discount is larger than the order' using errcode = '22023';
  end if;
  if v_discount > round(v_gross * v_settings.worker_discount_limit_pct / 100.0, 2) then
    raise exception 'Discount is above the allowed limit (% %% of the order)', v_settings.worker_discount_limit_pct
      using errcode = '22023';
  end if;

  -- Consumption: each line's recipe, plus its add-ons' ingredients (see sale_consumption()).
  select array_agg(distinct c.material_id) into v_materials from public.sale_consumption(p_order_id) c;
  perform public.lock_stock_levels(v_profile.location_id, v_materials);

  for v_move in
    select * from public.sale_consumption(p_order_id) c order by c.material_id, c.order_item_id
  loop
    perform public.post_movement(
      v_profile.location_id, v_move.material_id, -v_move.qty, 'SALE_CONSUMPTION',
      'order_item', v_move.order_item_id, v_move.unit_cost, v_occurred, v_profile.id);
  end loop;

  update public.orders
     set item_count = v_count, total_amount = v_gross - v_discount, discount_amount = v_discount
   where id = p_order_id;

  -- Negative stock: flagged (default) or blocked, per settings.
  select coalesce(jsonb_agg(m.name order by m.name), '[]'::jsonb) into v_negative
    from public.stock_levels sl
    join public.raw_materials m on m.id = sl.material_id
   where sl.location_id = v_profile.location_id
     and sl.material_id = any (v_materials)
     and sl.quantity < 0;

  if jsonb_array_length(v_negative) > 0 and not v_settings.allow_negative_on_sale then
    raise exception 'Not enough stock for: %',
      (select string_agg(x, ', ') from jsonb_array_elements_text(v_negative) x)
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'status', 'created',
    'order_id', p_order_id,
    'item_count', v_count,
    'total_amount', v_gross - v_discount,
    'discount_amount', v_discount,
    'payment_method', coalesce(p_payment_method, 'cash'),
    'negative_materials', v_negative
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Product revenue now includes the add-ons sold with it.
-- ---------------------------------------------------------------------------
create or replace function public.product_sales(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (product_id uuid, name text, quantity bigint, sales numeric, orders bigint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(p_location_id);
begin
  return query
    select p.id, p.name, sum(oi.quantity)::bigint, sum(oi.line_total + oi.addons_amount), count(distinct o.id)
      from public.orders o
      join public.order_items oi on oi.order_id = o.id
      join public.products p on p.id = oi.product_id
     where o.business_id = v_biz and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
       and (p_location_id is null or o.location_id = p_location_id)
     group by p.id, p.name
     order by 3 desc, p.name;
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
      select oi.id, oi.product_id, oi.quantity, oi.line_total + oi.addons_amount as revenue
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
      select l.product_id as pid, sum(l.quantity)::bigint as q, sum(l.revenue) as s, round(coalesce(sum(cost.c), 0), 2) as c
        from lines l left join cost on cost.id = l.id
       group by l.product_id
    )
    select p.id, p.name, p.category, agg.q, agg.s, agg.c, agg.s - agg.c,
           case when agg.s > 0 then round((agg.s - agg.c) / agg.s * 100, 1) end
      from agg join public.products p on p.id = agg.pid
     order by agg.s - agg.c desc, p.name;
end;
$$;

-- Add-on popularity and profit for the period.
create function public.addon_sales(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (addon_id uuid, name text, quantity bigint, sales numeric, cogs numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_biz uuid := public.admin_scope(p_location_id);
begin
  return query
    select a.id, a.name,
           sum(oia.quantity * oi.quantity)::bigint,
           sum(oia.line_total),
           round(coalesce(sum(oia.quantity * oi.quantity *
             (select sum(ai.quantity * coalesce(sm_cost.c, m.avg_unit_cost))
                from public.addon_items ai
                join public.raw_materials m on m.id = ai.material_id
                left join lateral (
                  select sm.unit_cost as c from public.stock_movements sm
                   where sm.ref_type = 'order_item' and sm.ref_id = oi.id and sm.material_id = ai.material_id
                     and sm.movement_type = 'SALE_CONSUMPTION'
                   limit 1) sm_cost on true
               where ai.addon_id = a.id)), 0), 2)
      from public.orders o
      join public.order_item_addons oia on oia.order_id = o.id
      join public.order_items oi on oi.id = oia.order_item_id
      join public.addons a on a.id = oia.addon_id
     where o.business_id = v_biz and o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
       and (p_location_id is null or o.location_id = p_location_id)
     group by a.id, a.name
     order by 4 desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.check_product_variant(), public.sale_consumption(uuid) from public, anon, authenticated;
grant execute on function
  public.record_sale(uuid, jsonb, timestamptz, public.payment_method, numeric),
  public.save_addon(uuid, text, numeric, boolean, jsonb, uuid[]),
  public.create_variant(uuid, text, numeric, boolean),
  public.addon_sales(timestamptz, timestamptz, uuid)
to authenticated;
grant execute on all functions in schema public to service_role;
