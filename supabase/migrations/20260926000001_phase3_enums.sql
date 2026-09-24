-- Enum values are added in their own migration: Postgres cannot use a new enum
-- value in the same transaction that adds it.
alter type public.count_status  add value if not exists 'rejected';
alter type public.movement_type add value if not exists 'PURCHASE_REVERSAL';
