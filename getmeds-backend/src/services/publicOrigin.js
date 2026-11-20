/**
 * The backend's own public address (e.g. "https://api-hub.bishnoi.ai"), for links it hands to the
 * browser such as attachment view / download links. Nov 20, 2026 (Aaron).
 *
 * Why: on Vercel the request said https. Behind Cloudflare Tunnel + Coolify's proxy it says http,
 * so the links came out as http://... The preview still showed (browsers upgrade images), but
 * Chrome blocks a DOWNLOAD from an http link on an https page, so Download did nothing.
 *
 * Order: PUBLIC_API_URL if set; else Cloudflare's own record of the visitor's scheme (cf-visitor);
 * else the first X-Forwarded-Proto; and a public host is always https (only a local or LAN host,
 * i.e. mock / dev, keeps http).
 */
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

function first(v) {
  return String(v || '').split(',')[0].trim();
}

function publicOrigin(req) {
  const fixed = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (fixed) return fixed;

  const host = first(req.headers['x-forwarded-host']) || req.get('host') || 'localhost';
  let proto = first(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  try {
    const cf = JSON.parse(req.headers['cf-visitor'] || '{}');
    if (cf && (cf.scheme === 'https' || cf.scheme === 'http')) proto = cf.scheme;
  } catch { /* not behind Cloudflare */ }
  if (proto !== 'https' && !LOCAL_HOST.test(host)) proto = 'https';
  return `${proto}://${host}`;
}

module.exports = { publicOrigin };
