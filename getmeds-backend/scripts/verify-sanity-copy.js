#!/usr/bin/env node
/**
 * Check every file in scripts/sanity-migration-map.json against Sanity: the file
 * must be reachable and its size must equal payment_proofs.file_size. Read-only.
 */
require('dotenv').config();
const { Pool } = require('pg');
const map = require('./sanity-migration-map.json');

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  const rows = (await p.query(
    'SELECT DISTINCT ON (storage_path) storage_path, file_size FROM payment_proofs WHERE storage_path IS NOT NULL'
  )).rows;
  await p.end();

  let ok = 0, notCopied = 0; const bad = [];
  for (const r of rows) {
    const a = map[r.storage_path];
    if (!a) { notCopied++; continue; }
    let lastErr = '';
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      try {
        const res = await fetch(a.url, { method: 'HEAD' });
        const len = Number(res.headers.get('content-length'));
        if (res.ok && len === Number(r.file_size)) { ok++; done = true; }
        else lastErr = `status ${res.status}, size ${len} vs ${r.file_size}`;
      } catch (e) { lastErr = e.message; }
    }
    if (!done) bad.push(`${r.storage_path}: ${lastErr}`);
  }
  console.log(`Distinct files in database: ${rows.length}`);
  console.log(`In Sanity and size-verified: ${ok}`);
  console.log(`Not in Sanity (missing in Supabase too): ${notCopied}`);
  console.log(`Problems: ${bad.length}`);
  bad.slice(0, 20).forEach((x) => console.log('  ', x));
})().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
