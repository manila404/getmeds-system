/**
 * migrate-storage.js
 *
 * Downloads every file from the OLD Supabase project's "pod" storage bucket
 * and re-uploads it to the NEW project's "pod" bucket.
 *
 * Source paths are read from payment_proofs.storage_path and
 * customer_documents.storage_path in the NEW database (already migrated).
 *
 * Usage:
 *   node scripts/migrate-storage.js
 *
 * Env required (from .env — already pointing at NEW project):
 *   DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');
const path = require('path');

// ── Old project credentials ──────────────────────────────────────────────────
// Set these in .env before running:
//   OLD_SUPABASE_URL=https://<old-ref>.supabase.co
//   OLD_SUPABASE_SERVICE_KEY=sb_secret_...
const OLD_SUPABASE_URL = process.env.OLD_SUPABASE_URL;
const OLD_SERVICE_KEY  = process.env.OLD_SUPABASE_SERVICE_KEY;
const BUCKET = process.env.SUPABASE_PROOF_BUCKET || 'pod';

if (!OLD_SUPABASE_URL || !OLD_SERVICE_KEY) {
  console.error('Missing OLD_SUPABASE_URL or OLD_SUPABASE_SERVICE_KEY in .env');
  console.error('Add them temporarily before running this script, then remove.');
  process.exit(1);
}

// ── Supabase clients ─────────────────────────────────────────────────────────
const oldSupabase = createClient(OLD_SUPABASE_URL, OLD_SERVICE_KEY, {
  auth: { persistSession: false },
});
const newSupabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Infer MIME type from file extension (Blob.type is often empty on node Blob)
function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.pdf': 'application/pdf',
    '.heic': 'image/heic', '.heif': 'image/heif',
  };
  return map[ext] || 'application/octet-stream';
}

async function main() {
  console.log('=== GetMeds Storage Migration ===');
  console.log(`  Old project: ${OLD_SUPABASE_URL}`);
  console.log(`  New project: ${process.env.SUPABASE_URL}`);
  console.log(`  Bucket: ${BUCKET}\n`);

  // ── Collect all storage paths from the new DB ──────────────────────────────
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const { rows: proofRows } = await db.query(
    `SELECT DISTINCT storage_path FROM payment_proofs
     WHERE storage_path IS NOT NULL
     ORDER BY storage_path`
  );
  const { rows: docRows } = await db.query(
    `SELECT DISTINCT storage_path FROM customer_documents
     WHERE storage_path IS NOT NULL
     ORDER BY storage_path`
  );

  await db.end();

  const files = [
    ...proofRows.map(r => ({ storagePath: r.storage_path, table: 'payment_proofs' })),
    ...docRows.map(r => ({ storagePath: r.storage_path, table: 'customer_documents' })),
  ];

  console.log(`Files to migrate: ${files.length} total`);
  console.log(`  payment_proofs:     ${proofRows.length}`);
  console.log(`  customer_documents: ${docRows.length}\n`);

  if (files.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  // ── Check if old project is accessible ────────────────────────────────────
  console.log('Checking old project accessibility...');
  const { data: buckets, error: bucketsErr } = await oldSupabase.storage.listBuckets();
  if (bucketsErr) {
    console.error(`✘ Cannot reach old project: ${bucketsErr.message}`);
    console.error('  The old project may be fully suspended. Contact Supabase support or');
    console.error('  temporarily upgrade it to access the storage files.');
    process.exit(1);
  }
  const oldBucket = (buckets || []).find(b => b.name === BUCKET);
  if (!oldBucket) {
    console.error(`✘ Bucket "${BUCKET}" not found in old project. Buckets found: ${(buckets || []).map(b => b.name).join(', ') || '(none)'}`);
    process.exit(1);
  }
  console.log(`✔ Old project accessible. Bucket "${BUCKET}" found.\n`);

  // ── Migrate files ──────────────────────────────────────────────────────────
  let migrated = 0;
  let alreadyExisted = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < files.length; i++) {
    const { storagePath, table } = files[i];
    const label = `[${i + 1}/${files.length}]`;
    const shortPath = storagePath.length > 60
      ? '...' + storagePath.slice(-57)
      : storagePath;

    process.stdout.write(`${label} ${shortPath} ... `);

    // ── Download from old project ──────────────────────────────────────────
    const { data: blob, error: dlErr } = await oldSupabase.storage
      .from(BUCKET)
      .download(storagePath);

    if (dlErr || !blob) {
      const msg = dlErr?.message || 'no data returned';
      console.log(`✘ download failed: ${msg}`);
      failed++;
      failures.push({ storagePath, table, error: `download: ${msg}` });
      continue;
    }

    // ── Convert Blob → Buffer ──────────────────────────────────────────────
    const arrayBuf = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const contentType = blob.type && blob.type !== 'application/octet-stream'
      ? blob.type
      : mimeFromPath(storagePath);

    // ── Upload to new project (upsert so reruns are safe) ─────────────────
    const { error: upErr } = await newSupabase.storage
      .from(BUCKET)
      .upload(storagePath, buffer, {
        contentType,
        upsert: true,
      });

    if (upErr) {
      const msg = upErr.message;
      console.log(`✘ upload failed: ${msg}`);
      failed++;
      failures.push({ storagePath, table, error: `upload: ${msg}` });
    } else {
      console.log(`✔ ${(buffer.length / 1024).toFixed(0)} KB`);
      migrated++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────');
  console.log(`✅ Migration complete`);
  console.log(`   Migrated:       ${migrated}`);
  console.log(`   Failed:         ${failed}`);

  if (failures.length > 0) {
    console.log('\nFailed files:');
    failures.forEach(f =>
      console.log(`  [${f.table}] ${f.storagePath}\n    → ${f.error}`)
    );
    console.log('\nFailed files were NOT deleted from the old project.');
    console.log('Re-run this script after resolving the issues — upsert mode means no duplicates.');
  }
}

main().catch(err => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});
