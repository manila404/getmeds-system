-- Zoho invoice copy: run the sync every 15 minutes from Supabase (Oct 21, 2026).
-- Vercel Hobby can only schedule once a day, so Supabase's scheduler (pg_cron) calls the
-- backend instead, with pg_net. See services/zohoInvoiceCopy.js and cron.controller.js.
--
-- Run ONCE in the Supabase SQL editor of the LIVE project, only after:
--   1. the code is deployed and ZOHO_INVOICE_COPY_SYNC=true is set on Vercel (backend);
--   2. the first load has run:  node scripts/zoho-invoice-copy-backfill.js 2026-01 <this month> --live --verify
-- The CRON_SECRET value is the same one set on Vercel for the backend. Paste it where shown;
-- Vault stores it encrypted and the schedule reads it from there, so it never sits in plain text.

-- 1) The two extensions (or switch them on in Database > Extensions).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) The secret (run once; replace the placeholder, keep the quotes).
select vault.create_secret('PASTE_CRON_SECRET_HERE', 'getmeds_cron_secret', 'Bearer token for /api/cron/*');

-- 3) Every 15 minutes, ask the backend for the newest Zoho changes.
select cron.schedule(
  'zoho-invoice-copy',
  '*/15 * * * *',
  $$
  select net.http_get(
    url := 'https://getmeds-system-backend.vercel.app/api/cron/zoho-invoice-copy',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'getmeds_cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);

-- Check it is scheduled and running:
--   select jobid, schedule, active from cron.job where jobname = 'zoho-invoice-copy';
--   select status, start_time, return_message from cron.job_run_details order by start_time desc limit 5;
--   select status_code, content::text from net._http_response order by created desc limit 5;
-- Pause it:   select cron.unschedule('zoho-invoice-copy');
