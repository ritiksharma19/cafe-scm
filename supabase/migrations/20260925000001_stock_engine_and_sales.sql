-- =============================================================================
-- Cafe SCM — stock engine, recipes and sales (Phase 2)
--
-- Every inventory change goes through post_movement(), which appends to the
-- ledger and updates the cached balance in the same transaction. Callers lock
-- the affected stock_levels rows first, always in material_id order, so
-- concurrent transactions cannot deadlock.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Internal building blocks (not callable by app users)
-- ---------------------------------------------------------------------------

-- Ensures balance rows exist and locks them in a deterministic order.
create function public.lock_stock_levels(p_location_id uuid, p_material_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stock_levels (location_id, material_id, quantity)
  select p_location_id, m, 0
    from (select distinct unnest(p_material_ids) as m) ids
   order by m
  on conflict (location_id, material_id) do nothing;

  perform 1
     from public.stock_levels
    where location_id = p_location_id and material_id = any (p_material_ids)
    order by material_id
      for update;
end;
$$;

-- Appends one ledger row and applies it to the cached balance. Returns the new balance.
create function public.post_movement(
  p_location_id   uuid,
  p_material_id   uuid,
  p_qty_delta     numeric,
  p_type          public.movement_type,
  p_ref_type      text,
  p_ref_id        uuid,
  p_unit_cost     numeric,
  p_occurred_at   timestamptz,
  p_user_id       uuid,
  p_notes         text default null,
  p_reverses_id   uuid default null
) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  v_new numeric;
begin
  insert into public.stock_movements
    (material_id, location_id, qty_delta, movement_type, unit_cost, ref_type, ref_id,
     reverses_movement_id, created_by, occurred_at, notes)
  values
    (p_material_id, p_location_id, p_qty_delta, p_type, p_unit_cost, p_ref_type, p_ref_id,
     p_reverses_id, p_user_id, p_occurred_at, p_notes);

  update public.stock_levels
     set quantity = quantity + p_qty_delta, updated_at = now()
   where location_id = p_location_id and material_id = p_material_id
  returning quantity into v_new;

  if not found then
    raise exception 'stock_levels row missing for location % material % (lock_stock_levels not called)',
      p_location_id, p_material_id;
  end if;
  return v_new;
end;
$$;

-- The recipe version in force at a point in time. A sale timestamped before the first
-- version (e.g. an offline sale synced after the recipe was created) uses the first version.
create function public.recipe_version_at(p_product_id uuid, p_at timestamptz) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select r.id from public.product_recipes r
      where r.product_id = p_product_id and r.effective_from <= p_at
      order by r.effective_from desc limit 1),
    (select r.id from public.product_recipes r
      where r.product_id = p_product_id
      order by r.effective_from asc limit 1)
  )
$$;

-- Caller's active profile or an authorization error.
create function public.require_profile() returns public.profiles
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.profiles;
begin
  select * into v from public.profiles where id = auth.uid() and is_active;
  if not found then
    raise exception 'Not signed in or account disabled' using errcode = '42501';
  end if;
  return v;
end;
$$;

create function public.require_admin() returns public.profiles
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.profiles := public.require_profile();
begin
  if v.role <> 'admin' then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_sale — the worker's main action. One call = one atomic transaction:
-- order + items + recipe explosion + ledger rows + balances.
--
-- p_order_id is generated on the phone and is the idempotency key: resending the
-- same order (network retry, offline sync) returns status 'duplicate' and changes nothing.
-- p_items: [{"product_id": "...", "quantity": 2}, ...]
-- ---------------------------------------------------------------------------
create function public.record_sale(
  p_order_id    uuid,
  p_items       jsonb,
  p_occurred_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_profile    public.profiles := public.require_profile();
  v_settings   public.app_settings;
  v_now        timestamptz := clock_timestamp();
  v_occurred   timestamptz;
  v_existing   public.orders;
  v_line       record;
  v_product    public.products;
  v_recipe_id  uuid;
  v_total      numeric(12,2) := 0;
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

  -- Device clocks can be wrong: never in the future, at most 72 hours back.
  v_occurred := least(greatest(coalesce(p_occurred_at, v_now), v_now - interval '72 hours'), v_now);

  insert into public.orders (id, location_id, worker_id, occurred_at, received_at)
  values (p_order_id, v_profile.location_id, v_profile.id, v_occurred, v_now)
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

  -- Lines (the same product sent twice is merged).
  for v_line in
    select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'quantity')::int) as quantity
      from jsonb_array_elements(p_items) e
     group by 1
     order by 1
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
            v_product.selling_price * v_line.quantity);

    v_total := v_total + v_product.selling_price * v_line.quantity;
    v_count := v_count + v_line.quantity;
  end loop;

  -- Explode recipes into consumption and post it.
  select array_agg(distinct ri.material_id) into v_materials
    from public.order_items oi
    join public.recipe_items ri on ri.recipe_id = oi.recipe_id
   where oi.order_id = p_order_id;

  perform public.lock_stock_levels(v_profile.location_id, v_materials);

  for v_move in
    select oi.id as order_item_id, ri.material_id, ri.quantity * oi.quantity as qty, m.avg_unit_cost
      from public.order_items oi
      join public.recipe_items ri on ri.recipe_id = oi.recipe_id
      join public.raw_materials m on m.id = ri.material_id
     where oi.order_id = p_order_id
     order by ri.material_id, oi.id
  loop
    perform public.post_movement(
      v_profile.location_id, v_move.material_id, -v_move.qty, 'SALE_CONSUMPTION',
      'order_item', v_move.order_item_id, v_move.avg_unit_cost, v_occurred, v_profile.id);
  end loop;

  update public.orders set item_count = v_count, total_amount = v_total where id = p_order_id;

  -- Negative stock: flagged (default) or blocked, per settings.
  select coalesce(jsonb_agg(m.name order by m.name), '[]'::jsonb) into v_negative
    from public.stock_levels sl
    join public.raw_materials m on m.id = sl.material_id
   where sl.location_id = v_profile.location_id
     and sl.material_id = any (v_materials)
     and sl.quantity < 0;

  select * into v_settings from public.app_settings;
  if jsonb_array_length(v_negative) > 0 and not v_settings.allow_negative_on_sale then
    raise exception 'Not enough stock for: %',
      (select string_agg(x, ', ') from jsonb_array_elements_text(v_negative) x)
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'status', 'created',
    'order_id', p_order_id,
    'item_count', v_count,
    'total_amount', v_total,
    'negative_materials', v_negative
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- void_order — admin correction. Never deletes: posts reversing movements and
-- marks the order voided.
-- ---------------------------------------------------------------------------
create function public.void_order(p_order_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin     public.profiles := public.require_admin();
  v_order     public.orders;
  v_materials uuid[];
  v_move      record;
  v_n         int := 0;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to void an order' using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.status = 'voided' then
    raise exception 'Order is already voided' using errcode = '22023';
  end if;

  select array_agg(distinct sm.material_id) into v_materials
    from public.stock_movements sm
    join public.order_items oi on oi.id = sm.ref_id
   where sm.ref_type = 'order_item' and oi.order_id = p_order_id;

  if v_materials is not null then
    perform public.lock_stock_levels(v_order.location_id, v_materials);
  end if;

  for v_move in
    select sm.*
      from public.stock_movements sm
      join public.order_items oi on oi.id = sm.ref_id
     where sm.ref_type = 'order_item'
       and oi.order_id = p_order_id
       and sm.movement_type = 'SALE_CONSUMPTION'
     order by sm.material_id, sm.id
  loop
    perform public.post_movement(
      v_move.location_id, v_move.material_id, -v_move.qty_delta, 'SALE_REVERSAL',
      'order_item', v_move.ref_id, v_move.unit_cost, now(), v_admin.id,
      'Void: ' || trim(p_reason), v_move.id);
    v_n := v_n + 1;
  end loop;

  update public.orders
     set status = 'voided', void_reason = trim(p_reason), voided_by = v_admin.id, voided_at = now()
   where id = p_order_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, old_value, new_value)
  values (v_admin.id, 'void', 'orders', p_order_id::text,
          jsonb_build_object('status', v_order.status),
          jsonb_build_object('status', 'voided', 'reason', trim(p_reason), 'reversed_movements', v_n));

  return jsonb_build_object('order_id', p_order_id, 'reversed_movements', v_n);
end;
$$;

-- ---------------------------------------------------------------------------
-- save_recipe — admin. Creates a new recipe version; the previous one is closed,
-- never edited, so past orders keep the recipe they consumed with.
-- p_items: [{"material_id": "...", "quantity": 20, "entered_qty": 20, "entered_unit": "g"}, ...]
-- quantity is in the material's base unit, per ONE product.
-- ---------------------------------------------------------------------------
create function public.save_recipe(p_product_id uuid, p_items jsonb, p_notes text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_admin    public.profiles := public.require_admin();
  v_now      timestamptz := clock_timestamp();
  v_version  int;
  v_recipe   uuid;
  v_bad      text;
begin
  perform 1 from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A recipe needs at least one ingredient' using errcode = '22023';
  end if;

  select coalesce(e ->> 'material_id', '?') into v_bad
    from jsonb_array_elements(p_items) e
   where not exists (select 1 from public.raw_materials m where m.id::text = e ->> 'material_id')
   limit 1;
  if v_bad is not null then
    raise exception 'Unknown raw material %', v_bad using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
              where (e ->> 'quantity') is null or (e ->> 'quantity')::numeric <= 0) then
    raise exception 'Ingredient quantities must be greater than zero' using errcode = '22023';
  end if;

  update public.product_recipes set effective_to = v_now
   where product_id = p_product_id and effective_to is null;

  select coalesce(max(version), 0) + 1 into v_version from public.product_recipes where product_id = p_product_id;

  insert into public.product_recipes (product_id, version, effective_from, notes, created_by)
  values (p_product_id, v_version, v_now, p_notes, v_admin.id)
  returning id into v_recipe;

  insert into public.recipe_items (recipe_id, material_id, quantity, entered_qty, entered_unit)
  select v_recipe,
         (e ->> 'material_id')::uuid,
         round((e ->> 'quantity')::numeric, 3),
         nullif(e ->> 'entered_qty', '')::numeric,
         nullif(e ->> 'entered_unit', '')
    from jsonb_array_elements(p_items) e;

  return v_recipe;
end;
$$;

-- ---------------------------------------------------------------------------
-- import_recipe_sheet — admin. Loads the owner's recipe matrix (already parsed
-- by the app). Creates missing materials/products and a new recipe version only
-- when a product's ingredients actually changed, so re-importing is harmless.
-- p_sheet: {"materials": [{"name", "base_unit"}], "products": [{"name", "items": [
--            {"material", "quantity", "entered_qty", "entered_unit"}]}]}
-- ---------------------------------------------------------------------------
create function public.import_recipe_sheet(p_sheet jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin        public.profiles := public.require_admin();
  v_mat          record;
  v_prod         record;
  v_existing     public.raw_materials;
  v_product_id   uuid;
  v_current      uuid;
  v_items        jsonb;
  v_same         boolean;
  v_next_sort    int;
  n_mat_created  int := 0;
  n_prod_created int := 0;
  n_rec_created  int := 0;
  n_rec_same     int := 0;
begin
  for v_mat in
    select trim(x.name) as name, x.base_unit
      from jsonb_to_recordset(coalesce(p_sheet -> 'materials', '[]'::jsonb)) as x(name text, base_unit text)
  loop
    if v_mat.base_unit not in ('g', 'ml', 'pcs') then
      raise exception 'Material "%": unsupported unit %', v_mat.name, v_mat.base_unit using errcode = '22023';
    end if;
    select * into v_existing from public.raw_materials where lower(name) = lower(v_mat.name);
    if not found then
      insert into public.raw_materials (name, base_unit, display_unit)
      values (v_mat.name, v_mat.base_unit,
              case v_mat.base_unit when 'g' then 'kg' when 'ml' then 'l' else 'pcs' end);
      n_mat_created := n_mat_created + 1;
    elsif v_existing.base_unit <> v_mat.base_unit then
      raise exception 'Material "%" is measured in % in the app but % in the sheet',
        v_existing.name, v_existing.base_unit, v_mat.base_unit using errcode = '22023';
    end if;
  end loop;

  for v_prod in
    select trim(x.name) as name, x.items
      from jsonb_to_recordset(coalesce(p_sheet -> 'products', '[]'::jsonb)) as x(name text, items jsonb)
  loop
    select id into v_product_id from public.products where lower(name) = lower(v_prod.name);
    if not found then
      select coalesce(max(sort_order), 0) + 1 into v_next_sort from public.products;
      insert into public.products (name, sort_order) values (v_prod.name, v_next_sort)
      returning id into v_product_id;
      n_prod_created := n_prod_created + 1;
    end if;

    select jsonb_agg(jsonb_build_object(
             'material_id', m.id,
             'quantity', (i ->> 'quantity')::numeric,
             'entered_qty', i ->> 'entered_qty',
             'entered_unit', i ->> 'entered_unit'))
      into v_items
      from jsonb_array_elements(v_prod.items) i
      join public.raw_materials m on lower(m.name) = lower(trim(i ->> 'material'));

    if coalesce(jsonb_array_length(v_items), 0) <> coalesce(jsonb_array_length(v_prod.items), 0)
       or v_items is null then
      raise exception 'Product "%": an ingredient is not in the materials list', v_prod.name using errcode = '22023';
    end if;

    select id into v_current from public.product_recipes
     where product_id = v_product_id and effective_to is null;

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
      perform public.save_recipe(v_product_id, v_items, 'Imported from recipe sheet');
      n_rec_created := n_rec_created + 1;
    end if;
  end loop;

  insert into public.audit_logs (actor_id, action, entity, entity_id, new_value)
  values (v_admin.id, 'import', 'recipe_sheet', null, jsonb_build_object(
    'materials_created', n_mat_created, 'products_created', n_prod_created,
    'recipes_created', n_rec_created, 'recipes_unchanged', n_rec_same));

  return jsonb_build_object(
    'materials_created', n_mat_created, 'products_created', n_prod_created,
    'recipes_created', n_rec_created, 'recipes_unchanged', n_rec_same);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_adjust_stock — opening balances and explicit admin corrections.
-- ---------------------------------------------------------------------------
create function public.admin_adjust_stock(
  p_location_id uuid,
  p_material_id uuid,
  p_qty_delta   numeric,
  p_type        public.movement_type,
  p_notes       text default null
) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  v_admin    public.profiles := public.require_admin();
  v_settings public.app_settings;
  v_cost     numeric;
  v_new      numeric;
begin
  if p_type not in ('OPENING_BALANCE', 'MANUAL_ADJUSTMENT') then
    raise exception 'Use the matching workflow for %', p_type using errcode = '22023';
  end if;
  if p_qty_delta is null or p_qty_delta = 0 then
    raise exception 'Quantity must not be zero' using errcode = '22023';
  end if;
  if p_type = 'MANUAL_ADJUSTMENT' and coalesce(trim(p_notes), '') = '' then
    raise exception 'A note is required for manual adjustments' using errcode = '22023';
  end if;
  select avg_unit_cost into v_cost from public.raw_materials where id = p_material_id;
  if not found then
    raise exception 'Unknown raw material' using errcode = '22023';
  end if;
  if not exists (select 1 from public.locations where id = p_location_id) then
    raise exception 'Unknown location' using errcode = '22023';
  end if;

  perform public.lock_stock_levels(p_location_id, array[p_material_id]);
  v_new := public.post_movement(
    p_location_id, p_material_id, round(p_qty_delta, 3), p_type,
    case when p_type = 'OPENING_BALANCE' then 'opening' else 'adjustment' end,
    null, v_cost, now(), v_admin.id, nullif(trim(p_notes), ''));

  select * into v_settings from public.app_settings;
  if v_new < 0 and not v_settings.allow_negative_other then
    raise exception 'Adjustment would make stock negative (%)', v_new using errcode = 'P0001';
  end if;
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- verify_stock_levels — admin diagnostic: cached balances that differ from the
-- ledger. Must always return zero rows.
-- ---------------------------------------------------------------------------
create function public.verify_stock_levels()
returns table (location_id uuid, material_id uuid, cached numeric, ledger numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return query
    select coalesce(sl.location_id, l.location_id), coalesce(sl.material_id, l.material_id),
           coalesce(sl.quantity, 0), coalesce(l.qty, 0)
      from public.stock_levels sl
      full join (select sm.location_id, sm.material_id, sum(sm.qty_delta) as qty
                   from public.stock_movements sm group by 1, 2) l
        on l.location_id = sl.location_id and l.material_id = sl.material_id
     where coalesce(sl.quantity, 0) <> coalesce(l.qty, 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  public.lock_stock_levels(uuid, uuid[]),
  public.post_movement(uuid, uuid, numeric, public.movement_type, text, uuid, numeric, timestamptz, uuid, text, uuid),
  public.recipe_version_at(uuid, timestamptz),
  public.require_profile(),
  public.require_admin()
from public, anon, authenticated;

grant execute on function
  public.record_sale(uuid, jsonb, timestamptz),
  public.void_order(uuid, text),
  public.save_recipe(uuid, jsonb, text),
  public.import_recipe_sheet(jsonb),
  public.admin_adjust_stock(uuid, uuid, numeric, public.movement_type, text),
  public.verify_stock_levels()
to authenticated;

grant execute on all functions in schema public to service_role;
