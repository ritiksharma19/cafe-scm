-- =============================================================================
-- Cafe SCM — reference data required in every environment
-- =============================================================================

insert into public.app_settings (id) values (true);

insert into public.locations (code, name, type, sort_order) values
  ('CENTRAL', 'Central Storage', 'central', 0),
  ('CART1',   'Cart 1',          'cart',    1),
  ('CART2',   'Cart 2',          'cart',    2),
  ('CART3',   'Cart 3',          'cart',    3);

-- Base units first (they reference themselves), then derived units.
insert into public.units (code, name, base_code, factor_to_base, sort_order) values
  ('g',   'Gram',       'g',   1, 1),
  ('ml',  'Millilitre', 'ml',  1, 3),
  ('pcs', 'Pieces',     'pcs', 1, 5);

insert into public.units (code, name, base_code, factor_to_base, sort_order) values
  ('kg',    'Kilogram', 'g',   1000, 2),
  ('l',     'Litre',    'ml',  1000, 4),
  ('dozen', 'Dozen',    'pcs', 12,   6);
