-- =============================================================================
-- Cafe SCM — inventory workflows (Phase 3)
-- Receipts, wastage, transfers, stock requests and physical stock counts.
-- Same rules as sales: one call = one transaction, client-generated ids make
-- retries harmless, every quantity change is a ledger row.
-- =============================================================================

alter table public.stock_requests add column resolution_note text;
alter table public.stock_counts   add column reviewed_by uuid references public.profiles (id);
alter table public.stock_counts   add column review_note text;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- Workers always act on their own cart; admins must name an active location.
create function public.resolve_location(p_profile public.profiles, p_location_id uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_profile.role = 'worker' then
    if p_location_id is not null and p_location_id <> p_profile.location_id then
      raise exception 'Workers can only record stock for their own cart' using errcode = '42501';
    end if;
    return p_profile.location_id;
  end if;
  if p_location_id is null or not exists (
       select 1 from public.locations where id = p_location_id and is_active) then
    raise exception 'Choose a valid location' using errcode = '22023';
  end if;
  return p_location_id;
end;
$$;

-- Raises if any of the materials is below zero at the location and negatives are not allowed.
create function public.assert_not_negative(p_location_id uuid, p_material_ids uuid[]) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_names text;
begin
  if (select allow_negative_other from public.app_settings) then
    return;
  end if;
  select string_agg(m.name, ', ' order by m.name) into v_names
    from public.stock_levels sl
    join public.raw_materials m on m.id = sl.material_id
   where sl.location_id = p_location_id and sl.material_id = any (p_material_ids) and sl.quantity < 0;
  if v_names is not null then
    raise exception 'Not enough stock for: %', v_names using errcode = 'P0001';
  end if;
end;
$$;

create function public.clamp_occurred_at(p_at timestamptz) returns timestamptz
language sql stable set search_path = '' as $$
  select least(greatest(coalesce(p_at, clock_timestamp()), clock_timestamp() - interval '72 hours'), clock_timestamp())
$$;

create function public.require_items(p_items jsonb, p_max int default 50) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > p_max then
    raise exception 'Too many items (max %)', p_max using errcode = '22023';
  end if;
end;
$$;

-- Every item's material_id must exist (checked before any row locks, for a clear message).
create function public.require_known_materials(p_items jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from jsonb_array_elements(p_items) e
              where not exists (select 1 from public.raw_materials m where m.id::text = e ->> 'material_id')) then
    raise exception 'Unknown raw material' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Receipts (purchases). Updates the weighted-average cost when a price is given.
-- p_items: [{"material_id", "quantity" (base unit), "entered_qty", "entered_unit", "line_cost" (₹, optional)}]
-- ---------------------------------------------------------------------------
create function public.record_receipt(
  p_receipt_id  uuid,
  p_items       jsonb,
  p_supplier_id uuid default null,
  p_invoice_ref text default null,
  p_notes       text default null,
  p_occurred_at timestamptz default null,
  p_location_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_profile   public.profiles := public.require_profile();
  v_loc       uuid := public.resolve_location(v_profile, p_location_id);
  v_occurred  timestamptz := public.clamp_occurred_at(p_occurred_at);
  v_existing  public.purchase_receipts;
  v_item      record;
  v_material  public.raw_materials;
  v_item_id   uuid;
  v_unit_cost numeric;
  v_on_hand   numeric;
  v_total     numeric(12,2) := 0;
  v_lines     int := 0;
begin
  if p_receipt_id is null then
    raise exception 'Receipt id is required' using errcode = '22023';
  end if;
  perform public.require_items(p_items);
  perform public.require_known_materials(p_items);
  if p_supplier_id is not null and not exists (select 1 from public.suppliers where id = p_supplier_id) then
    raise exception 'Unknown supplier' using errcode = '22023';
  end if;

  insert into public.purchase_receipts (id, location_id, supplier_id, invoice_ref, received_by, occurred_at, notes)
  values (p_receipt_id, v_loc, p_supplier_id, nullif(trim(p_invoice_ref), ''), v_profile.id, v_occurred,
          nullif(trim(p_notes), ''))
  on conflict (id) do nothing;
  if not found then
    select * into v_existing from public.purchase_receipts where id = p_receipt_id;
    if v_existing.received_by <> v_profile.id then
      raise exception 'Receipt id already used' using errcode = '23505';
    end if;
    return jsonb_build_object('status', 'duplicate', 'receipt_id', p_receipt_id, 'total_cost', v_existing.total_cost);
  end if;

  perform public.lock_stock_levels(v_loc,
    array(select (e ->> 'material_id')::uuid from jsonb_array_elements(p_items) e));

  for v_item in
    select (e ->> 'material_id')::uuid as material_id,
           (e ->> 'quantity')::numeric as quantity,
           nullif(e ->> 'entered_qty', '')::numeric as entered_qty,
           nullif(e ->> 'entered_unit', '') as entered_unit,
           nullif(e ->> 'line_cost', '')::numeric as line_cost
      from jsonb_array_elements(p_items) e
     order by 1
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Quantity must be greater than zero' using errcode = '22023';
    end if;
    if v_item.line_cost is not null and v_item.line_cost < 0 then
      raise exception 'Cost cannot be negative' using errcode = '22023';
    end if;

    select * into v_material from public.raw_materials where id = v_item.material_id for update;
    if not found then
      raise exception 'Unknown raw material' using errcode = '22023';
    end if;

    v_unit_cost := case when v_item.line_cost > 0 then round(v_item.line_cost / round(v_item.quantity, 3), 4) end;

    insert into public.purchase_receipt_items
      (receipt_id, material_id, quantity, entered_qty, entered_unit, unit_cost, line_cost)
    values (p_receipt_id, v_item.material_id, round(v_item.quantity, 3), v_item.entered_qty, v_item.entered_unit,
            v_unit_cost, round(v_item.line_cost, 2))
    returning id into v_item_id;

    -- Moving weighted-average cost across all locations (negative balances count as zero).
    if v_unit_cost is not null then
      select coalesce(sum(greatest(quantity, 0)), 0) into v_on_hand
        from public.stock_levels where material_id = v_item.material_id;
      update public.raw_materials
         set avg_unit_cost = round((v_on_hand * avg_unit_cost + round(v_item.quantity, 3) * v_unit_cost)
                                   / (v_on_hand + round(v_item.quantity, 3)), 4)
       where id = v_item.material_id;
    end if;

    perform public.post_movement(
      v_loc, v_item.material_id, round(v_item.quantity, 3), 'PURCHASE', 'receipt_item', v_item_id,
      coalesce(v_unit_cost, v_material.avg_unit_cost), v_occurred, v_profile.id);

    v_total := v_total + coalesce(round(v_item.line_cost, 2), 0);
    v_lines := v_lines + 1;
  end loop;

  update public.purchase_receipts set total_cost = v_total where id = p_receipt_id;
  return jsonb_build_object('status', 'created', 'receipt_id', p_receipt_id, 'total_cost', v_total, 'lines', v_lines);
end;
$$;

create function public.void_receipt(p_receipt_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin   public.profiles := public.require_admin();
  v_receipt public.purchase_receipts;
  v_move    record;
  v_mats    uuid[];
  v_n       int := 0;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  select * into v_receipt from public.purchase_receipts where id = p_receipt_id for update;
  if not found then
    raise exception 'Receipt not found' using errcode = 'P0002';
  end if;
  if v_receipt.status = 'voided' then
    raise exception 'Receipt is already voided' using errcode = '22023';
  end if;

  select array_agg(distinct material_id) into v_mats
    from public.purchase_receipt_items where receipt_id = p_receipt_id;
  perform public.lock_stock_levels(v_receipt.location_id, v_mats);

  for v_move in
    select sm.* from public.stock_movements sm
      join public.purchase_receipt_items ri on ri.id = sm.ref_id
     where sm.ref_type = 'receipt_item' and ri.receipt_id = p_receipt_id and sm.movement_type = 'PURCHASE'
     order by sm.material_id, sm.id
  loop
    perform public.post_movement(v_move.location_id, v_move.material_id, -v_move.qty_delta, 'PURCHASE_REVERSAL',
      'receipt_item', v_move.ref_id, v_move.unit_cost, now(), v_admin.id, 'Void: ' || trim(p_reason), v_move.id);
    v_n := v_n + 1;
  end loop;
  perform public.assert_not_negative(v_receipt.location_id, v_mats);

  update public.purchase_receipts
     set status = 'voided', void_reason = trim(p_reason), voided_by = v_admin.id, voided_at = now()
   where id = p_receipt_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, old_value, new_value)
  values (v_admin.id, 'void', 'purchase_receipts', p_receipt_id::text, jsonb_build_object('status', 'posted'),
          jsonb_build_object('status', 'voided', 'reason', trim(p_reason), 'reversed_movements', v_n));
  return jsonb_build_object('receipt_id', p_receipt_id, 'reversed_movements', v_n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Wastage
-- ---------------------------------------------------------------------------
create function public.record_wastage(
  p_wastage_id   uuid,
  p_material_id  uuid,
  p_quantity     numeric,
  p_reason       public.wastage_reason,
  p_notes        text default null,
  p_entered_qty  numeric default null,
  p_entered_unit text default null,
  p_occurred_at  timestamptz default null,
  p_location_id  uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_profile  public.profiles := public.require_profile();
  v_loc      uuid := public.resolve_location(v_profile, p_location_id);
  v_occurred timestamptz := public.clamp_occurred_at(p_occurred_at);
  v_existing public.wastage;
  v_cost     numeric;
  v_new      numeric;
begin
  if p_wastage_id is null then
    raise exception 'Wastage id is required' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
  end if;
  if p_reason is null then
    raise exception 'Choose a reason' using errcode = '22023';
  end if;
  if p_reason = 'other' and coalesce(trim(p_notes), '') = '' then
    raise exception 'Add a note when the reason is "other"' using errcode = '22023';
  end if;
  select avg_unit_cost into v_cost from public.raw_materials where id = p_material_id;
  if not found then
    raise exception 'Unknown raw material' using errcode = '22023';
  end if;

  insert into public.wastage (id, location_id, material_id, quantity, entered_qty, entered_unit, reason, notes,
                              recorded_by, occurred_at)
  values (p_wastage_id, v_loc, p_material_id, round(p_quantity, 3), p_entered_qty, nullif(p_entered_unit, ''),
          p_reason, nullif(trim(p_notes), ''), v_profile.id, v_occurred)
  on conflict (id) do nothing;
  if not found then
    select * into v_existing from public.wastage where id = p_wastage_id;
    if v_existing.recorded_by <> v_profile.id then
      raise exception 'Wastage id already used' using errcode = '23505';
    end if;
    return jsonb_build_object('status', 'duplicate', 'wastage_id', p_wastage_id);
  end if;

  perform public.lock_stock_levels(v_loc, array[p_material_id]);
  v_new := public.post_movement(v_loc, p_material_id, -round(p_quantity, 3), 'WASTAGE', 'wastage', p_wastage_id,
                                v_cost, v_occurred, v_profile.id, nullif(trim(p_notes), ''));
  perform public.assert_not_negative(v_loc, array[p_material_id]);

  return jsonb_build_object('status', 'created', 'wastage_id', p_wastage_id, 'remaining', v_new,
                            'cost', round(p_quantity * v_cost, 2));
end;
$$;

create function public.void_wastage(p_wastage_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin public.profiles := public.require_admin();
  v_w     public.wastage;
  v_move  public.stock_movements;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  select * into v_w from public.wastage where id = p_wastage_id for update;
  if not found then
    raise exception 'Wastage record not found' using errcode = 'P0002';
  end if;
  if v_w.status = 'voided' then
    raise exception 'Wastage record is already voided' using errcode = '22023';
  end if;

  select * into v_move from public.stock_movements
   where ref_type = 'wastage' and ref_id = p_wastage_id and movement_type = 'WASTAGE';
  perform public.lock_stock_levels(v_w.location_id, array[v_w.material_id]);
  perform public.post_movement(v_w.location_id, v_w.material_id, -v_move.qty_delta, 'WASTAGE_REVERSAL', 'wastage',
                               p_wastage_id, v_move.unit_cost, now(), v_admin.id, 'Void: ' || trim(p_reason), v_move.id);

  update public.wastage set status = 'voided', void_reason = trim(p_reason), voided_by = v_admin.id, voided_at = now()
   where id = p_wastage_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, old_value, new_value)
  values (v_admin.id, 'void', 'wastage', p_wastage_id::text, jsonb_build_object('status', 'posted'),
          jsonb_build_object('status', 'voided', 'reason', trim(p_reason)));
  return jsonb_build_object('wastage_id', p_wastage_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Transfers: stock leaves the source when dispatched (TRANSFER_OUT) and reaches the
-- destination only when received (TRANSFER_IN). In between it is "in transit" and
-- counted at neither location, so it is never double-counted.
-- p_items: [{"material_id", "quantity"}]
-- ---------------------------------------------------------------------------
create function public.create_transfer(
  p_transfer_id      uuid,
  p_from_location_id uuid,
  p_to_location_id   uuid,
  p_items            jsonb,
  p_notes            text default null,
  p_request_id       uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_profile  public.profiles := public.require_profile();
  v_existing public.stock_transfers;
  v_request  public.stock_requests;
  v_item     record;
  v_item_id  uuid;
  v_mats     uuid[];
begin
  if p_transfer_id is null then
    raise exception 'Transfer id is required' using errcode = '22023';
  end if;
  perform public.require_items(p_items);
  perform public.require_known_materials(p_items);
  if v_profile.role = 'worker' and p_from_location_id is distinct from v_profile.location_id then
    raise exception 'Workers can only send stock from their own cart' using errcode = '42501';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'Choose two different locations' using errcode = '22023';
  end if;
  if (select count(*) from public.locations where id in (p_from_location_id, p_to_location_id) and is_active) <> 2 then
    raise exception 'Choose valid locations' using errcode = '22023';
  end if;

  if p_request_id is not null then
    select * into v_request from public.stock_requests where id = p_request_id for update;
    if not found or v_request.location_id <> p_to_location_id or v_request.status not in ('pending', 'approved') then
      raise exception 'The stock request is not open for this destination' using errcode = '22023';
    end if;
    if exists (select 1 from public.stock_transfers
                where request_id = p_request_id and status = 'in_transit' and id <> p_transfer_id) then
      raise exception 'Stock for this request is already on the way' using errcode = '22023';
    end if;
  end if;

  insert into public.stock_transfers (id, from_location_id, to_location_id, request_id, notes, created_by)
  values (p_transfer_id, p_from_location_id, p_to_location_id, p_request_id, nullif(trim(p_notes), ''), v_profile.id)
  on conflict (id) do nothing;
  if not found then
    select * into v_existing from public.stock_transfers where id = p_transfer_id;
    if v_existing.created_by <> v_profile.id then
      raise exception 'Transfer id already used' using errcode = '23505';
    end if;
    return jsonb_build_object('status', 'duplicate', 'transfer_id', p_transfer_id);
  end if;

  select array_agg(distinct (e ->> 'material_id')::uuid) into v_mats from jsonb_array_elements(p_items) e;
  perform public.lock_stock_levels(p_from_location_id, v_mats);

  for v_item in
    select (e ->> 'material_id')::uuid as material_id, sum((e ->> 'quantity')::numeric) as quantity
      from jsonb_array_elements(p_items) e group by 1 order by 1
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Quantity must be greater than zero' using errcode = '22023';
    end if;
    if not exists (select 1 from public.raw_materials where id = v_item.material_id) then
      raise exception 'Unknown raw material' using errcode = '22023';
    end if;
    insert into public.stock_transfer_items (transfer_id, material_id, qty_sent)
    values (p_transfer_id, v_item.material_id, round(v_item.quantity, 3))
    returning id into v_item_id;
    perform public.post_movement(p_from_location_id, v_item.material_id, -round(v_item.quantity, 3), 'TRANSFER_OUT',
      'transfer_item', v_item_id, (select avg_unit_cost from public.raw_materials where id = v_item.material_id),
      now(), v_profile.id);
  end loop;
  perform public.assert_not_negative(p_from_location_id, v_mats);

  if p_request_id is not null then
    update public.stock_requests set status = 'approved', resolved_by = v_profile.id, resolved_at = now()
     where id = p_request_id;
  end if;

  return jsonb_build_object('status', 'created', 'transfer_id', p_transfer_id);
end;
$$;

-- p_items (optional): [{"material_id", "qty_received"}]; omitted items are received in full.
create function public.receive_transfer(p_transfer_id uuid, p_items jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_profile  public.profiles := public.require_profile();
  v_t        public.stock_transfers;
  v_item     record;
  v_received numeric;
  v_short    int := 0;
begin
  select * into v_t from public.stock_transfers where id = p_transfer_id for update;
  if not found or not public.can_access_location(v_t.to_location_id) then
    raise exception 'Transfer not found' using errcode = 'P0002';
  end if;
  if v_t.status = 'received' then
    return jsonb_build_object('status', 'duplicate', 'transfer_id', p_transfer_id);
  end if;
  if v_t.status <> 'in_transit' then
    raise exception 'This transfer was cancelled' using errcode = '22023';
  end if;

  perform public.lock_stock_levels(v_t.to_location_id,
    array(select material_id from public.stock_transfer_items where transfer_id = p_transfer_id));

  for v_item in
    select ti.*, m.avg_unit_cost
      from public.stock_transfer_items ti join public.raw_materials m on m.id = ti.material_id
     where ti.transfer_id = p_transfer_id order by ti.material_id
  loop
    v_received := coalesce(
      (select (e ->> 'qty_received')::numeric from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
        where (e ->> 'material_id')::uuid = v_item.material_id limit 1),
      v_item.qty_sent);
    if v_received < 0 or v_received > v_item.qty_sent then
      raise exception 'Received quantity must be between 0 and the quantity sent' using errcode = '22023';
    end if;
    update public.stock_transfer_items set qty_received = round(v_received, 3) where id = v_item.id;
    if v_received > 0 then
      perform public.post_movement(v_t.to_location_id, v_item.material_id, round(v_received, 3), 'TRANSFER_IN',
        'transfer_item', v_item.id, v_item.avg_unit_cost, now(), v_profile.id);
    end if;
    if v_received < v_item.qty_sent then
      v_short := v_short + 1;
    end if;
  end loop;

  update public.stock_transfers set status = 'received', received_by = v_profile.id, received_at = now()
   where id = p_transfer_id;
  if v_t.request_id is not null then
    update public.stock_requests set status = 'fulfilled', resolved_at = now() where id = v_t.request_id;
  end if;

  return jsonb_build_object('status', 'received', 'transfer_id', p_transfer_id, 'short_items', v_short);
end;
$$;

create function public.cancel_transfer(p_transfer_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin public.profiles := public.require_admin();
  v_t     public.stock_transfers;
  v_move  record;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  select * into v_t from public.stock_transfers where id = p_transfer_id for update;
  if not found then
    raise exception 'Transfer not found' using errcode = 'P0002';
  end if;
  if v_t.status <> 'in_transit' then
    raise exception 'Only transfers in transit can be cancelled' using errcode = '22023';
  end if;

  perform public.lock_stock_levels(v_t.from_location_id,
    array(select material_id from public.stock_transfer_items where transfer_id = p_transfer_id));
  for v_move in
    select sm.* from public.stock_movements sm
      join public.stock_transfer_items ti on ti.id = sm.ref_id
     where sm.ref_type = 'transfer_item' and ti.transfer_id = p_transfer_id and sm.movement_type = 'TRANSFER_OUT'
     order by sm.material_id
  loop
    perform public.post_movement(v_move.location_id, v_move.material_id, -v_move.qty_delta, 'TRANSFER_CANCEL',
      'transfer_item', v_move.ref_id, v_move.unit_cost, now(), v_admin.id, 'Cancelled: ' || trim(p_reason), v_move.id);
  end loop;

  update public.stock_transfers
     set status = 'cancelled', cancelled_by = v_admin.id, cancelled_at = now(),
         notes = concat_ws(E'\n', notes, 'Cancelled: ' || trim(p_reason))
   where id = p_transfer_id;
  if v_t.request_id is not null then
    update public.stock_requests set status = 'pending', resolved_by = null, resolved_at = null
     where id = v_t.request_id and status = 'approved';
  end if;
  return jsonb_build_object('transfer_id', p_transfer_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Stock requests (a cart asks for stock; fulfilled by a transfer or a purchase).
-- ---------------------------------------------------------------------------
create function public.create_stock_request(
  p_request_id  uuid,
  p_items       jsonb,
  p_needed_by   date default null,
  p_notes       text default null,
  p_location_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.profiles := public.require_profile();
  v_loc     uuid := public.resolve_location(v_profile, p_location_id);
  v_existing public.stock_requests;
begin
  if p_request_id is null then
    raise exception 'Request id is required' using errcode = '22023';
  end if;
  perform public.require_items(p_items);

  insert into public.stock_requests (id, location_id, requested_by, needed_by, notes)
  values (p_request_id, v_loc, v_profile.id, p_needed_by, nullif(trim(p_notes), ''))
  on conflict (id) do nothing;
  if not found then
    select * into v_existing from public.stock_requests where id = p_request_id;
    if v_existing.requested_by <> v_profile.id then
      raise exception 'Request id already used' using errcode = '23505';
    end if;
    return jsonb_build_object('status', 'duplicate', 'request_id', p_request_id);
  end if;

  if exists (select 1 from jsonb_array_elements(p_items) e
              where (e ->> 'quantity') is null or (e ->> 'quantity')::numeric <= 0
                 or not exists (select 1 from public.raw_materials m where m.id::text = e ->> 'material_id')) then
    raise exception 'Each item needs a known material and a quantity above zero' using errcode = '22023';
  end if;

  insert into public.stock_request_items (request_id, material_id, quantity)
  select p_request_id, (e ->> 'material_id')::uuid, round(sum((e ->> 'quantity')::numeric), 3)
    from jsonb_array_elements(p_items) e group by 2;

  return jsonb_build_object('status', 'created', 'request_id', p_request_id);
end;
$$;

-- Admin: approve / reject / fulfilled. Worker: may only cancel their own cart's pending request.
create function public.update_stock_request(p_request_id uuid, p_status public.request_status, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.profiles := public.require_profile();
  v_r       public.stock_requests;
begin
  select * into v_r from public.stock_requests where id = p_request_id for update;
  if not found or not public.can_access_location(v_r.location_id) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  if v_profile.role = 'worker' then
    if p_status <> 'cancelled' or v_r.status <> 'pending' then
      raise exception 'You can only cancel a pending request' using errcode = '42501';
    end if;
  elsif p_status not in ('approved', 'rejected', 'fulfilled', 'cancelled') then
    raise exception 'Invalid status' using errcode = '22023';
  elsif v_r.status in ('fulfilled', 'rejected', 'cancelled') then
    raise exception 'This request is already closed' using errcode = '22023';
  end if;
  if p_status = 'rejected' and coalesce(trim(p_note), '') = '' then
    raise exception 'Add a note explaining the rejection' using errcode = '22023';
  end if;

  update public.stock_requests
     set status = p_status, resolved_by = v_profile.id, resolved_at = now(),
         resolution_note = coalesce(nullif(trim(p_note), ''), resolution_note)
   where id = p_request_id;
  return jsonb_build_object('request_id', p_request_id, 'status', p_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- Stock counts. Expected quantities are snapshotted when the count is submitted;
-- the variance (counted − expected) is what gets posted, so sales that happen
-- between counting and approval are not double-corrected.
-- Worker counts wait for admin approval; admin counts post immediately.
-- p_items: [{"material_id", "counted_qty"}] (base units)
-- ---------------------------------------------------------------------------
create function public.post_stock_count_internal(p_count_id uuid, p_admin_id uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_c    public.stock_counts;
  v_item record;
  v_n    int := 0;
begin
  select * into v_c from public.stock_counts where id = p_count_id for update;
  perform public.lock_stock_levels(v_c.location_id,
    array(select material_id from public.stock_count_items where count_id = p_count_id));
  for v_item in
    select ci.*, m.avg_unit_cost from public.stock_count_items ci
      join public.raw_materials m on m.id = ci.material_id
     where ci.count_id = p_count_id and ci.variance <> 0
     order by ci.material_id
  loop
    perform public.post_movement(v_c.location_id, v_item.material_id, v_item.variance, 'COUNT_ADJUSTMENT',
      'count_item', v_item.id, v_item.avg_unit_cost, now(), p_admin_id, 'Stock count');
    v_n := v_n + 1;
  end loop;
  update public.stock_counts set status = 'posted', posted_at = now(), reviewed_by = p_admin_id where id = p_count_id;
  return v_n;
end;
$$;

create function public.submit_stock_count(
  p_count_id    uuid,
  p_items       jsonb,
  p_notes       text default null,
  p_location_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_profile  public.profiles := public.require_profile();
  v_loc      uuid := public.resolve_location(v_profile, p_location_id);
  v_existing public.stock_counts;
  v_mats     uuid[];
  v_status   public.count_status := 'draft';
begin
  if p_count_id is null then
    raise exception 'Count id is required' using errcode = '22023';
  end if;
  perform public.require_items(p_items, 200);

  insert into public.stock_counts (id, location_id, counted_by, counted_at, notes)
  values (p_count_id, v_loc, v_profile.id, clock_timestamp(), nullif(trim(p_notes), ''))
  on conflict (id) do nothing;
  if not found then
    select * into v_existing from public.stock_counts where id = p_count_id;
    if v_existing.counted_by <> v_profile.id then
      raise exception 'Count id already used' using errcode = '23505';
    end if;
    return jsonb_build_object('status', 'duplicate', 'count_id', p_count_id, 'count_status', v_existing.status);
  end if;

  if exists (select 1 from jsonb_array_elements(p_items) e
              where (e ->> 'counted_qty') is null or (e ->> 'counted_qty')::numeric < 0
                 or not exists (select 1 from public.raw_materials m where m.id::text = e ->> 'material_id')) then
    raise exception 'Each line needs a known material and a count of zero or more' using errcode = '22023';
  end if;

  select array_agg(distinct (e ->> 'material_id')::uuid) into v_mats from jsonb_array_elements(p_items) e;
  perform public.lock_stock_levels(v_loc, v_mats);

  insert into public.stock_count_items (count_id, material_id, expected_qty, counted_qty)
  select p_count_id, x.material_id, sl.quantity, x.counted
    from (select (e ->> 'material_id')::uuid as material_id, round(max((e ->> 'counted_qty')::numeric), 3) as counted
            from jsonb_array_elements(p_items) e group by 1) x
    join public.stock_levels sl on sl.location_id = v_loc and sl.material_id = x.material_id;

  if v_profile.role = 'admin' then
    perform public.post_stock_count_internal(p_count_id, v_profile.id);
    v_status := 'posted';
  end if;

  return jsonb_build_object(
    'status', 'created',
    'count_id', p_count_id,
    'count_status', v_status,
    'variances', (select coalesce(jsonb_agg(jsonb_build_object(
                     'material', m.name, 'expected', ci.expected_qty, 'counted', ci.counted_qty,
                     'variance', ci.variance) order by m.name), '[]'::jsonb)
                    from public.stock_count_items ci join public.raw_materials m on m.id = ci.material_id
                   where ci.count_id = p_count_id and ci.variance <> 0));
end;
$$;

create function public.review_stock_count(p_count_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin public.profiles := public.require_admin();
  v_c     public.stock_counts;
  v_n     int := 0;
begin
  select * into v_c from public.stock_counts where id = p_count_id for update;
  if not found then
    raise exception 'Count not found' using errcode = 'P0002';
  end if;
  if v_c.status <> 'draft' then
    raise exception 'This count has already been reviewed' using errcode = '22023';
  end if;

  if p_approve then
    v_n := public.post_stock_count_internal(p_count_id, v_admin.id);
    update public.stock_counts set review_note = nullif(trim(p_note), '') where id = p_count_id;
  else
    if coalesce(trim(p_note), '') = '' then
      raise exception 'Add a note explaining the rejection' using errcode = '22023';
    end if;
    update public.stock_counts set status = 'rejected', reviewed_by = v_admin.id, review_note = trim(p_note)
     where id = p_count_id;
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, new_value)
  values (v_admin.id, case when p_approve then 'approve' else 'reject' end, 'stock_counts', p_count_id::text,
          jsonb_build_object('adjustments', v_n, 'note', nullif(trim(p_note), '')));
  return jsonb_build_object('count_id', p_count_id, 'adjustments', v_n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  public.resolve_location(public.profiles, uuid),
  public.assert_not_negative(uuid, uuid[]),
  public.clamp_occurred_at(timestamptz),
  public.require_items(jsonb, int),
  public.require_known_materials(jsonb),
  public.post_stock_count_internal(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.record_receipt(uuid, jsonb, uuid, text, text, timestamptz, uuid),
  public.void_receipt(uuid, text),
  public.record_wastage(uuid, uuid, numeric, public.wastage_reason, text, numeric, text, timestamptz, uuid),
  public.void_wastage(uuid, text),
  public.create_transfer(uuid, uuid, uuid, jsonb, text, uuid),
  public.receive_transfer(uuid, jsonb),
  public.cancel_transfer(uuid, text),
  public.create_stock_request(uuid, jsonb, date, text, uuid),
  public.update_stock_request(uuid, public.request_status, text),
  public.submit_stock_count(uuid, jsonb, text, uuid),
  public.review_stock_count(uuid, boolean, text)
to authenticated;

grant execute on all functions in schema public to service_role;
