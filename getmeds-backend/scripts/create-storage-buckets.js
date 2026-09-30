/**
 * create-storage-buckets.js
 *
 * Creates the Supabase Storage bucket(s) required by GetMeds in the project
 * pointed to by SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.
 *
 * Run this once after migrating to a new Supabase project.
 * Safe to re-run — skips if the bucket already exists.
 *
 * Usage:
 *   node scripts/create-storage-buckets.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

const BUCKETS = [
  {
    name: process.env.SUPABASE_PROOF_BUCKET || 'pod',
    options: {
      public: false,           // private — access only via signed URLs
      fileSizeLimit: 52428800, // 50 MB per file
      allowedMimeTypes: null,  // allow all types
    },
  },
];

async function main() {
  console.log(`Target project: ${url}\n`);

  const { data: existing, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) {
    console.error('Failed to list buckets:', listErr.message);
    process.exit(1);
  }

  const existingNames = new Set((existing || []).map(b => b.name));
  console.log('Existing buckets:', existingNames.size ? [...existingNames].join(', ') : '(none)');
  console.log('');

  for (const bucket of BUCKETS) {
    if (existingNames.has(bucket.name)) {
      console.log(`  ✔ "${bucket.name}" already exists — skipping`);
      continue;
    }

    process.stdout.write(`  Creating "${bucket.name}"... `);
    const { data, error } = await supabase.storage.createBucket(bucket.name, bucket.options);
    if (error) {
      console.log(`✘ ${error.message}`);
      process.exit(1);
    }
    console.log(`✔ created (id: ${data?.name ?? bucket.name})`);
  }

  // Final listing to confirm
  console.log('\nFinal bucket list:');
  const { data: final, error: finalErr } = await supabase.storage.listBuckets();
  if (finalErr) {
    console.error('Could not list buckets:', finalErr.message);
  } else {
    (final || []).forEach(b =>
      console.log(`  - ${b.name}  (public: ${b.public}, size_limit: ${b.file_size_limit ?? 'none'})`)
    );
  }

  console.log('\n✅ Done. Upload functionality should now work for new files.');
  console.log('   Note: Files stored in the OLD project\'s bucket are not copied here.');
  console.log('   Old attachment links will be broken until those files are migrated separately.');
}

main().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
