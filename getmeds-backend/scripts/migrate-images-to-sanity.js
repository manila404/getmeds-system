#!/usr/bin/env node
/**
 * Copy files from Supabase Storage to Sanity assets. Oct 2, 2026.
 *
 * ADDITIVE ONLY. It reads from Supabase and writes to Sanity. It never deletes
 * or changes anything in Supabase, and never touches the database. The app keeps
 * using Supabase until the code is switched over separately.
 *
 * Needs in .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY),
 * SANITY_PROJECT_ID, SANITY_API_TOKEN (Editor/write token), optionally
 * SANITY_DATASET (default "production") and SUPABASE_PROOF_BUCKET (default "pod").
 *
 *   node scripts/migrate-images-to-sanity.js            dry run: counts only
 *   node scripts/migrate-images-to-sanity.js --run      copy (resumable)
 *   node scripts/migrate-images-to-sanity.js --run --limit 20   first 20 only
 *
 * Progress is kept in scripts/sanity-migration-map.json (storage_path ->
 * Sanity asset id/url), so a re-run skips files already copied.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const db = require('../src/db/database');

const RUN = process.argv.includes('--run');
const li = process.argv.indexOf('--limit');
const LIMIT = li === -1 ? Infinity : Number(process.argv[li + 1]);
const MAP_FILE = path.join(__dirname, 'sanity-migration-map.json');
const BUCKET = process.env.SUPABASE_PROOF_BUCKET || 'pod';
const DATASET = process.env.SANITY_DATASET || 'production';
const PROJECT = process.env.SANITY_PROJECT_ID;
const TOKEN = process.env.SANITY_API_TOKEN;

const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};
const save = () => fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));

async function sanityUpload(buf, filename, contentType) {
  const url = `https://${PROJECT}.api.sanity.io/v2021-06-07/assets/files/${DATASET}?filename=${encodeURIComponent(filename)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': contentType || 'application/octet-stream' },
    body: buf
  });
  if (!res.ok) throw new Error(`Sanity ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { document } = await res.json();
  return { id: document._id, url: document.url };
}

(async () => {
  await db.init();
  const rows = [
    ...(await db.prepare('SELECT storage_path FROM payment_proofs WHERE storage_path IS NOT NULL').all()),
    ...(await db.prepare('SELECT storage_path FROM customer_documents WHERE storage_path IS NOT NULL').all())
  ];
  const paths = [...new Set(rows.map((r) => r.storage_path))];
  const todo = paths.filter((p) => !map[p]);
  console.log(`${paths.length} files in the database, ${paths.length - todo.length} already copied, ${todo.length} to go.`);
  if (!RUN) { console.log('Dry run. Add --run to copy.'); return db.close(); }
  if (!PROJECT || !TOKEN) throw new Error('Set SANITY_PROJECT_ID and SANITY_API_TOKEN in .env first.');

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  let ok = 0, failed = 0;
  for (const p of todo.slice(0, LIMIT)) {
    try {
      const { data, error } = await sb.storage.from(BUCKET).download(p);
      if (error) throw new Error(error.message);
      const buf = Buffer.from(await data.arrayBuffer());
      map[p] = await sanityUpload(buf, p.split('/').pop(), data.type);
      ok++;
      if (ok % 10 === 0) { save(); console.log(`  ${ok} copied…`); }
    } catch (e) {
      failed++;
      console.error(`FAILED ${p}: ${e.message}`);
    }
  }
  save();
  console.log(`Done. Copied ${ok}, failed ${failed}. Map: ${MAP_FILE}`);
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
