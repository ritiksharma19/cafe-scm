-- =============================================================================
-- Cafe SCM — recipe sheet import also sets prices (Phase 5)
-- Same behaviour as before, plus: a product may carry "selling_price"; when present
-- it is applied (and counted) only if it differs from the current price.
-- The whole import remains one transaction: any error rolls everything back.
-- =============================================================================

create or replace function public.import_recipe_sheet(p_sheet jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin        public.profiles := public.require_admin();
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
    select trim(x.name) as name, x.items, x.selling_price
      from jsonb_to_recordset(coalesce(p_sheet -> 'products', '[]'::jsonb))
           as x(name text, items jsonb, selling_price numeric)
  loop
    if v_prod.selling_price is not null and v_prod.selling_price < 0 then
      raise exception 'Product "%": price cannot be negative', v_prod.name using errcode = '22023';
    end if;

    select * into v_product from public.products where lower(name) = lower(v_prod.name);
    if not found then
      select coalesce(max(sort_order), 0) + 1 into v_next_sort from public.products;
      insert into public.products (name, sort_order, selling_price)
      values (v_prod.name, v_next_sort, coalesce(round(v_prod.selling_price, 2), 0))
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
      join public.raw_materials m on lower(m.name) = lower(trim(i ->> 'material'));

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
