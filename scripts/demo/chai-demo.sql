-- =============================================================================
-- Demo data for a tea-stall chain ("Chai Point") — 30 days of history.
--
-- NOT a migration. Run by scripts/seed-demo-chai.mjs as the database owner:
--   1. this file (creates the temporary schema demo_seed) + demo_seed.setup()
--   2. workers are created through Supabase Auth by the script
--   3. demo_seed.run_days() in small chunks, oldest day first
--   4. demo_seed.finish() and `drop schema demo_seed cascade`
--
-- Menu, sizes and add-ons are created with the app's own functions, signed in as
-- the business admin. History is written with the same building blocks the app
-- uses (lock_stock_levels / post_movement / sale_consumption), so every quantity is
-- in the ledger, balances always equal the ledger, and costs are frozen at the time
-- of each event. The only difference from the app: events can be dated up to 30
-- days back (the app itself allows 72 hours).
-- =============================================================================

create schema if not exists demo_seed;
revoke all on schema demo_seed from public;

-- Material plan: supplier, price per base unit (and a price change), stock targets.
create table if not exists demo_seed.materials (
  business_id    uuid,
  name           text,
  unit           text,
  supplier       text,
  cost           numeric,
  new_cost       numeric,     -- price from change_day on (null = no change)
  change_day     int,         -- days ago
  daily          boolean,     -- delivered to every cart each morning (milk, bread, ice)
  cart_target    numeric,     -- per cart at scale 1.0
  central_target numeric,
  primary key (business_id, name)
);

-- Which products sell when (weights for morning / afternoon / evening).
create table if not exists demo_seed.menu (
  business_id uuid,
  product_id  uuid,
  w_morning   numeric,
  w_day       numeric,
  w_evening   numeric
);

create table if not exists demo_seed.carts (
  business_id uuid,
  code        text,
  location_id uuid,
  scale       numeric,
  idx         int
);

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------
create or replace function demo_seed.act_as(p_user uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
end;
$$;

create or replace function demo_seed.ts(p_day date, p_time time) returns timestamptz
language sql immutable as $$ select (p_day + p_time) at time zone 'Asia/Kolkata' $$;

create or replace function demo_seed.mat(p_biz uuid, p_name text) returns uuid
language sql stable set search_path = public, pg_temp as $$
  select id from raw_materials where business_id = p_biz and lower(name) = lower(p_name)
$$;

create or replace function demo_seed.prod(p_biz uuid, p_name text) returns uuid
language sql stable set search_path = public, pg_temp as $$
  select id from products where business_id = p_biz and lower(name) = lower(p_name)
$$;

create or replace function demo_seed.level(p_loc uuid, p_mat uuid) returns numeric
language sql stable set search_path = public, pg_temp as $$
  select coalesce((select quantity from stock_levels where location_id = p_loc and material_id = p_mat), 0)
$$;

create or replace function demo_seed.cost(p_biz uuid, p_name text, p_days_ago int) returns numeric
language sql stable as $$
  select case when m.new_cost is not null and p_days_ago <= m.change_day then m.new_cost else m.cost end
    from demo_seed.materials m where m.business_id = p_biz and m.name = p_name
$$;

-- Round a quantity the way a person would buy it (whole pieces, 100 g / 100 ml).
create or replace function demo_seed.buy_qty(p_unit text, p_q numeric) returns numeric
language sql immutable as $$
  select case when p_q <= 0 then 0
              when p_unit = 'pcs' then ceil(p_q)
              else ceil(p_q / 100) * 100 end
$$;

-- ---------------------------------------------------------------------------
-- Events (mirror the app's functions, but with a given date)
-- ---------------------------------------------------------------------------

-- p_items: [{"m": material_id, "q": base qty, "c": ₹ per base unit}]
create or replace function demo_seed.purchase(p_loc uuid, p_supplier uuid, p_items jsonb, p_at timestamptz, p_by uuid, p_note text default null)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_id    uuid := gen_random_uuid();
  v_it    record;
  v_item  uuid;
  v_hand  numeric;
  v_old   numeric;
  v_new   numeric;
  v_unit  text;
  v_total numeric := 0;
begin
  if coalesce(jsonb_array_length(p_items), 0) = 0 then return; end if;
  insert into purchase_receipts (id, location_id, supplier_id, invoice_ref, received_by, occurred_at, received_at, notes, created_at)
  values (v_id, p_loc, p_supplier, 'INV-' || (1000 + floor(random() * 9000))::int, p_by, p_at, p_at, p_note, p_at);
  perform lock_stock_levels(p_loc, array(select (e ->> 'm')::uuid from jsonb_array_elements(p_items) e));
  for v_it in
    select (e ->> 'm')::uuid as m, (e ->> 'q')::numeric as q, (e ->> 'c')::numeric as c
      from jsonb_array_elements(p_items) e order by 1
  loop
    continue when v_it.q <= 0;
    select display_unit, avg_unit_cost into v_unit, v_old from raw_materials where id = v_it.m;
    insert into purchase_receipt_items (receipt_id, material_id, quantity, entered_qty, entered_unit, unit_cost, line_cost, created_at)
    values (v_id, v_it.m, round(v_it.q, 3), round(v_it.q / (select factor_to_base from units where code = v_unit), 3), v_unit,
            round(v_it.c, 4), round(v_it.q * v_it.c, 2), p_at)
    returning id into v_item;
    -- Moving weighted-average cost, exactly as record_receipt.
    select coalesce(sum(greatest(quantity, 0)), 0) into v_hand from stock_levels where material_id = v_it.m;
    v_new := round((v_hand * v_old + round(v_it.q, 3) * v_it.c) / (v_hand + round(v_it.q, 3)), 4);
    if v_new <> v_old then
      update raw_materials set avg_unit_cost = v_new where id = v_it.m;
      -- Dated cost history, so "cost 30 days ago" comparisons work.
      insert into audit_logs (actor_id, action, entity, entity_id, new_value, created_at)
      values (p_by, 'update', 'raw_materials', v_it.m::text, jsonb_build_object('avg_unit_cost', v_new), p_at);
    end if;
    perform post_movement(p_loc, v_it.m, round(v_it.q, 3), 'PURCHASE', 'receipt_item', v_item, round(v_it.c, 4), p_at, p_by);
    v_total := v_total + round(v_it.q * v_it.c, 2);
  end loop;
  update purchase_receipts set total_cost = v_total where id = v_id;
end;
$$;

-- p_items: [{"p": product_id, "q": qty, "a": [addon_id, …]}]; discount = % of the bill, rounded down to ₹5.
create or replace function demo_seed.sale(p_loc uuid, p_worker uuid, p_items jsonb, p_pay text, p_disc_pct numeric, p_at timestamptz)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare
  v_id    uuid := gen_random_uuid();
  v_line  record;
  v_prod  products;
  v_item  uuid;
  v_add   record;
  v_amt   numeric;
  v_gross numeric := 0;
  v_count int := 0;
  v_disc  numeric;
  v_mats  uuid[];
  c       record;
begin
  insert into orders (id, location_id, worker_id, occurred_at, received_at, payment_method, created_at)
  values (v_id, p_loc, p_worker, p_at, p_at + interval '2 seconds', p_pay::payment_method, p_at);
  for v_line in
    select (e ->> 'p')::uuid as p, (e ->> 'q')::int as q, coalesce(e -> 'a', '[]'::jsonb) as a from jsonb_array_elements(p_items) e
  loop
    select * into v_prod from products where id = v_line.p;
    insert into order_items (order_id, product_id, recipe_id, quantity, unit_price, line_total, created_at)
    values (v_id, v_prod.id, recipe_version_at(v_prod.id, p_at), v_line.q, v_prod.selling_price, v_prod.selling_price * v_line.q, p_at)
    returning id into v_item;
    v_amt := 0;
    for v_add in select a.* from jsonb_array_elements_text(v_line.a) x join addons a on a.id = x::uuid loop
      insert into order_item_addons (order_id, order_item_id, addon_id, quantity, unit_price, line_total, created_at)
      values (v_id, v_item, v_add.id, 1, v_add.price, v_add.price * v_line.q, p_at);
      v_amt := v_amt + v_add.price * v_line.q;
    end loop;
    if v_amt > 0 then update order_items set addons_amount = v_amt where id = v_item; end if;
    v_gross := v_gross + v_prod.selling_price * v_line.q + v_amt;
    v_count := v_count + v_line.q;
  end loop;

  select array_agg(distinct material_id) into v_mats from sale_consumption(v_id);
  perform lock_stock_levels(p_loc, v_mats);
  for c in select * from sale_consumption(v_id) s order by s.material_id, s.order_item_id loop
    perform post_movement(p_loc, c.material_id, -c.qty, 'SALE_CONSUMPTION', 'order_item', c.order_item_id, c.unit_cost, p_at, p_worker);
  end loop;

  v_disc := least(floor(v_gross * p_disc_pct / 100 / 5) * 5, v_gross);
  update orders set item_count = v_count, total_amount = v_gross - v_disc, discount_amount = v_disc where id = v_id;
  return v_id;
end;
$$;

create or replace function demo_seed.void(p_order uuid, p_admin uuid, p_reason text, p_at timestamptz)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_o orders;
  m   record;
begin
  select * into v_o from orders where id = p_order;
  perform lock_stock_levels(v_o.location_id, array(
    select sm.material_id from stock_movements sm join order_items oi on oi.id = sm.ref_id
     where sm.ref_type = 'order_item' and oi.order_id = p_order));
  for m in
    select sm.* from stock_movements sm join order_items oi on oi.id = sm.ref_id
     where sm.ref_type = 'order_item' and oi.order_id = p_order and sm.movement_type = 'SALE_CONSUMPTION'
     order by sm.material_id, sm.id
  loop
    perform post_movement(m.location_id, m.material_id, -m.qty_delta, 'SALE_REVERSAL', 'order_item', m.ref_id, m.unit_cost,
                          p_at, p_admin, 'Void: ' || p_reason, m.id);
  end loop;
  update orders set status = 'voided', void_reason = p_reason, voided_by = p_admin, voided_at = p_at where id = p_order;
  insert into audit_logs (actor_id, action, entity, entity_id, old_value, new_value, created_at)
  values (p_admin, 'void', 'orders', p_order::text, '{"status":"completed"}', jsonb_build_object('status', 'voided', 'reason', p_reason), p_at);
end;
$$;

create or replace function demo_seed.waste(p_loc uuid, p_by uuid, p_mat uuid, p_qty double precision, p_reason text, p_notes text, p_at timestamptz)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid := gen_random_uuid();
begin
  if p_qty <= 0 then return; end if;
  insert into wastage (id, location_id, material_id, quantity, reason, notes, recorded_by, occurred_at, received_at, created_at)
  values (v_id, p_loc, p_mat, round(p_qty::numeric, 3), p_reason::wastage_reason, p_notes, p_by, p_at, p_at, p_at);
  perform lock_stock_levels(p_loc, array[p_mat]);
  perform post_movement(p_loc, p_mat, -round(p_qty::numeric, 3), 'WASTAGE', 'wastage', v_id,
                        (select avg_unit_cost from raw_materials where id = p_mat), p_at, p_by, p_notes);
end;
$$;

-- p_items: [{"m": material_id, "q": qty}] — dispatched at p_sent, received in full at p_recv.
create or replace function demo_seed.transfer(p_from uuid, p_to uuid, p_items jsonb, p_by uuid, p_sent timestamptz,
                                              p_recv_by uuid, p_recv timestamptz, p_request uuid default null, p_note text default null)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_id   uuid := gen_random_uuid();
  v_it   record;
  v_item uuid;
  v_mats uuid[] := array(select (e ->> 'm')::uuid from jsonb_array_elements(p_items) e where (e ->> 'q')::numeric > 0);
begin
  if coalesce(array_length(v_mats, 1), 0) = 0 then return; end if;
  insert into stock_transfers (id, from_location_id, to_location_id, status, request_id, notes, created_by, dispatched_at,
                               received_by, received_at, created_at)
  values (v_id, p_from, p_to, 'received', p_request, p_note, p_by, p_sent, p_recv_by, p_recv, p_sent);
  perform lock_stock_levels(p_from, v_mats);
  perform lock_stock_levels(p_to, v_mats);
  for v_it in
    select (e ->> 'm')::uuid as m, round((e ->> 'q')::numeric, 3) as q from jsonb_array_elements(p_items) e
     where (e ->> 'q')::numeric > 0 order by 1
  loop
    insert into stock_transfer_items (transfer_id, material_id, qty_sent, qty_received) values (v_id, v_it.m, v_it.q, v_it.q)
    returning id into v_item;
    perform post_movement(p_from, v_it.m, -v_it.q, 'TRANSFER_OUT', 'transfer_item', v_item,
                          (select avg_unit_cost from raw_materials where id = v_it.m), p_sent, p_by);
    perform post_movement(p_to, v_it.m, v_it.q, 'TRANSFER_IN', 'transfer_item', v_item,
                          (select avg_unit_cost from raw_materials where id = v_it.m), p_recv, p_recv_by);
  end loop;
end;
$$;

-- A posted (approved) stock count. p_items: [{"m": material_id, "counted": qty}]
create or replace function demo_seed.count(p_loc uuid, p_worker uuid, p_admin uuid, p_items jsonb, p_at timestamptz)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid := gen_random_uuid();
  ci   record;
begin
  insert into stock_counts (id, location_id, counted_by, counted_at, status, notes, posted_at, reviewed_by, review_note, created_at)
  values (v_id, p_loc, p_worker, p_at, 'posted', 'Weekly count', p_at + interval '40 minutes', p_admin, 'OK', p_at);
  perform lock_stock_levels(p_loc, array(select (e ->> 'm')::uuid from jsonb_array_elements(p_items) e));
  insert into stock_count_items (count_id, material_id, expected_qty, counted_qty)
  select v_id, (e ->> 'm')::uuid, demo_seed.level(p_loc, (e ->> 'm')::uuid), greatest(0, round((e ->> 'counted')::numeric, 3))
    from jsonb_array_elements(p_items) e;
  for ci in
    select i.*, m.avg_unit_cost from stock_count_items i join raw_materials m on m.id = i.material_id
     where i.count_id = v_id and i.variance <> 0 order by i.material_id
  loop
    perform post_movement(p_loc, ci.material_id, ci.variance, 'COUNT_ADJUSTMENT', 'count_item', ci.id, ci.avg_unit_cost,
                          p_at + interval '40 minutes', p_admin, 'Stock count');
  end loop;
end;
$$;

create or replace function demo_seed.expense(p_loc uuid, p_cat text, p_amount double precision, p_day date, p_desc text, p_pay text, p_by uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  insert into expenses (id, location_id, category, amount, description, spent_on, payment_method, recorded_by, created_at)
  values (gen_random_uuid(), p_loc, p_cat::expense_category, round(p_amount::numeric, 2), p_desc, p_day, p_pay::payment_method, p_by,
          demo_seed.ts(p_day, '20:00'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Setup: settings, carts, suppliers, menu, sizes, add-ons, levels — through the
-- app's own functions, signed in as the admin. Safe to run again.
-- ---------------------------------------------------------------------------
create or replace function demo_seed.setup(p_code text, p_admin text) returns text
language plpgsql set search_path = public, pg_temp as $$
declare
  v_biz   uuid := (select id from businesses where code = p_code);
  v_admin uuid;
  v_loc   locations;
  v_id    uuid;
  r       record;
  v_sheet jsonb;
begin
  if v_biz is null then raise exception 'No business %', p_code; end if;
  select id into v_admin from profiles where business_id = v_biz and username = p_admin and role = 'admin' and is_active;
  if v_admin is null then raise exception 'No active admin % in %', p_admin, p_code; end if;
  perform demo_seed.act_as(v_admin);

  update app_settings set business_name = 'Chai Point', worker_discount_limit_pct = 10, reorder_cover_days = 5;

  -- Carts
  for r in select * from (values ('CART1', 'Cart 1 — MG Road', 1.0, 1), ('CART2', 'Cart 2 — Station Road', 0.8, 2),
                                 ('CART3', 'Cart 3 — College Gate', 0.65, 3)) x(code, name, scale, idx) loop
    select * into v_loc from locations where business_id = v_biz and code = r.code;
    if v_loc.id is null then
      perform admin_save_location(null, r.name, r.idx, true);
    else
      perform admin_save_location(v_loc.id, r.name, r.idx, true);
    end if;
    delete from demo_seed.carts where business_id = v_biz and code = r.code;
    insert into demo_seed.carts values (v_biz, r.code, (select id from locations where business_id = v_biz and code = r.code), r.scale, r.idx);
  end loop;

  -- Suppliers
  for r in select * from (values
      ('Mother Dairy', '9811000011', 'Milk, butter, cheese, ice cream — daily 6 am delivery'),
      ('Assam Tea Traders', '9811000022', 'Tea, spices, sugar, coffee, honey — weekly'),
      ('Sharma Sabzi Wala', '9811000033', 'Ginger, lemon, onion'),
      ('Bakery Fresh', '9811000044', 'Buns and samosas — daily'),
      ('Metro Wholesale', '9811000055', 'Maggi, cups, ice')) x(name, phone, notes) loop
    if not exists (select 1 from suppliers where business_id = v_biz and lower(name) = lower(r.name)) then
      insert into suppliers (name, phone, notes) values (r.name, r.phone, r.notes);
    end if;
  end loop;

  -- Material plan (₹ per g / ml / pc)
  delete from demo_seed.materials where business_id = v_biz;
  insert into demo_seed.materials values
    (v_biz, 'Milk',              'ml',  'Mother Dairy',      0.056, 0.060, 14, true,  20000, 0),
    (v_biz, 'Tea Leaves',        'g',   'Assam Tea Traders', 0.48,  0.52,  20, false, 2200, 9000),
    (v_biz, 'Sugar',             'g',   'Assam Tea Traders', 0.044, null,  null, false, 9500, 38000),
    (v_biz, 'Ginger',            'g',   'Sharma Sabzi Wala', 0.10,  0.14,  8,  false, 1100, 4500),
    (v_biz, 'Chai Masala',       'g',   'Assam Tea Traders', 1.2,   null,  null, false, 400, 1600),
    (v_biz, 'Cardamom',          'g',   'Assam Tea Traders', 2.8,   3.2,   10, false, 200, 800),
    (v_biz, 'Lemon',             'pcs', 'Sharma Sabzi Wala', 4,     5,     6,  false, 45, 180),
    (v_biz, 'Honey',             'ml',  'Assam Tea Traders', 0.6,   null,  null, false, 1000, 4000),
    (v_biz, 'Coffee Powder',     'g',   'Assam Tea Traders', 1.5,   null,  null, false, 1100, 4500),
    (v_biz, 'Vanilla Ice Cream', 'g',   'Mother Dairy',      0.3,   null,  null, false, 6500, 26000),
    (v_biz, 'Ice',               'g',   'Metro Wholesale',   0.01,  null,  null, true,  7000, 0),
    (v_biz, 'Bun',               'pcs', 'Bakery Fresh',      6,     null,  null, true,  45, 0),
    (v_biz, 'Butter',            'g',   'Mother Dairy',      0.5,   0.54,  12, false, 2800, 11000),
    (v_biz, 'Samosa',            'pcs', 'Bakery Fresh',      8,     9,     12, true,  80, 0),
    (v_biz, 'Maggi Noodles',     'pcs', 'Metro Wholesale',   14,    null,  null, false, 55, 220),
    (v_biz, 'Onion',             'g',   'Sharma Sabzi Wala', 0.035, 0.03,  5,  false, 2400, 9000),
    (v_biz, 'Cheese Slice',      'pcs', 'Mother Dairy',      10,    null,  null, false, 45, 180),
    (v_biz, 'Paper Cup',         'pcs', 'Metro Wholesale',   1.5,   null,  null, false, 850, 3500);

  -- Menu (recipes per ONE item, base units), imported like the Excel import does.
  v_sheet := jsonb_build_object(
    'materials', (select jsonb_agg(jsonb_build_object('name', name, 'base_unit', unit)) from demo_seed.materials where business_id = v_biz),
    'products', jsonb_build_array(
      jsonb_build_object('name', 'Masala Chai', 'selling_price', 20, 'items', '[{"material":"Milk","quantity":100},{"material":"Tea Leaves","quantity":3},{"material":"Sugar","quantity":10},{"material":"Chai Masala","quantity":1},{"material":"Paper Cup","quantity":1}]'::jsonb),
      jsonb_build_object('name', 'Ginger Chai', 'selling_price', 20, 'items', '[{"material":"Milk","quantity":100},{"material":"Tea Leaves","quantity":3},{"material":"Sugar","quantity":10},{"material":"Ginger","quantity":5},{"material":"Paper Cup","quantity":1}]'::jsonb),
      jsonb_build_object('name', 'Elaichi Chai', 'selling_price', 25, 'items', '[{"material":"Milk","quantity":100},{"material":"Tea Leaves","quantity":3},{"material":"Sugar","quantity":10},{"material":"Cardamom","quantity":0.5},{"material":"Paper Cup","quantity":1}]'::jsonb),
      jsonb_build_object('name', 'Lemon Honey Tea', 'selling_price', 30, 'items', '[{"material":"Tea Leaves","quantity":2},{"material":"Lemon","quantity":0.5},{"material":"Honey","quantity":10},{"material":"Paper Cup","quantity":1}]'::jsonb),
      jsonb_build_object('name', 'Cold Coffee', 'selling_price', 80, 'items', '[{"material":"Milk","quantity":200},{"material":"Coffee Powder","quantity":5},{"material":"Sugar","quantity":20},{"material":"Vanilla Ice Cream","quantity":50},{"material":"Ice","quantity":60},{"material":"Paper Cup","quantity":1}]'::jsonb),
      jsonb_build_object('name', 'Bun Maska', 'selling_price', 40, 'items', '[{"material":"Bun","quantity":1},{"material":"Butter","quantity":15}]'::jsonb),
      jsonb_build_object('name', 'Samosa', 'selling_price', 20, 'items', '[{"material":"Samosa","quantity":1}]'::jsonb),
      jsonb_build_object('name', 'Masala Maggi', 'selling_price', 60, 'items', '[{"material":"Maggi Noodles","quantity":1},{"material":"Onion","quantity":20},{"material":"Butter","quantity":5}]'::jsonb)
    ));
  perform import_recipe_sheet(v_sheet);

  -- Sections, tile colours, order
  for r in select * from (values
      ('Masala Chai', 'Chai', '#b45309', 1), ('Ginger Chai', 'Chai', '#ca8a04', 2), ('Elaichi Chai', 'Chai', '#65a30d', 3),
      ('Lemon Honey Tea', 'Chai', '#eab308', 4), ('Cold Coffee', 'Coffee', '#78350f', 5), ('Bun Maska', 'Snacks', '#f59e0b', 6),
      ('Samosa', 'Snacks', '#c2410c', 7), ('Masala Maggi', 'Snacks', '#dc2626', 8)) x(name, cat, color, sort) loop
    update products set category = r.cat, color = r.color, sort_order = r.sort where id = demo_seed.prod(v_biz, r.name);
  end loop;

  -- Sizes (own recipe each)
  for r in select * from (values
      ('Masala Chai', 30, '[{"m":"Milk","q":150},{"m":"Tea Leaves","q":4},{"m":"Sugar","q":15},{"m":"Chai Masala","q":1.5},{"m":"Paper Cup","q":1}]'::jsonb),
      ('Cold Coffee', 110, '[{"m":"Milk","q":300},{"m":"Coffee Powder","q":7},{"m":"Sugar","q":25},{"m":"Vanilla Ice Cream","q":75},{"m":"Ice","q":80},{"m":"Paper Cup","q":1}]'::jsonb)
    ) x(base, price, items) loop
    update products set variant_label = 'Regular' where id = demo_seed.prod(v_biz, r.base);
    v_id := demo_seed.prod(v_biz, r.base || ' Large');
    if v_id is null then
      v_id := create_variant(demo_seed.prod(v_biz, r.base), 'Large', r.price, false);
    end if;
    if not exists (select 1 from product_recipes where product_id = v_id) then
      perform save_recipe(v_id, (select jsonb_agg(jsonb_build_object('material_id', demo_seed.mat(v_biz, i ->> 'm'), 'quantity', (i ->> 'q')::numeric,
                                                                      'entered_qty', (i ->> 'q')::numeric, 'entered_unit',
                                                                      (select unit from demo_seed.materials where business_id = v_biz and name = i ->> 'm')))
                                    from jsonb_array_elements(r.items) i), 'Large size');
    end if;
  end loop;

  -- Recipes in force for the whole demo period.
  update product_recipes set effective_from = now() - interval '45 days'
   where business_id = v_biz and version = 1 and effective_from > now() - interval '45 days';

  -- Add-ons
  for r in select * from (values
      ('Extra ginger', 5, '[{"m":"Ginger","q":3}]'::jsonb, array['Masala Chai', 'Ginger Chai']),
      ('Extra cheese', 20, '[{"m":"Cheese Slice","q":1}]'::jsonb, array['Masala Maggi', 'Bun Maska']),
      ('Extra butter', 10, '[{"m":"Butter","q":10}]'::jsonb, array['Bun Maska', 'Masala Maggi']),
      ('Ice cream scoop', 30, '[{"m":"Vanilla Ice Cream","q":60}]'::jsonb, array['Cold Coffee'])) x(name, price, items, products) loop
    perform save_addon(
      (select id from addons where business_id = v_biz and name = r.name), r.name, r.price, true,
      (select jsonb_agg(jsonb_build_object('material_id', demo_seed.mat(v_biz, i ->> 'm'), 'quantity', (i ->> 'q')::numeric,
                                           'entered_qty', (i ->> 'q')::numeric,
                                           'entered_unit', (select unit from demo_seed.materials where business_id = v_biz and name = i ->> 'm')))
         from jsonb_array_elements(r.items) i),
      array(select demo_seed.prod(v_biz, p) from unnest(r.products) p));
  end loop;

  -- Levels, suppliers, lead times, SKUs (business-wide), and per-cart levels.
  update raw_materials m
     set default_supplier_id = (select s.id from suppliers s where s.business_id = v_biz and s.name = dm.supplier),
         lead_time_days = case when dm.daily then 1 else 2 end,
         min_level      = round(dm.cart_target * 0.5 * 2.45),
         reorder_level  = round(dm.cart_target * 0.9 * 2.45),
         target_level   = round(dm.cart_target * 2.45 + dm.central_target),
         sku            = 'CP-' || upper(left(regexp_replace(dm.name, '[^A-Za-z]', '', 'g'), 6))
    from demo_seed.materials dm
   where dm.business_id = v_biz and m.business_id = v_biz and m.name = dm.name;
  insert into location_material_settings (location_id, material_id, min_level, reorder_level, target_level)
  select c.location_id, demo_seed.mat(v_biz, dm.name), round(dm.cart_target * c.scale * 0.25), round(dm.cart_target * c.scale * 0.45),
         round(dm.cart_target * c.scale)
    from demo_seed.carts c cross join demo_seed.materials dm
   where c.business_id = v_biz and dm.business_id = v_biz
  on conflict (location_id, material_id) do update
     set min_level = excluded.min_level, reorder_level = excluded.reorder_level, target_level = excluded.target_level;

  -- Which products sell when (morning 7–11, day 11–16, evening 16–22).
  delete from demo_seed.menu where business_id = v_biz;
  insert into demo_seed.menu
  select v_biz, demo_seed.prod(v_biz, x.name), x.m, x.d, x.e
    from (values ('Masala Chai', 34, 22, 30), ('Masala Chai Large', 8, 6, 9), ('Ginger Chai', 16, 10, 14),
                 ('Elaichi Chai', 8, 6, 8), ('Lemon Honey Tea', 3, 7, 5), ('Cold Coffee', 2, 14, 7),
                 ('Cold Coffee Large', 1, 5, 3), ('Bun Maska', 16, 5, 6), ('Samosa', 5, 12, 18), ('Masala Maggi', 2, 8, 11)) x(name, m, d, e);

  return 'setup done';
end;
$$;

-- ---------------------------------------------------------------------------
-- One day of business, for days p_from .. p_to days ago (oldest first).
-- ---------------------------------------------------------------------------
create or replace function demo_seed.run_days(p_code text, p_from int, p_to int) returns text
language plpgsql set search_path = public, pg_temp as $$
declare
  v_biz     uuid := (select id from businesses where code = p_code);
  v_admin   uuid;
  v_central uuid;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_day     date;
  v_dow     int;
  v_dom     int;
  d         int;
  c         record;
  dm        record;
  v_worker  uuid;
  v_items   jsonb;
  v_orders  int := 0;
  v_n       int;
  i         int;
  j         int;
  r         numeric;
  v_hour    numeric;
  t         timestamptz;
  v_period  text;
  v_prod    uuid;
  v_q       int;
  v_add     uuid;
  v_lines   jsonb;
  v_pay     text;
  v_disc    numeric;
  v_order   uuid;
  v_req     uuid;
  v_first   boolean;
begin
  select id into v_admin from profiles where business_id = v_biz and role = 'admin' and is_active order by created_at limit 1;
  select id into v_central from locations where business_id = v_biz and type = 'central';
  perform demo_seed.act_as(v_admin);

  for d in reverse p_from .. p_to loop
    v_day := v_today - d;
    v_dow := extract(isodow from v_day);   -- 1 = Monday … 7 = Sunday
    v_dom := extract(day from v_day);
    perform setseed(((extract(doy from v_day)::int * 7919) % 1000) / 1000.0);
    v_first := not exists (select 1 from purchase_receipts where business_id = v_biz);

    -- 1. Morning deliveries to every cart (milk, bread, samosa, ice), topped up to target.
    for c in select * from demo_seed.carts where business_id = v_biz order by idx loop
      exit when demo_seed.ts(v_day, '06:15') > now();
      for dm in select distinct supplier from demo_seed.materials where business_id = v_biz and daily loop
        perform demo_seed.purchase(c.location_id, (select id from suppliers where business_id = v_biz and name = dm.supplier),
          (select jsonb_agg(jsonb_build_object('m', demo_seed.mat(v_biz, x.name),
                             'q', demo_seed.buy_qty(x.unit, x.cart_target * c.scale - demo_seed.level(c.location_id, demo_seed.mat(v_biz, x.name))),
                             'c', demo_seed.cost(v_biz, x.name, d)))
             from demo_seed.materials x
            where x.business_id = v_biz and x.daily and x.supplier = dm.supplier
              and x.cart_target * c.scale - demo_seed.level(c.location_id, demo_seed.mat(v_biz, x.name)) > 0),
          demo_seed.ts(v_day, '06:15') + (c.idx * interval '12 minutes'), v_admin, 'Morning delivery');
      end loop;
    end loop;

    -- 2. Weekly restock of Central on Mondays (and on the first day), then transfers to the carts.
    if (v_first or v_dow = 1) and demo_seed.ts(v_day, '09:00') <= now() then
      for dm in select distinct supplier from demo_seed.materials where business_id = v_biz and not daily loop
        perform demo_seed.purchase(v_central, (select id from suppliers where business_id = v_biz and name = dm.supplier),
          (select jsonb_agg(jsonb_build_object('m', demo_seed.mat(v_biz, x.name),
                             'q', demo_seed.buy_qty(x.unit, x.central_target + x.cart_target * 2.45 - demo_seed.level(v_central, demo_seed.mat(v_biz, x.name))),
                             'c', demo_seed.cost(v_biz, x.name, d)))
             from demo_seed.materials x
            where x.business_id = v_biz and not x.daily and x.supplier = dm.supplier
              and x.central_target + x.cart_target * 2.45 - demo_seed.level(v_central, demo_seed.mat(v_biz, x.name)) > 0),
          demo_seed.ts(v_day, case when v_first then '05:30'::time else '09:00'::time end), v_admin,
          case when v_first then 'Opening stock' else 'Weekly restock' end);
      end loop;
      perform demo_seed.expense(v_central, 'transport', 450, v_day, 'Restock delivery (tempo)', 'cash', v_admin);
    end if;
    if (v_first or v_dow in (1, 4)) and demo_seed.ts(v_day, '10:00') <= now() then
      for c in select * from demo_seed.carts where business_id = v_biz order by idx loop
        v_worker := (select id from profiles where location_id = c.location_id and role = 'worker' and is_active order by created_at limit 1);
        perform demo_seed.transfer(v_central, c.location_id,
          (select jsonb_agg(jsonb_build_object('m', demo_seed.mat(v_biz, x.name),
                             'q', least(demo_seed.level(v_central, demo_seed.mat(v_biz, x.name)),
                                        demo_seed.buy_qty(x.unit, x.cart_target * c.scale - demo_seed.level(c.location_id, demo_seed.mat(v_biz, x.name))))))
             from demo_seed.materials x where x.business_id = v_biz and not x.daily),
          v_admin, demo_seed.ts(v_day, case when v_first then '05:45'::time else '10:00'::time end) + (c.idx * interval '10 minutes'),
          coalesce(v_worker, v_admin), demo_seed.ts(v_day, case when v_first then '06:10'::time else '10:35'::time end) + (c.idx * interval '15 minutes'),
          null, 'Top-up from Central');
      end loop;
    end if;

    -- 3. Sales, 7 am – 10 pm. Busier on weekends; College Gate is quiet on Sundays.
    for c in select * from demo_seed.carts where business_id = v_biz order by idx loop
      v_worker := (select id from profiles where location_id = c.location_id and role = 'worker' and is_active order by random() limit 1);
      continue when v_worker is null;
      v_n := round((40 + random() * 12) * c.scale
                   * case when v_dow in (6, 7) then 1.3 else 1 end
                   * case when c.code = 'CART3' and v_dow = 7 then 0.45 else 1 end);
      for i in 1 .. v_n loop
        r := random();
        v_hour := case when r < 0.36 then 7.25 + random() * 3.75      -- morning rush
                       when r < 0.56 then 11 + random() * 5          -- afternoon
                       when r < 0.92 then 16 + random() * 4          -- evening rush
                       else 20 + random() * 1.9 end;
        v_period := case when v_hour < 11 then 'm' when v_hour < 16 then 'd' else 'e' end;
        t := demo_seed.ts(v_day, make_time(floor(v_hour)::int, floor((v_hour - floor(v_hour)) * 60)::int, floor(random() * 59)::int));
        continue when t > now() - interval '5 minutes';

        v_lines := '[]'::jsonb;
        for j in 1 .. (case when random() < 0.55 then 1 when random() < 0.7 then 2 else 3 end) loop
          select product_id into v_prod from demo_seed.menu
           where business_id = v_biz
           order by -ln(1 - random()) / (case v_period when 'm' then w_morning when 'd' then w_day else w_evening end) limit 1;
          v_q := case when random() < 0.62 then 1 when random() < 0.75 then 2 when random() < 0.8 then 3 else 4 end;
          v_add := null;
          if random() < 0.14 then
            select pa.addon_id into v_add from product_addons pa join products p on p.id = v_prod
             where pa.product_id in (p.id, p.variant_of) order by random() limit 1;
          end if;
          v_lines := v_lines || jsonb_build_array(jsonb_build_object('p', v_prod, 'q', v_q,
                                                   'a', case when v_add is null then '[]'::jsonb else jsonb_build_array(v_add) end));
        end loop;
        r := random();
        v_pay := case when c.code = 'CART3' then (case when r < 0.72 then 'upi' when r < 0.97 then 'cash' else 'card' end)
                      else (case when r < 0.52 then 'upi' when r < 0.94 then 'cash' else 'card' end) end;
        v_disc := case when random() < 0.06 then 10 else 0 end;
        v_order := demo_seed.sale(c.location_id, v_worker, v_lines, v_pay, v_disc, t);
        v_orders := v_orders + 1;
        if random() < 0.007 and t + interval '4 minutes' < now() then
          perform demo_seed.void(v_order, v_admin,
            (array['Entered twice', 'Customer cancelled', 'Wrong item tapped'])[1 + floor(random() * 3)::int], t + interval '4 minutes');
        end if;
      end loop;

      -- 4. Wastage
      v_worker := coalesce((select id from profiles where location_id = c.location_id and role = 'worker' and is_active order by created_at limit 1), v_admin);
      if random() < 0.16 and demo_seed.ts(v_day, '15:30') < now() then
        perform demo_seed.waste(c.location_id, v_worker, demo_seed.mat(v_biz, 'Milk'), 500 + floor(random() * 3) * 250, 'spoiled',
                                'Milk split in the heat', demo_seed.ts(v_day, '15:30'));
      end if;
      if random() < 0.22 and demo_seed.ts(v_day, '18:40') < now() then
        perform demo_seed.waste(c.location_id, v_worker, demo_seed.mat(v_biz, 'Samosa'), 1 + floor(random() * 3), 'dropped', null,
                                demo_seed.ts(v_day, '18:40'));
      end if;
      if random() < 0.12 and demo_seed.ts(v_day, '21:50') < now() then
        perform demo_seed.waste(c.location_id, v_worker, demo_seed.mat(v_biz, 'Bun'), 2 + floor(random() * 4), 'expired',
                                'Stale at closing', demo_seed.ts(v_day, '21:50'));
      end if;
      if random() < 0.05 and demo_seed.ts(v_day, '12:10') < now() then
        perform demo_seed.waste(c.location_id, v_worker, demo_seed.mat(v_biz, 'Tea Leaves'), 50, 'prep_waste', 'Spilled while brewing',
                                demo_seed.ts(v_day, '12:10'));
      end if;

      -- 5. Cart expenses
      continue when demo_seed.ts(v_day, '20:00') > now();
      if (d + c.idx * 3) % 8 = 0 then
        perform demo_seed.expense(c.location_id, 'gas_fuel', 1150, v_day, 'LPG cylinder refill', 'cash', v_worker);
      end if;
      if v_dow = 6 then
        perform demo_seed.expense(c.location_id, 'salaries', round(3200 * c.scale / 100) * 100, v_day, 'Weekly helper wages', 'upi', v_admin);
      end if;
      if v_dom = 5 then
        perform demo_seed.expense(c.location_id, 'fees_taxes', 1200, v_day, 'Municipal vending fee', 'upi', v_admin);
      end if;
      if random() < 0.25 then
        perform demo_seed.expense(c.location_id, 'other', 40 + floor(random() * 9) * 10, v_day, 'Cleaning supplies', 'cash', v_worker);
      end if;
      if random() < 0.12 then
        perform demo_seed.expense(c.location_id, 'packaging', 150, v_day, 'Napkins & stirrers', 'cash', v_worker);
      end if;
      if random() < 0.05 then
        perform demo_seed.expense(c.location_id, 'maintenance', 300 + floor(random() * 7) * 100, v_day,
          (array['Stove repair', 'Canopy fix', 'Kettle replaced'])[1 + floor(random() * 3)::int], 'cash', v_admin);
      end if;

      -- 6. Weekly stock count on Sunday night (approved), with the usual small differences.
      if v_dow = 7 and demo_seed.ts(v_day, '22:15') < now() then
        perform demo_seed.count(c.location_id, v_worker, v_admin,
          jsonb_build_array(
            jsonb_build_object('m', demo_seed.mat(v_biz, 'Milk'),       'counted', demo_seed.level(c.location_id, demo_seed.mat(v_biz, 'Milk')) * (0.98 + random() * 0.015)),
            jsonb_build_object('m', demo_seed.mat(v_biz, 'Paper Cup'),  'counted', demo_seed.level(c.location_id, demo_seed.mat(v_biz, 'Paper Cup')) - floor(random() * 7)),
            jsonb_build_object('m', demo_seed.mat(v_biz, 'Samosa'),     'counted', demo_seed.level(c.location_id, demo_seed.mat(v_biz, 'Samosa')) - floor(random() * 3)),
            jsonb_build_object('m', demo_seed.mat(v_biz, 'Tea Leaves'), 'counted', demo_seed.level(c.location_id, demo_seed.mat(v_biz, 'Tea Leaves')) * (0.985 + random() * 0.015)),
            jsonb_build_object('m', demo_seed.mat(v_biz, 'Sugar'),      'counted', demo_seed.level(c.location_id, demo_seed.mat(v_biz, 'Sugar')) * (0.99 + random() * 0.01))),
          demo_seed.ts(v_day, '22:15'));
      end if;
    end loop;

    -- 7. Business-wide expenses
    if v_dom = 1 then
      perform demo_seed.expense(null, 'rent', 15000, v_day, 'Monthly rent — central kitchen & store', 'upi', v_admin);
    end if;
    if v_dom = 10 then
      perform demo_seed.expense(v_central, 'utilities', 2400, v_day, 'Electricity bill', 'upi', v_admin);
    end if;
    if d = 18 then
      perform demo_seed.expense(null, 'marketing', 3000, v_day, 'Instagram ads & pamphlets', 'upi', v_admin);
    end if;
    if v_dom = 15 then
      perform demo_seed.expense(null, 'fees_taxes', 800, v_day, 'Accountant', 'upi', v_admin);
    end if;

    -- 8. A cart asks for extra stock on Fridays; fulfilled on Saturday (one week rejected).
    if v_dow = 5 and demo_seed.ts(v_day + 1, '08:30') < now() then
      select * into c from demo_seed.carts x where x.business_id = v_biz and x.code = 'CART3';
      v_worker := coalesce((select id from profiles where location_id = c.location_id and role = 'worker' order by created_at limit 1), v_admin);
      v_req := gen_random_uuid();
      insert into stock_requests (id, location_id, requested_by, status, needed_by, notes, resolved_by, resolved_at, resolution_note, created_at)
      values (v_req, c.location_id, v_worker, case when d between 12 and 18 then 'rejected' else 'fulfilled' end::request_status,
              v_day + 1, 'College fest this weekend', v_admin, demo_seed.ts(v_day + 1, '08:30'),
              case when d between 12 and 18 then 'Enough stock at the cart — check the back shelf' end, demo_seed.ts(v_day, '18:00'));
      insert into stock_request_items (request_id, material_id, quantity) values
        (v_req, demo_seed.mat(v_biz, 'Paper Cup'), 200), (v_req, demo_seed.mat(v_biz, 'Maggi Noodles'), 15);
      if not (d between 12 and 18) then
        perform demo_seed.transfer(v_central, c.location_id,
          jsonb_build_array(jsonb_build_object('m', demo_seed.mat(v_biz, 'Paper Cup'), 'q', least(200, demo_seed.level(v_central, demo_seed.mat(v_biz, 'Paper Cup')))),
                            jsonb_build_object('m', demo_seed.mat(v_biz, 'Maggi Noodles'), 'q', least(15, demo_seed.level(v_central, demo_seed.mat(v_biz, 'Maggi Noodles'))))),
          v_admin, demo_seed.ts(v_day + 1, '08:00'), v_worker, demo_seed.ts(v_day + 1, '08:30'), v_req, 'For request');
      end if;
    end if;
  end loop;

  return format('%s orders for days %s..%s', v_orders, p_from, p_to);
end;
$$;

-- ---------------------------------------------------------------------------
-- Things that are open right now (through the app's own functions).
-- ---------------------------------------------------------------------------
create or replace function demo_seed.finish(p_code text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_biz   uuid := (select id from businesses where code = p_code);
  v_admin uuid := (select id from profiles where business_id = v_biz and role = 'admin' and is_active order by created_at limit 1);
  v_w2    uuid := (select p.id from profiles p join locations l on l.id = p.location_id where l.business_id = v_biz and l.code = 'CART2' and p.is_active order by p.created_at limit 1);
  v_w3    uuid := (select p.id from profiles p join locations l on l.id = p.location_id where l.business_id = v_biz and l.code = 'CART3' and p.is_active order by p.created_at limit 1);
  v_cart1 uuid := (select id from locations where business_id = v_biz and code = 'CART1');
  v_cart2 uuid := (select id from locations where business_id = v_biz and code = 'CART2');
  v_central uuid := (select id from locations where business_id = v_biz and type = 'central');
begin
  -- Cart 2's count waits for the owner's approval.
  if v_w2 is not null then
    perform demo_seed.act_as(v_w2);
    perform submit_stock_count(gen_random_uuid(), jsonb_build_array(
      jsonb_build_object('material_id', demo_seed.mat(v_biz, 'Paper Cup'), 'counted_qty', greatest(0, demo_seed.level(v_cart2, demo_seed.mat(v_biz, 'Paper Cup')) - 9)),
      jsonb_build_object('material_id', demo_seed.mat(v_biz, 'Samosa'), 'counted_qty', greatest(0, demo_seed.level(v_cart2, demo_seed.mat(v_biz, 'Samosa')) - 2))),
      'Mid-week check');
  end if;
  -- Cart 3 asks for stock for tomorrow.
  if v_w3 is not null then
    perform demo_seed.act_as(v_w3);
    perform create_stock_request(gen_random_uuid(), jsonb_build_array(
      jsonb_build_object('material_id', demo_seed.mat(v_biz, 'Paper Cup'), 'quantity', 300),
      jsonb_build_object('material_id', demo_seed.mat(v_biz, 'Coffee Powder'), 'quantity', 500)),
      (now() at time zone 'Asia/Kolkata')::date + 1, 'Running low before the weekend');
  end if;
  -- Stock on the way from Central to Cart 1.
  perform demo_seed.act_as(v_admin);
  perform create_transfer(gen_random_uuid(), v_central, v_cart1, jsonb_build_array(
    jsonb_build_object('material_id', demo_seed.mat(v_biz, 'Sugar'), 'quantity', least(2000, demo_seed.level(v_central, demo_seed.mat(v_biz, 'Sugar')))),
    jsonb_build_object('material_id', demo_seed.mat(v_biz, 'Chai Masala'), 'quantity', least(100, demo_seed.level(v_central, demo_seed.mat(v_biz, 'Chai Masala'))))),
    'Evening top-up');

  return profit_summary(((now() at time zone 'Asia/Kolkata')::date - 29)::timestamp at time zone 'Asia/Kolkata', now() + interval '1 hour', null)
         -> 'current';
end;
$$;
