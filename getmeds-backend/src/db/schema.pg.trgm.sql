-- Addendum to schema.pg.sql — run AFTER it.
--
-- Sep 2, 2026. Measured correction to one claim in schema.pg.sql.
--
-- schema.pg.sql says of idx_customers_name_lower / idx_products_name_lower:
--
--     "this index supports the case-insensitive form so it does not become a
--      sequential scan"
--
-- Measured against a real PostgreSQL 16 loaded with 95,002 customers, that is
-- not what happens. A B-tree index — functional or not — cannot serve a
-- LEADING-wildcard match, and the autocomplete searches '%term%':
--
--   query                                          plan          time
--   ---------------------------------------------  ------------  --------
--   name ILIKE '%zamboanga%'                        Seq Scan      77.9 ms
--   LOWER(name) LIKE '%zamboanga%'                  Seq Scan      53.3 ms
--   ...same, with enable_seqscan = off              Seq Scan      still
--   name ILIKE '%zamboanga%'  + GIN pg_trgm         Bitmap Index   0.16 ms
--
-- pg_stat_user_indexes confirms it: idx_customers_name_lower had idx_scan = 0
-- after every one of those queries. It is 5.6 MB of a 500 MB free-tier budget
-- doing nothing. Even forcing the planner off sequential scans did not make it
-- usable, because the predicate simply cannot be answered from it.
--
-- 78 ms per keystroke over 95k rows on a warm LOCAL socket. On Supabase free —
-- shared compute, plus a network round trip from the function — it is worse,
-- and it is paid on every keystroke by every MedRep.
--
-- pg_trgm is the index type that answers a leading-wildcard match. It is
-- available on Supabase and Neon. ~480x faster here, for 1 MB more than the
-- index it replaces.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_customers_name_trgm
  ON customers USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_customers_contact_person_trgm
  ON customers USING GIN (contact_person gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_name_trgm
  ON products USING GIN (name gin_trgm_ops);

-- The two B-tree functional indexes these replace are dead weight. Dropping
-- them is safe — nothing can use them for the queries this app runs — but it
-- is left commented out so it is a deliberate act, verified against your own
-- pg_stat_user_indexes after a week of real traffic:
--
--   SELECT indexrelname, idx_scan FROM pg_stat_user_indexes
--    WHERE relname IN ('customers','products');
--
-- DROP INDEX IF EXISTS idx_customers_name_lower;
-- DROP INDEX IF EXISTS idx_products_name_lower;

ANALYZE customers;
ANALYZE products;
