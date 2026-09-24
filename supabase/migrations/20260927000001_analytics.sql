-- =============================================================================
-- Cafe SCM — admin analytics & realtime (Phase 4)
-- Read-only, admin-only functions. All day boundaries use app_settings.timezone (IST).
-- Money figures use the unit cost frozen on each ledger row, so history never
-- changes when prices change later.
-- =============================================================================

alter table public.app_settings
  add column reorder_cover_days int not null default 7 check (reorder_cover_days between 1 and 60);

-- ---------------------------------------------------------------------------
-- Stock status & runway
--   avg_daily_use = (consumption + wastage over the window) / days covered
--                   (the window, or fewer days if the material is newer than that)
--   days_left     = quantity / avg_daily_use
--   Fewer than min_history_days of activity → no average ("insufficient data").
--   critical: below zero, ≤ minimum level, or runs out within the lead time
--   low:      ≤ reorder level, or runs out within lead time + 2 days
-- Scope: p_location_id null = whole business (material thresholds);
--        a location = that location (its own thresholds, if configured).
-- ---------------------------------------------------------------------------
create function public.stock_status(p_location_id uuid default null)
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
  s public.app_settings;
begin
  perform public.require_admin();
  select * into s from public.app_settings;

  return query
  with qty as (
    select m.id as mid, coalesce(sum(sl.quantity), 0) as q, count(sl.material_id) as held
      from public.raw_materials m
      left join public.stock_levels sl
        on sl.material_id = m.id and (p_location_id is null or sl.location_id = p_location_id)
     where m.is_active
     group by m.id
  ),
  usage_w as (
    select sm.material_id as mid,
           sum(-sm.qty_delta) as used,
           count(distinct (sm.occurred_at at time zone s.timezone)::date)::int as days
      from public.stock_movements sm
     where sm.movement_type in ('SALE_CONSUMPTION', 'SALE_REVERSAL', 'WASTAGE', 'WASTAGE_REVERSAL')
       and sm.occurred_at >= now() - make_interval(days => s.runway_window_days)
       and (p_location_id is null or sm.location_id = p_location_id)
     group by sm.material_id
  ),
  first_use as (
    select sm.material_id as mid, min(sm.occurred_at) as first_at
      from public.stock_movements sm
     where sm.movement_type in ('SALE_CONSUMPTION', 'WASTAGE')
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

-- ---------------------------------------------------------------------------
-- Dashboard summary for a period, with the previous period of equal length.
-- ---------------------------------------------------------------------------
create function public.dashboard_summary(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_prev_from timestamptz := p_from - (p_to - p_from);
  v_result    jsonb;
begin
  perform public.require_admin();
  if p_to <= p_from then
    raise exception 'Invalid period' using errcode = '22023';
  end if;

  with periods(label, f, t) as (values ('current', p_from, p_to), ('previous', v_prev_from, p_from)),
  ord as (
    select p.label, o.location_id, count(*) as orders, sum(o.item_count) as items, sum(o.total_amount) as sales
      from periods p join public.orders o
        on o.status = 'completed' and o.occurred_at >= p.f and o.occurred_at < p.t
     group by 1, 2
  ),
  mov as (
    select p.label, sm.location_id,
           sum(case when sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL') then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as wastage_cost,
           sum(case when sm.movement_type in ('SALE_CONSUMPTION', 'SALE_REVERSAL') then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as consumption_cost
      from periods p join public.stock_movements sm
        on sm.occurred_at >= p.f and sm.occurred_at < p.t
       and sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL', 'SALE_CONSUMPTION', 'SALE_REVERSAL')
     group by 1, 2
  ),
  pur as (
    select p.label, sum(r.total_cost) as purchases
      from periods p join public.purchase_receipts r
        on r.status = 'posted' and r.occurred_at >= p.f and r.occurred_at < p.t
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
       where l.type = 'cart' and l.is_active),
    'pending_requests', (select count(*) from public.stock_requests where status = 'pending'),
    'in_transit', (select count(*) from public.stock_transfers where status = 'in_transit'),
    'oldest_in_transit', (select min(dispatched_at) from public.stock_transfers where status = 'in_transit'),
    -- In transit for more than 6 hours: probably received but not confirmed, or lost.
    'stale_in_transit', (select count(*) from public.stock_transfers
                          where status = 'in_transit' and dispatched_at < now() - interval '6 hours'),
    'counts_to_review', (select count(*) from public.stock_counts where status = 'draft'),
    'negative_stock', (select count(*) from public.stock_levels where quantity < 0)
  ) into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Product sales
-- ---------------------------------------------------------------------------
create function public.product_sales(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (product_id uuid, name text, quantity bigint, sales numeric, orders bigint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.require_admin();
  return query
    select p.id, p.name, sum(oi.quantity)::bigint, sum(oi.line_total), count(distinct o.id)
      from public.orders o
      join public.order_items oi on oi.order_id = o.id
      join public.products p on p.id = oi.product_id
     where o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
       and (p_location_id is null or o.location_id = p_location_id)
     group by p.id, p.name
     order by 3 desc, p.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Material flow: where each material went in the period (base units + ₹ at ledger cost).
-- consumed = recipe-based use by sales ("expected"); count_adjust = inventory variance
-- found by stock counts / admin corrections.
-- ---------------------------------------------------------------------------
create function public.material_flow(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (
  material_id uuid, name text, base_unit text, display_unit text,
  consumed numeric, consumed_cost numeric, wasted numeric, wasted_cost numeric,
  purchased numeric, purchased_cost numeric, transfer_in numeric, transfer_out numeric,
  count_adjust numeric, count_adjust_cost numeric, current_qty numeric
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.require_admin();
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
      where sm.occurred_at >= p_from and sm.occurred_at < p_to
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

-- ---------------------------------------------------------------------------
-- Daily trend (every IST day in the period, zero-filled)
-- ---------------------------------------------------------------------------
create function public.daily_trend(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (day date, orders bigint, items bigint, sales numeric, consumption_cost numeric, wastage_cost numeric, purchase_cost numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  tz text := (select timezone from public.app_settings);
begin
  perform public.require_admin();
  return query
    with days as (
      select generate_series((p_from at time zone tz)::date, ((p_to - interval '1 second') at time zone tz)::date, interval '1 day')::date as d
    ),
    o as (
      select (o.occurred_at at time zone tz)::date as d, count(*) as n, sum(o.item_count) as items, sum(o.total_amount) as sales
        from public.orders o
       where o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
         and (p_location_id is null or o.location_id = p_location_id)
       group by 1
    ),
    m as (
      select (sm.occurred_at at time zone tz)::date as d,
             sum(case when sm.movement_type in ('SALE_CONSUMPTION', 'SALE_REVERSAL') then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as cc,
             sum(case when sm.movement_type in ('WASTAGE', 'WASTAGE_REVERSAL') then -sm.qty_delta * coalesce(sm.unit_cost, 0) else 0 end) as wc
        from public.stock_movements sm
       where sm.occurred_at >= p_from and sm.occurred_at < p_to
         and (p_location_id is null or sm.location_id = p_location_id)
       group by 1
    ),
    r as (
      select (r.occurred_at at time zone tz)::date as d, sum(r.total_cost) as pc
        from public.purchase_receipts r
       where r.status = 'posted' and r.occurred_at >= p_from and r.occurred_at < p_to
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

-- ---------------------------------------------------------------------------
-- Orders by hour of day (IST)
-- ---------------------------------------------------------------------------
create function public.hourly_orders(p_from timestamptz, p_to timestamptz, p_location_id uuid default null)
returns table (hour int, orders bigint, items bigint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  tz text := (select timezone from public.app_settings);
begin
  perform public.require_admin();
  return query
    select h::int, coalesce(x.n, 0), coalesce(x.items, 0)
      from generate_series(0, 23) h
      left join (
        select extract(hour from o.occurred_at at time zone tz)::int as hr, count(*) as n, sum(o.item_count)::bigint as items
          from public.orders o
         where o.status = 'completed' and o.occurred_at >= p_from and o.occurred_at < p_to
           and (p_location_id is null or o.location_id = p_location_id)
         group by 1
      ) x on x.hr = h
     order by h;
end;
$$;

-- ---------------------------------------------------------------------------
-- Weighted-average cost of a material at a point in time, reconstructed from the
-- audit trail of raw_materials. Null when unknown (no cost recorded by then).
-- ---------------------------------------------------------------------------
create function public.material_cost_at(p_material_id uuid, p_at timestamptz) returns numeric
language sql stable security definer set search_path = '' as $$
  select nullif((a.new_value ->> 'avg_unit_cost')::numeric, 0)
    from public.audit_logs a
   where a.entity = 'raw_materials' and a.entity_id = p_material_id::text and a.created_at <= p_at
     and a.new_value ? 'avg_unit_cost'
   order by a.created_at desc, a.id desc
   limit 1
$$;

-- ---------------------------------------------------------------------------
-- Estimated ingredient cost per product: now vs. a comparison date, with the
-- per-ingredient breakdown (recipe in force at each date × cost at each date).
-- ---------------------------------------------------------------------------
create function public.product_costs(p_compare_at timestamptz)
returns table (product_id uuid, name text, selling_price numeric, cost_now numeric, cost_then numeric,
               then_complete boolean, ingredients jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.require_admin();
  return query
    with p as (
      select pr.id, pr.name, pr.selling_price,
             public.recipe_version_at(pr.id, now()) as r_now,
             (select r.id from public.product_recipes r
               where r.product_id = pr.id and r.effective_from <= p_compare_at
               order by r.effective_from desc limit 1) as r_then
        from public.products pr
       where pr.is_active
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
           -- False when a currently-priced ingredient has no cost history at the comparison date.
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

-- ---------------------------------------------------------------------------
-- Purchase analytics
-- ---------------------------------------------------------------------------
create function public.purchases_by_material(p_from timestamptz, p_to timestamptz)
returns table (material_id uuid, name text, base_unit text, display_unit text, quantity numeric, value numeric,
               receipts bigint, last_unit_cost numeric, last_date timestamptz, prev_unit_cost numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.require_admin();
  return query
    with items as (
      select ri.material_id as mid, ri.quantity as q, ri.line_cost as lc, ri.unit_cost as uc, r.occurred_at as at, r.id as rid
        from public.purchase_receipt_items ri
        join public.purchase_receipts r on r.id = ri.receipt_id
       where r.status = 'posted'
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

create function public.purchases_by_supplier(p_from timestamptz, p_to timestamptz)
returns table (supplier_id uuid, name text, receipts bigint, value numeric, materials text[], last_date timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.require_admin();
  return query
    select s.id, coalesce(s.name, 'Not specified'), count(distinct r.id), coalesce(sum(ri.line_cost), 0),
           array_agg(distinct m.name order by m.name), max(r.occurred_at)
      from public.purchase_receipts r
      join public.purchase_receipt_items ri on ri.receipt_id = r.id
      join public.raw_materials m on m.id = ri.material_id
      left join public.suppliers s on s.id = r.supplier_id
     where r.status = 'posted' and r.occurred_at >= p_from and r.occurred_at < p_to
     group by s.id, s.name
     order by 4 desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.material_cost_at(uuid, timestamptz) from public, anon, authenticated;

grant execute on function
  public.stock_status(uuid),
  public.dashboard_summary(timestamptz, timestamptz),
  public.product_sales(timestamptz, timestamptz, uuid),
  public.material_flow(timestamptz, timestamptz, uuid),
  public.daily_trend(timestamptz, timestamptz, uuid),
  public.hourly_orders(timestamptz, timestamptz, uuid),
  public.product_costs(timestamptz),
  public.purchases_by_material(timestamptz, timestamptz),
  public.purchases_by_supplier(timestamptz, timestamptz)
to authenticated;

grant execute on all functions in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Realtime: the admin dashboard and worker screens refresh when these change.
-- Realtime applies RLS, so workers only receive their own cart's rows.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.stock_levels, public.orders, public.stock_requests, public.stock_transfers,
      public.wastage, public.stock_counts, public.purchase_receipts;
  end if;
end;
$$;
