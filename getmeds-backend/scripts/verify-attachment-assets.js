#!/usr/bin/env node
/** Read attachment_assets once, then confirm every Sanity link opens. Read-only. Oct 3, 2026. */
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  const assets = (await p.query('SELECT storage_path, sanity_url FROM attachment_assets')).rows;
  const paths = (await p.query('SELECT DISTINCT storage_path FROM payment_proofs WHERE storage_path IS NOT NULL')).rows;
  await p.end();
  const mapped = new Set(assets.map((a) => a.storage_path));
  let ok = 0; const bad = [];
  for (const a of assets) {
    let good = false;
    for (let t = 0; t < 4 && !good; t++) {
      try { const r = await fetch(a.sanity_url, { method: 'HEAD' }); good = r.ok && Number(r.headers.get('content-length')) > 0; }
      catch { await new Promise((r) => setTimeout(r, 1500)); }
    }
    good ? ok++ : bad.push(a.storage_path);
  }
  console.log(`Mapped: ${assets.length} | links open: ${ok} | problems: ${bad.length}`);
  bad.slice(0, 10).forEach((b) => console.log('  ', b));
  console.log(`Database paths: ${paths.length} | not in Sanity: ${paths.filter((r) => !mapped.has(r.storage_path)).length}`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
