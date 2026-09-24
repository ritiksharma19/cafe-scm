-- =============================================================================
-- Cafe SCM — admin user management
-- Runs as the signed-in admin (not the service role) so the audit trail records
-- which admin made the change.
-- =============================================================================

create function public.admin_update_profile(
  p_user_id     uuid,
  p_full_name   text,
  p_location_id uuid,
  p_is_active   boolean
) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  target public.profiles;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can update users' using errcode = '42501';
  end if;

  select * into target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  if target.id = auth.uid() and not p_is_active then
    raise exception 'You cannot deactivate your own account' using errcode = '22023';
  end if;
  if target.role = 'worker' and not exists (
    select 1 from public.locations l where l.id = p_location_id and l.type = 'cart' and l.is_active
  ) then
    raise exception 'Workers must be assigned to an active cart' using errcode = '22023';
  end if;

  update public.profiles
     set full_name   = coalesce(nullif(trim(p_full_name), ''), full_name),
         location_id = case when role = 'worker' then p_location_id else location_id end,
         is_active   = p_is_active
   where id = p_user_id
  returning * into target;

  return target;
end;
$$;

revoke execute on function public.admin_update_profile(uuid, text, uuid, boolean) from public, anon;
grant execute on function public.admin_update_profile(uuid, text, uuid, boolean) to authenticated, service_role;

-- Records an admin action performed through the service role (e.g. creating an auth user),
-- where auth.uid() would otherwise be empty.
create function public.log_admin_action(
  p_actor_id  uuid,
  p_action    text,
  p_entity    text,
  p_entity_id text,
  p_new_value jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs (actor_id, action, entity, entity_id, new_value)
  values (p_actor_id, p_action, p_entity, p_entity_id, p_new_value);
$$;

revoke execute on function public.log_admin_action(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.log_admin_action(uuid, text, text, text, jsonb) to service_role;
