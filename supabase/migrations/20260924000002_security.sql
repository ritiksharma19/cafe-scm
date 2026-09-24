-- =============================================================================
-- Cafe SCM — authorization, integrity and audit
--
-- Model:
--   * Workers may READ catalog data and their own cart's operational data.
--   * Workers may NOT write any table directly. Every inventory-changing event
--     goes through SECURITY DEFINER functions (added in later migrations) which
--     derive the location from the caller's profile, never from the client.
--   * Admin may read everything and edit master data (RLS-gated).
--   * Ledger and audit rows are append-only for everyone.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Identity helpers (SECURITY DEFINER so RLS on profiles does not recurse)
-- ---------------------------------------------------------------------------
create function public.current_role_name() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.is_active
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role = 'admin' from public.profiles p where p.id = auth.uid() and p.is_active), false)
$$;

create function public.my_location_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.location_id from public.profiles p where p.id = auth.uid() and p.is_active
$$;

-- True when the caller is admin or is an active worker assigned to the location.
create function public.can_access_location(p_location_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or (p_location_id is not null and p_location_id = public.my_location_id())
$$;

-- ---------------------------------------------------------------------------
-- Profiles are created from auth.users. Role / cart come from app_metadata,
-- which only the service role can set — users cannot promote themselves.
-- A worker without a cart violates profiles_worker_has_location, so stray
-- sign-ups fail even if public sign-up were accidentally enabled.
-- ---------------------------------------------------------------------------
create function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(new.raw_app_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (id, username, full_name, role, location_id)
  values (
    new.id,
    lower(coalesce(meta ->> 'username', split_part(new.email, '@', 1))),
    coalesce(meta ->> 'full_name', meta ->> 'username', split_part(new.email, '@', 1)),
    coalesce((meta ->> 'role')::public.user_role, 'worker'),
    nullif(meta ->> 'location_id', '')::uuid
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------
create function public.prevent_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% on % is not allowed: history is append-only (use a reversal/correction)',
    tg_op, tg_table_name using errcode = '42501';
end;
$$;

-- Ledger + audit: no UPDATE, no DELETE, for anyone.
create trigger stock_movements_append_only before update or delete on public.stock_movements
  for each row execute function public.prevent_mutation();
create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function public.prevent_mutation();

-- Business documents: status may change (void), rows may never be deleted.
create trigger no_delete before delete on public.orders                 for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.order_items            for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.purchase_receipts      for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.purchase_receipt_items for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.wastage                for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.stock_transfers        for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.stock_transfer_items   for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.stock_counts           for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.stock_count_items      for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.product_recipes        for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.recipe_items           for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.products               for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.raw_materials          for each row execute function public.prevent_mutation();
create trigger no_delete before delete on public.locations              for each row execute function public.prevent_mutation();

-- Recipe items are frozen once written (edit = new recipe version).
create trigger recipe_items_frozen before update on public.recipe_items
  for each row execute function public.prevent_mutation();

-- A material's display unit must convert to its base unit.
create function public.check_material_units() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select u.base_code from public.units u where u.code = new.base_unit) <> new.base_unit then
    raise exception 'base_unit % is not a base unit', new.base_unit using errcode = '23514';
  end if;
  if (select u.base_code from public.units u where u.code = new.display_unit) <> new.base_unit then
    raise exception 'display_unit % does not convert to base unit %', new.display_unit, new.base_unit
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger check_material_units before insert or update of base_unit, display_unit on public.raw_materials
  for each row execute function public.check_material_units();

-- Base unit can never change once stock exists (would silently rescale history).
create function public.lock_base_unit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.base_unit <> old.base_unit
     and exists (select 1 from public.stock_movements m where m.material_id = old.id) then
    raise exception 'Cannot change base unit of a material that has stock movements' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger lock_base_unit before update of base_unit on public.raw_materials
  for each row execute function public.lock_base_unit();

-- ---------------------------------------------------------------------------
-- Audit trail for master data
-- ---------------------------------------------------------------------------
create function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_j jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_j jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  if tg_op = 'UPDATE' and old_j = new_j then
    return new;
  end if;
  insert into public.audit_logs (actor_id, action, entity, entity_id, old_value, new_value)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce(new_j ->> 'id', old_j ->> 'id', new_j ->> 'code', old_j ->> 'code',
             concat_ws(':', coalesce(new_j, old_j) ->> 'location_id', coalesce(new_j, old_j) ->> 'material_id')),
    old_j,
    new_j
  );
  return coalesce(new, old);
end;
$$;

create trigger audit after insert or update or delete on public.locations                  for each row execute function public.audit_row_change();
create trigger audit after insert or update or delete on public.profiles                   for each row execute function public.audit_row_change();
create trigger audit after insert or update or delete on public.app_settings               for each row execute function public.audit_row_change();
create trigger audit after insert or update or delete on public.units                      for each row execute function public.audit_row_change();
create trigger audit after insert or update or delete on public.suppliers                  for each row execute function public.audit_row_change();
create trigger audit after insert or update or delete on public.raw_materials              for each row execute function public.audit_row_change();
create trigger audit after insert or update or delete on public.material_unit_conversions  for each row execute function public.audit_row_change();
create trigger audit after insert or update or delete on public.location_material_settings for each row execute function public.audit_row_change();
create trigger audit after insert or update or delete on public.products                   for each row execute function public.audit_row_change();
create trigger audit after insert or update           on public.product_recipes            for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------------
-- Privileges: deny by default, then grant precisely.
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;           -- rows filtered by RLS
grant execute on function public.current_role_name(), public.is_admin(),
                          public.my_location_id(), public.can_access_location(uuid) to authenticated;

-- Master data editable by admin (RLS enforces admin-only).
grant insert, update on public.locations, public.app_settings, public.units, public.suppliers,
                        public.raw_materials, public.products to authenticated;
grant insert, update, delete on public.material_unit_conversions, public.location_material_settings to authenticated;

-- Service role (server-side only) keeps full access; it bypasses RLS by design.
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.locations                  enable row level security;
alter table public.profiles                   enable row level security;
alter table public.app_settings               enable row level security;
alter table public.units                      enable row level security;
alter table public.suppliers                  enable row level security;
alter table public.raw_materials              enable row level security;
alter table public.material_unit_conversions  enable row level security;
alter table public.location_material_settings enable row level security;
alter table public.products                   enable row level security;
alter table public.product_recipes            enable row level security;
alter table public.recipe_items               enable row level security;
alter table public.orders                     enable row level security;
alter table public.order_items                enable row level security;
alter table public.purchase_receipts          enable row level security;
alter table public.purchase_receipt_items     enable row level security;
alter table public.wastage                    enable row level security;
alter table public.stock_requests             enable row level security;
alter table public.stock_request_items        enable row level security;
alter table public.stock_transfers            enable row level security;
alter table public.stock_transfer_items       enable row level security;
alter table public.stock_counts               enable row level security;
alter table public.stock_count_items          enable row level security;
alter table public.stock_movements            enable row level security;
alter table public.stock_levels               enable row level security;
alter table public.audit_logs                 enable row level security;

-- Reference / catalog: any signed-in active user may read; admin writes.
create policy read_all on public.locations     for select to authenticated using (public.current_role_name() is not null);
create policy read_all on public.app_settings  for select to authenticated using (public.current_role_name() is not null);
create policy read_all on public.units         for select to authenticated using (public.current_role_name() is not null);
create policy read_all on public.suppliers     for select to authenticated using (public.current_role_name() is not null);
create policy read_all on public.raw_materials for select to authenticated using (public.current_role_name() is not null);
create policy read_all on public.material_unit_conversions  for select to authenticated using (public.current_role_name() is not null);
create policy read_all on public.location_material_settings for select to authenticated using (public.current_role_name() is not null);
create policy read_all on public.products        for select to authenticated using (public.current_role_name() is not null);
create policy read_all on public.product_recipes for select to authenticated using (public.current_role_name() is not null);
create policy read_all on public.recipe_items    for select to authenticated using (public.current_role_name() is not null);

create policy admin_insert on public.locations     for insert to authenticated with check (public.is_admin());
create policy admin_update on public.locations     for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_update on public.app_settings  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_insert on public.units         for insert to authenticated with check (public.is_admin());
create policy admin_update on public.units         for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_insert on public.suppliers     for insert to authenticated with check (public.is_admin());
create policy admin_update on public.suppliers     for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_insert on public.raw_materials for insert to authenticated with check (public.is_admin());
create policy admin_update on public.raw_materials for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_insert on public.products      for insert to authenticated with check (public.is_admin());
create policy admin_update on public.products      for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.material_unit_conversions  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.location_material_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- People
create policy read_self_or_admin on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- Operational data: own location (worker) or everything (admin). No direct writes.
create policy read_scoped on public.orders            for select to authenticated using (public.can_access_location(location_id));
create policy read_scoped on public.purchase_receipts for select to authenticated using (public.can_access_location(location_id));
create policy read_scoped on public.wastage           for select to authenticated using (public.can_access_location(location_id));
create policy read_scoped on public.stock_requests    for select to authenticated using (public.can_access_location(location_id));
create policy read_scoped on public.stock_counts      for select to authenticated using (public.can_access_location(location_id));
create policy read_scoped on public.stock_movements   for select to authenticated using (public.can_access_location(location_id));
create policy read_scoped on public.stock_levels      for select to authenticated using (public.can_access_location(location_id));
create policy read_scoped on public.stock_transfers   for select to authenticated
  using (public.can_access_location(from_location_id) or public.can_access_location(to_location_id));

create policy read_scoped on public.order_items for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_id and public.can_access_location(o.location_id)));
create policy read_scoped on public.purchase_receipt_items for select to authenticated using (
  exists (select 1 from public.purchase_receipts r where r.id = receipt_id and public.can_access_location(r.location_id)));
create policy read_scoped on public.stock_request_items for select to authenticated using (
  exists (select 1 from public.stock_requests r where r.id = request_id and public.can_access_location(r.location_id)));
create policy read_scoped on public.stock_transfer_items for select to authenticated using (
  exists (select 1 from public.stock_transfers t where t.id = transfer_id
          and (public.can_access_location(t.from_location_id) or public.can_access_location(t.to_location_id))));
create policy read_scoped on public.stock_count_items for select to authenticated using (
  exists (select 1 from public.stock_counts c where c.id = count_id and public.can_access_location(c.location_id)));

create policy admin_read on public.audit_logs for select to authenticated using (public.is_admin());
