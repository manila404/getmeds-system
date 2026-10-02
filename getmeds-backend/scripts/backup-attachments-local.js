#!/usr/bin/env node
/**
 * Download every attachment from Supabase Storage to a local folder, then verify
 * each file's size against the database. Oct 3, 2026. READ-ONLY: nothing in
 * Supabase or the database is changed.
 *
 *   node scripts/backup-attachments-local.js "<target folder>"
 *
 * Resumable: a file already on disk with the right size is skipped.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const db = require('../src/db/database');

const TARGET = process.argv[2];
if (!TARGET) { console.error('Give the target folder as the first argument.'); process.exit(1); }
const BUCKET = process.env.SUPABASE_PROOF_BUCKET || 'pod';

(async () => {
  await db.init();
  const rows = [
    ...(await db.prepare('SELECT storage_path, file_size FROM payment_proofs WHERE storage_path IS NOT NULL').all()),
    ...(await db.prepare('SELECT storage_path, file_size FROM customer_documents WHERE storage_path IS NOT NULL').all())
  ];
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  fs.mkdirSync(TARGET, { recursive: true });

  let ok = 0, skipped = 0, bad = [], failed = [];
  for (const r of rows) {
    const dest = path.join(TARGET, ...r.storage_path.split('/'));
    const want = Number(r.file_size);
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size === want) { skipped++; continue; }
      const { data, error } = await sb.storage.from(BUCKET).download(r.storage_path);
      if (error) throw new Error(error.message);
      const buf = Buffer.from(await data.arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      if (buf.length !== want) bad.push(`${r.storage_path} (disk ${buf.length}, db ${want})`);
      else ok++;
      if ((ok + skipped) % 100 === 0) console.log(`  ${ok + skipped} / ${rows.length}…`);
    } catch (e) {
      failed.push(`${r.storage_path}: ${e.message}`);
    }
  }
  console.log(`Files in database: ${rows.length}`);
  console.log(`Downloaded and verified: ${ok}, already present and verified: ${skipped}`);
  console.log(`Size mismatches: ${bad.length}, failed: ${failed.length}`);
  bad.slice(0, 20).forEach((x) => console.log('  MISMATCH', x));
  failed.slice(0, 20).forEach((x) => console.log('  FAILED', x));
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
