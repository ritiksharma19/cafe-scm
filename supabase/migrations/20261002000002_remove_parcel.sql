-- =============================================================================
-- Cafe SCM — remove the parcel charge feature
--
-- Parcel orders and the automatic parcel charge (migration 20261002000001) are
-- withdrawn. A cafe that charges for packing adds a "Parcel packing" add-on
-- instead: it is priced, costed (e.g. a box as its ingredient) and reported like
-- any other add-on. record_sale and profit_totals return to their add-on versions.
-- =============================================================================

-- The settings view lists the table's columns; recreate it without the parcel ones.
drop view public.app_settings;
alter table public.business_settings
  drop column parcel_enabled,
  drop column parcel_charge,
  drop column parcel_charge_mode;
create view public.app_settings with (security_invoker = true) as
  select * from public.business_settings where business_id = public.my_business_id();
grant select, update on public.app_settings to authenticated;
grant all on public.app_settings to service_role;

drop function public.record_sale(uuid, jsonb, timestamptz, public.payment_method, numeric, public.order_type);

create function public.record_sale(
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

create or replace function public.profit_totals(p_from timestamptz, p_to timestamptz, p_business_id uuid, p_location_id uuid default null)
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

alter table public.orders drop column parcel_charge, drop column order_type;
drop type public.order_type;

grant execute on function public.record_sale(uuid, jsonb, timestamptz, public.payment_method, numeric) to authenticated;
grant execute on all functions in schema public to service_role;
