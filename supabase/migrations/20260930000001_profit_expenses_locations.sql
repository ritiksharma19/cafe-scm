-- =============================================================================
-- Cafe SCM — profit, expenses, payments, discounts, location management
--
--  * Orders record how the customer paid (cash / UPI / card / other) and an
--    optional discount. total_amount stays the amount actually charged.
--  * Expenses (rent, salaries, gas …) are documents like everything else:
--    client-generated id, voided (never deleted), audited.
--  * Profit is computed from the ledger: the cost of goods sold is the ingredient
--    cost frozen on each sale's consumption rows, so history never changes.
--  * Admins can add carts and rename / reorder / deactivate locations safely.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Payments & discounts on orders
-- ---------------------------------------------------------------------------
create type public.payment_method as enum ('cash', 'upi', 'card', 'other');

alter table public.orders
  add column payment_method  public.payment_method not null default 'cash',
  add column discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0);

alter table public.app_settings
  -- Largest discount a cart worker may give, as % of the order. 0 = workers cannot discount.
  add column worker_discount_limit_pct int not null default 0 check (worker_discount_limit_pct between 0 and 100);

-- Sale with payment method and discount. Older app versions (and orders queued
-- offline before this update) call it without the new arguments: cash, no discount.
drop function public.record_sale(uuid, jsonb, timestamptz);

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
  v_product    public.products;
  v_recipe_id  uuid;
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

    v_gross := v_gross + v_product.selling_price * v_line.quantity;
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
-- Expenses (everything that is not a raw material: rent, salaries, gas …)
-- location_id null = the whole business (e.g. the owner's rent or accountant).
-- ---------------------------------------------------------------------------
create type public.expense_category as enum (
  'rent', 'salaries', 'utilities', 'gas_fuel', 'packaging', 'maintenance',
  'transport', 'marketing', 'fees_taxes', 'other'
);

create table public.expenses (
  id              uuid primary key,                          -- client-generated (idempotency key)
  location_id     uuid references public.locations (id),
  category        public.expense_category not null,
  amount          numeric(12,2) not null check (amount > 0),
  description     text,
  spent_on        date not null,
  payment_method  public.payment_method not null default 'cash',
  recorded_by     uuid not null references public.profiles (id),
  status          public.doc_status not null default 'posted',
  void_reason     text,
  voided_by       uuid references public.profiles (id),
  voided_at       timestamptz,
  created_at      timestamptz not null default now()
);
create index expenses_spent_on_idx on public.expenses (spent_on desc);
create index expenses_location_idx on public.expenses (location_id, spent_on desc);

create trigger no_delete before delete on public.expenses for each row execute function public.prevent_mutation();

alter table public.expenses enable row level security;
-- Admin sees all; a worker sees their own cart's (can_access_location(null) is admin-only).
create policy read_scoped on public.expenses for select to authenticated using (public.can_access_location(location_id));

-- Worker: own cart, dated today or up to 3 days back. Admin: any location or the
-- whole business (null), any past date.
create function public.record_expense(
  p_expense_id     uuid,
  p_category       public.expense_category,
  p_amount         numeric,
  p_spent_on       date default null,
  p_description    text default null,
  p_payment_method public.payment_method default 'cash',
  p_location_id    uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_profile  public.profiles := public.require_profile();
  v_today    date := (now() at time zone (select timezone from public.app_settings))::date;
  v_on       date := coalesce(p_spent_on, v_today);
  v_loc      uuid;
  v_existing public.expenses;
begin
  if p_expense_id is null then
    raise exception 'Expense id is required' using errcode = '22023';
  end if;
  if p_category is null then
    raise exception 'Choose a category' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 then
    raise exception 'Enter an amount greater than zero' using errcode = '22023';
  end if;
  if p_category = 'other' and coalesce(trim(p_description), '') = '' then
    raise exception 'Add a description when the category is "other"' using errcode = '22023';
  end if;
  if v_on > v_today then
    raise exception 'The date cannot be in the future' using errcode = '22023';
  end if;

  if v_profile.role = 'worker' then
    v_loc := public.resolve_location(v_profile, p_location_id);
    if v_on < v_today - 3 then
      raise exception 'Workers can record expenses from the last 3 days only' using errcode = '22023';
    end if;
  else
    if p_location_id is not null and not exists (select 1 from public.locations where id = p_location_id and is_active) then
      raise exception 'Choose a valid location' using errcode = '22023';
    end if;
    v_loc := p_location_id;
  end if;

  insert into public.expenses (id, location_id, category, amount, description, spent_on, payment_method, recorded_by)
  values (p_expense_id, v_loc, p_category, round(p_amount, 2), nullif(trim(p_description), ''), v_on,
          coalesce(p_payment_method, 'cash'), v_profile.id)
  on conflict (id) do nothing;
  if not found then
    select * into v_existing from public.expenses where id = p_expense_id;
    if v_existing.recorded_by <> v_profile.id then
      raise exception 'Expense id already used' using errcode = '23505';
    end if;
    return jsonb_build_object('status', 'duplicate', 'expense_id', p_expense_id);
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, new_value)
  values (v_profile.id, 'create', 'expenses', p_expense_id::text,
          jsonb_build_object('category', p_category, 'amount', round(p_amount, 2), 'location_id', v_loc, 'spent_on', v_on));

  return jsonb_build_object('status', 'created', 'expense_id', p_expense_id, 'amount', round(p_amount, 2));
end;
$$;

create function public.void_expense(p_expense_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin public.profiles := public.require_admin();
  v_e     public.expenses;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to void an expense' using errcode = '22023';
  end if;
  select * into v_e from public.expenses where id = p_expense_id for update;
  if not found then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  if v_e.status = 'voided' then
    raise exception 'Expense is already voided' using errcode = '22023';
  end if;

  update public.expenses
     set status = 'voided', void_reason = trim(p_reason), voided_by = v_admin.id, voided_at = now()
   where id = p_expense_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, old_value, new_value)
  values (v_admin.id, 'void', 'expenses', p_expense_id::text,
          jsonb_build_object('status', v_e.status, 'amount', v_e.amount),
          jsonb_build_object('status', 'voided', 'reason', trim(p_reason)));
  return jsonb_build_object('expense_id', p_expense_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Location management (admin). Adding a cart generates the next CART<n> code.
-- A location can only be deactivated when nothing is left behind: no active
-- workers, no stock, no transfers still on the way.
-- ---------------------------------------------------------------------------
create unique index locations_name_key on public.locations (lower(name));

create function public.admin_save_location(
  p_id         uuid,
  p_name       text,
  p_sort_order int default null,
  p_is_active  boolean default true
) returns public.locations
language plpgsql security definer set search_path = '' as $$
declare
  v_admin public.profiles := public.require_admin();
  v_name  text := trim(coalesce(p_name, ''));
  v_loc   public.locations;
  v_n     int;
  v_code  text;
begin
  if v_name = '' or length(v_name) > 40 then
    raise exception 'Enter a name (up to 40 characters)' using errcode = '22023';
  end if;
  if exists (select 1 from public.locations where lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'A location called "%" already exists', v_name using errcode = '23505';
  end if;

  if p_id is null then
    select coalesce(max(nullif(regexp_replace(code, '^CART', ''), '')::int), 0) + 1 into v_n
      from public.locations where code ~ '^CART[0-9]+$';
    v_code := 'CART' || v_n;
    insert into public.locations (code, name, type, sort_order, is_active)
    values (v_code, v_name, 'cart',
            coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 1 from public.locations)), true)
    returning * into v_loc;
    return v_loc;
  end if;

  select * into v_loc from public.locations where id = p_id for update;
  if not found then
    raise exception 'Location not found' using errcode = 'P0002';
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
-- Profit
--
--   Gross sales      = Σ order line totals (menu price × qty), completed orders
--   Discounts        = Σ order discounts
--   Net sales        = gross sales − discounts (what customers actually paid)
--   Cost of goods    = ingredient cost of those same orders, at the cost frozen on
--                      each consumption row when the sale happened
--   Gross profit     = net sales − cost of goods
--   Wastage          = cost of wasted stock in the period
--   Stock variance   = losses (−) / gains (+) found by stock counts and adjustments
--   Expenses         = posted expenses dated in the period
--   Net profit       = gross profit − wastage + stock variance − expenses
--
-- With a location filter, business-wide expenses (no location) are reported as
-- "shared_expenses" but not subtracted, since they belong to no single cart.
-- ---------------------------------------------------------------------------
create function public.profit_totals(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  tz         text := (select timezone from public.app_settings);
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
   where o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
     and (p_location_id is null or o.location_id = p_location_id);

  select coalesce(sum(-sm.qty_delta * coalesce(sm.unit_cost, 0)), 0) into v_cogs
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    join public.stock_movements sm on sm.ref_type = 'order_item' and sm.ref_id = oi.id and sm.movement_type = 'SALE_CONSUMPTION'
   where o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
     and (p_location_id is null or o.location_id = p_location_id);

  select coalesce(sum(case when sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL')
                           then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end), 0),
         coalesce(sum(case when sm.movement_type in ('COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT')
                           then sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end), 0)
    into v_waste, v_var
    from public.stock_movements sm
   where sm.occurred_at >= p_from and sm.occurred_at < p_to
     and sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL', 'COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT')
     and (p_location_id is null or sm.location_id = p_location_id);

  select coalesce(sum(e.amount) filter (where p_location_id is null or e.location_id = p_location_id), 0),
         coalesce(sum(e.amount) filter (where p_location_id is not null and e.location_id is null), 0)
    into v_exp, v_shared
    from public.expenses e
   where e.status = 'posted' and e.spent_on >= v_from_d and e.spent_on <= v_last_d;

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

create function public.profit_summary(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  tz       text := (select timezone from public.app_settings);
  v_from_d date := (p_from at time zone tz)::date;
  v_last_d date := ((p_to - interval '1 microsecond') at time zone tz)::date;
begin
  perform public.require_admin();
  if p_to <= p_from then
    raise exception 'Invalid period' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'current',  public.profit_totals(p_from, p_to, p_location_id),
    'previous', public.profit_totals(p_from - (p_to - p_from), p_from, p_location_id),

    'expenses_by_category', (
      select coalesce(jsonb_agg(jsonb_build_object('category', x.category, 'amount', x.amount) order by x.amount desc), '[]'::jsonb)
        from (select e.category, sum(e.amount) as amount
                from public.expenses e
               where e.status = 'posted' and e.spent_on >= v_from_d and e.spent_on <= v_last_d
                 and (p_location_id is null or e.location_id = p_location_id)
               group by e.category) x),

    'payments', (
      select coalesce(jsonb_agg(jsonb_build_object('method', x.payment_method, 'orders', x.n, 'amount', x.amount)
                                order by x.amount desc), '[]'::jsonb)
        from (select o.payment_method, count(*) as n, sum(o.total_amount) as amount
                from public.orders o
               where o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
                 and (p_location_id is null or o.location_id = p_location_id)
               group by o.payment_method) x),

    'by_location', (
      select coalesce(jsonb_agg(public.profit_totals(p_from, p_to, l.id)
                                || jsonb_build_object('location_id', l.id, 'name', l.name, 'type', l.type)
                                order by l.sort_order), '[]'::jsonb)
        from public.locations l
       where p_location_id is null
         and (l.is_active or exists (select 1 from public.orders o where o.location_id = l.id
                                       and o.occurred_at >= p_from and o.occurred_at < p_to))),

    'daily', (
      with days as (
        select generate_series(v_from_d, v_last_d, interval '1 day')::date as d
      ),
      s as (
        select (o.occurred_at at time zone tz)::date as d, sum(o.total_amount) as net
          from public.orders o
         where o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
           and (p_location_id is null or o.location_id = p_location_id)
         group by 1
      ),
      c as (
        select (o.occurred_at at time zone tz)::date as d, sum(-sm.qty_delta * coalesce(sm.unit_cost, 0)) as cogs
          from public.orders o
          join public.order_items oi on oi.order_id = o.id
          join public.stock_movements sm on sm.ref_type = 'order_item' and sm.ref_id = oi.id and sm.movement_type = 'SALE_CONSUMPTION'
         where o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
           and (p_location_id is null or o.location_id = p_location_id)
         group by 1
      ),
      -- Wastage and stock-variance losses (a count that found extra stock is a negative loss).
      w as (
        select (sm.occurred_at at time zone tz)::date as d, sum(-sm.qty_delta * coalesce(sm.unit_cost, 0)) as loss
          from public.stock_movements sm
         where sm.occurred_at >= p_from and sm.occurred_at < p_to
           and sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL', 'COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT')
           and (p_location_id is null or sm.location_id = p_location_id)
         group by 1
      ),
      e as (
        select ex.spent_on as d, sum(ex.amount) as amount
          from public.expenses ex
         where ex.status = 'posted' and ex.spent_on >= v_from_d and ex.spent_on <= v_last_d
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

-- Profit per product from actual orders. Order discounts are not split across
-- products (they are shown once, in the P&L).
create function public.product_profit(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (product_id uuid, name text, category text, quantity bigint, sales numeric, cogs numeric,
               profit numeric, margin_pct numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.require_admin();
  return query
    with lines as (
      select oi.id, oi.product_id, oi.quantity, oi.line_total
        from public.orders o
        join public.order_items oi on oi.order_id = o.id
       where o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
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
-- Privileges & realtime
-- ---------------------------------------------------------------------------
revoke execute on function public.profit_totals(timestamptz, timestamptz, uuid) from public, anon, authenticated;

grant execute on function
  public.record_sale(uuid, jsonb, timestamptz, public.payment_method, numeric),
  public.record_expense(uuid, public.expense_category, numeric, date, text, public.payment_method, uuid),
  public.void_expense(uuid, text),
  public.admin_save_location(uuid, text, int, boolean),
  public.profit_summary(timestamptz, timestamptz, uuid),
  public.product_profit(timestamptz, timestamptz, uuid)
to authenticated;

grant select on public.expenses to authenticated;
grant all on public.expenses to service_role;
grant execute on all functions in schema public to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.expenses;
  end if;
end;
$$;
