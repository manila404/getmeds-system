'use strict';

/**
 * Sanity asset storage for attachments. Oct 3, 2026.
 *
 * Files (payment proofs, prescriptions, customer documents) live in Sanity
 * assets; every other piece of data stays in Supabase. The team decided this on
 * Oct 2-3, 2026, mainly to take file storage and download traffic off Supabase.
 *
 * Which Supabase object a Sanity asset stands for is kept in the
 * `attachment_assets` table (storage_path -> sanity_asset_id, sanity_url,
 * is_image). `storage_path` stays the key every other table already uses, so
 * nothing else in the database had to change.
 *
 * THE DATASET IS PUBLIC (Aaron's decision): a file's URL opens for anyone who has
 * it. The URLs are not guessable, but they are not secret either.
 *
 * Photos go in as Sanity IMAGE assets so the CDN can resize them (?w=&h=&fit=)
 * for thumbnails. PDFs, Office files and HEIC go in as plain FILE assets.
 *
 * Not configured (no SANITY_PROJECT_ID / SANITY_API_TOKEN)? isEnabled() is false
 * and the callers behave exactly as they did before this module existed.
 */

const API_VERSION = 'v2021-06-07';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const project = () => process.env.SANITY_PROJECT_ID;
const dataset = () => process.env.SANITY_DATASET || 'production';
const token = () => process.env.SANITY_API_TOKEN;

function isEnabled() {
  return Boolean(project() && token());
}

const isImageType = (contentType) => IMAGE_TYPES.includes(String(contentType || '').toLowerCase());

async function upload(buffer, fileName, contentType) {
  const asImage = isImageType(contentType);
  const kind = asImage ? 'images' : 'files';
  const url =
    `https://${project()}.api.sanity.io/${API_VERSION}/assets/${kind}/${dataset()}` +
    `?filename=${encodeURIComponent(fileName || 'file')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': contentType || 'application/octet-stream' },
    body: buffer
  });
  if (!res.ok) throw new Error(`Sanity upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const { document } = await res.json();
  return { assetId: document._id, url: document.url, isImage: asImage };
}

/** Deletes an asset document. Resolves true when Sanity accepted it. */
async function deleteAsset(assetId) {
  const res = await fetch(`https://${project()}.api.sanity.io/${API_VERSION}/data/mutate/${dataset()}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutations: [{ delete: { id: assetId } }] })
  });
  return res.ok;
}

/**
 * The URL to fetch for a resized rendition of an IMAGE asset. Mirrors the
 * previous Supabase call: both sides -> cropped to fit, one side -> scaled to it.
 */
function resizedUrl(url, { width, height, quality = 75 } = {}) {
  const q = new URLSearchParams();
  if (width) q.set('w', String(width));
  if (height) q.set('h', String(height));
  q.set('fit', width && height ? 'crop' : 'max');
  q.set('q', String(quality));
  q.set('fm', 'jpg');
  return `${url}?${q.toString()}`;
}

/** The URL that makes the browser save the file under `fileName`. */
function downloadUrl(url, fileName) {
  return `${url}?dl=${encodeURIComponent(fileName || '')}`;
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sanity download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { isEnabled, isImageType, upload, deleteAsset, resizedUrl, downloadUrl, fetchBytes };
