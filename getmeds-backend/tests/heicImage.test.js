/**
 * Nov 12, 2026: HEIC / HEIF attachments are served as JPEG so they show on every device.
 * Checked against real iPhone/Samsung HEIC files from live (GM-20261112-0064) before this
 * was pushed; no HEIC fixture is kept in the repo (they are patient documents).
 */
const { isHeic, jpegName } = require('../src/services/heicImage');

test('recognises HEIC / HEIF by type or by file name', () => {
  expect(isHeic('image/heic', 'a.heic')).toBe(true);
  expect(isHeic('image/heif', 'x')).toBe(true);
  expect(isHeic('', '20261112_143858.HEIC')).toBe(true);
  expect(isHeic('application/octet-stream', 'photo.heif')).toBe(true);
  expect(isHeic('image/jpeg', 'a.jpg')).toBe(false);
  expect(isHeic('application/pdf', 'heic-report.pdf')).toBe(false);
});

test('the JPEG copy keeps the name with a .jpg ending', () => {
  expect(jpegName('20261112_143858.heic')).toBe('20261112_143858.jpg');
  expect(jpegName('IMG_1.HEIF')).toBe('IMG_1.jpg');
});
