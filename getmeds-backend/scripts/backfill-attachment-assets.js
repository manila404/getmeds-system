#!/usr/bin/env node
/**
 * Fill attachment_assets for the 2,039 files already copied to Sanity. Oct 3, 2026.
 *
 * Needs the attachment_assets table first: run `npm run migrate:pg`.
 *
 *   node scripts/backfill-attachment-assets.js "<backup folder>"             dry run
 *   node scripts/backfill-attachment-assets.js "<backup folder>" --run
 *
 * For each file in scripts/sanity-migration-map.json:
 *   - PDFs, Office files, HEIC: the Sanity FILE asset already uploaded is recorded.
 *   - JPEG / PNG / WEBP photos: re-uploaded from the LOCAL BACKUP as Sanity IMAGE
 *     assets (so the CDN can resize them for thumbnails), recorded, and only then
 *     is the earlier plain-file copy deleted from Sanity.
 *
 * Nothing in Supabase is touched. Resumable: rows already in attachment_assets are
 * skipped. Reads sizes from the backup folder, so a file whose size differs from
 * the database is skipped and reported, not uploaded.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db/database');
const sanity = require('../src/services/sanityStorage');
const map = require('./sanity-migration-map.json');

const BACKUP = process.argv[2];
const RUN = process.argv.includes('--run');
if (!BACKUP) { console.error('Give the backup folder as the first argument.'); process.exit(1); }

(async () => {
  await db.init();
  const rows = await db.prepare(
    'SELECT DISTINCT ON (storage_path) storage_path, content_type, file_name, file_size FROM payment_proofs WHERE storage_path IS NOT NULL'
  ).all();
  const have = new Set((await db.prepare('SELECT storage_path FROM attachment_assets').all()).map((r) => r.storage_path));

  const todo = rows.filter((r) => map[r.storage_path] && !have.has(r.storage_path));
  const images = todo.filter((r) => sanity.isImageType(r.content_type));
  console.log(`${rows.length} files in the database, ${Object.keys(map).length} copied to Sanity, ${have.size} already mapped.`);
  console.log(`To map now: ${todo.length} (${images.length} photos re-uploaded as image assets, ${todo.length - images.length} recorded as files).`);
  if (!RUN) { console.log('Dry run. Add --run.'); return db.close(); }
  if (!sanity.isEnabled()) throw new Error('Set SANITY_PROJECT_ID and SANITY_API_TOKEN in .env first.');

  const insert = db.prepare(
    'INSERT INTO attachment_assets (storage_path, sanity_asset_id, sanity_url, is_image) VALUES (?, ?, ?, ?) ON CONFLICT (storage_path) DO NOTHING'
  );
  let files = 0, converted = 0; const problems = [];
  for (const r of todo) {
    const old = map[r.storage_path];
    try {
      if (sanity.isImageType(r.content_type)) {
        const local = path.join(BACKUP, ...r.storage_path.split('/'));
        if (!fs.existsSync(local) || fs.statSync(local).size !== Number(r.file_size)) throw new Error('backup file missing or wrong size');
        const up = await sanity.upload(fs.readFileSync(local), r.file_name || path.basename(local), r.content_type);
        await insert.run(r.storage_path, up.assetId, up.url, true);
        await sanity.deleteAsset(old.id); // the earlier plain-file copy; nothing refers to it
        converted++;
      } else {
        await insert.run(r.storage_path, old.id, old.url, false);
        files++;
      }
    } catch (e) {
      problems.push(`${r.storage_path}: ${e.message}`);
    }
  }
  console.log(`Mapped as files: ${files}. Converted to image assets: ${converted}. Problems: ${problems.length}`);
  problems.slice(0, 20).forEach((x) => console.log('  ', x));
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
