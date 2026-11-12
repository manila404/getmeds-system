'use strict';

/**
 * HEIC / HEIF photos as JPEG. Nov 12, 2026 (Aaron).
 *
 * iPhones save photos as HEIC, and MedReps upload them as they are. Only Apple devices
 * can show HEIC: Chrome, Edge and Android show a broken image, and a downloaded .heic
 * does not open on Windows. So the attachment viewer converts them to JPEG when they are
 * opened (controllers/paymentProof.controller.js viewAttachment). The stored file is
 * never changed.
 *
 * heic-decode is JavaScript + WebAssembly (no native parts), so it runs on Vercel.
 * Decoding a 12 MP iPhone photo takes about a second; the result is cached by the
 * browser for the life of the signed link.
 */

const isHeic = (contentType, fileName) =>
  /^image\/hei[cf]/i.test(String(contentType || '')) || /\.(heic|heif)$/i.test(String(fileName || ''));

/** "IMG_1234.HEIC" -> "IMG_1234.jpg" */
const jpegName = (fileName) => String(fileName || 'photo').replace(/\.(heic|heif)$/i, '') + '.jpg';

/**
 * Decode a HEIC buffer and encode it as JPEG. `maxSide` shrinks it (box average) so the
 * longer side is at most that many pixels; null keeps the full size.
 */
async function heicToJpeg(buffer, { maxSide = null, quality = 82 } = {}) {
  const decode = require('heic-decode');
  const jpeg = require('jpeg-js');
  const { width, height, data } = await decode({ buffer });

  const factor = maxSide ? Math.max(1, Math.ceil(Math.max(width, height) / maxSide)) : 1;
  let out = { width, height, data };
  if (factor > 1) {
    const w = Math.floor(width / factor);
    const h = Math.floor(height / factor);
    const px = Buffer.alloc(w * h * 4);
    const area = factor * factor;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < factor; dy++) {
          let i = ((y * factor + dy) * width + x * factor) * 4;
          for (let dx = 0; dx < factor; dx++, i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
        }
        const o = (y * w + x) * 4;
        px[o] = r / area; px[o + 1] = g / area; px[o + 2] = b / area; px[o + 3] = 255;
      }
    }
    out = { width: w, height: h, data: px };
  }
  return jpeg.encode(out, quality).data;
}

module.exports = { isHeic, jpegName, heicToJpeg };
