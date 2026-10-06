/**
 * Attachments live in Sanity; everything else stays in Supabase. Oct 3, 2026.
 * Reads prefer the Sanity copy and fall back to Supabase; uploads are staged in
 * Supabase and then moved; a failed move leaves the file where it was.
 * Sanity and Supabase are mocked: this is about which one is asked, and when.
 */
const mockRemove = jest.fn().mockResolvedValue({ error: null });
const mockDownload = jest.fn();
const mockSigned = jest.fn().mockResolvedValue({ data: { signedUrl: 'https://supabase.test/signed' }, error: null });
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ storage: { from: () => ({ remove: mockRemove, download: mockDownload, createSignedUrl: mockSigned }) } })
}));

process.env.SUPABASE_URL = 'https://x.supabase.test';
process.env.SUPABASE_SECRET_KEY = 'k';
process.env.SANITY_PROJECT_ID = 'proj';
process.env.SANITY_API_TOKEN = 'tok';
process.env.SANITY_DATASET = 'production';

const db = require('../src/db/database');
const storage = require('../src/services/paymentProofStorage');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const P = (n) => `orders/1/payment_proof/sanity-test-${stamp}-${n}.jpg`;
const paths = [];
let fetchSpy;

const mapping = async (p, isImage, id = `image-${p.slice(-6)}`) => {
  paths.push(p);
  await db.prepare('INSERT INTO attachment_assets (storage_path, sanity_asset_id, sanity_url, is_image) VALUES (?, ?, ?, ?)')
    .run(p, id, `https://cdn.sanity.io/${id}.jpg`, isImage);
};

beforeAll(async () => { await db.init(); });
beforeEach(() => {
  jest.clearAllMocks();
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true, status: 200,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    json: async () => ({ document: { _id: 'image-new', url: 'https://cdn.sanity.io/image-new.jpg' } }),
    text: async () => ''
  });
});
afterEach(() => fetchSpy.mockRestore());
afterAll(async () => { for (const p of paths) await db.prepare('DELETE FROM attachment_assets WHERE storage_path = ?').run(p); });

test('view and download use the Sanity link when the file has been moved', async () => {
  const p = P(1); await mapping(p, true);
  expect(await storage.createViewUrl(p)).toMatch(/cdn\.sanity\.io/);
  expect(await storage.createDownloadUrl(p, 'a b.jpg')).toMatch(/\?dl=a%20b\.jpg$/);
  expect(mockSigned).not.toHaveBeenCalled();
});

test('a file not moved yet still comes from Supabase', async () => {
  expect(await storage.createViewUrl(P(2))).toBe('https://supabase.test/signed');
});

test('thumbnails of a Sanity image are asked for resized; other files are sent whole', async () => {
  const img = P(3), pdf = P(4); await mapping(img, true); await mapping(pdf, false);
  await storage.downloadFile(img, { width: 300, height: 300, quality: 75 });
  expect(fetchSpy.mock.calls[0][0]).toMatch(/\?w=300&h=300&fit=crop&q=75&fm=jpg$/);
  await storage.downloadFile(pdf, { width: 300, height: 300 });
  expect(fetchSpy.mock.calls[1][0]).not.toMatch(/\?/);
});

test('a file with no Sanity copy is sent whole: Supabase is never asked to resize (Oct 6, 2026)', async () => {
  // Supabase bills Image Transformations per distinct original image (100 on Pro).
  mockDownload.mockResolvedValue({ data: { arrayBuffer: async () => new Uint8Array([7, 7]).buffer }, error: null });
  const r = await storage.downloadRendition(P(20), { width: 300, height: 300, quality: 75 });
  expect(r.resized).toBe(false);
  expect([...r.buffer]).toEqual([7, 7]);
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockDownload.mock.calls[0]).toHaveLength(1); // no { transform } option
  expect(fetchSpy).not.toHaveBeenCalled();
  await storage.downloadFile(P(20), { width: 1000 });
  expect(mockDownload.mock.calls[1]).toHaveLength(1);
});

test('the rendition says whether it was resized, so the page gets the right file type', async () => {
  const img = P(21), pdf = P(22); await mapping(img, true); await mapping(pdf, false);
  expect((await storage.downloadRendition(img, { width: 300, height: 300 })).resized).toBe(true);
  expect((await storage.downloadRendition(img)).resized).toBe(false);
  expect((await storage.downloadRendition(pdf, { width: 300 })).resized).toBe(false);
  expect(mockDownload).not.toHaveBeenCalled();
});

test('a staged upload is copied to Sanity, mapped, and then removed from Supabase', async () => {
  const p = P(5); paths.push(p);
  mockDownload.mockResolvedValue({ data: { arrayBuffer: async () => new Uint8Array([9]).buffer }, error: null });
  expect(await storage.moveToSanityQuietly(p, { contentType: 'image/jpeg', fileName: 'proof.jpg' })).toBe(true);
  expect(fetchSpy.mock.calls[0][0]).toMatch(/assets\/images\/production/);
  const row = await db.prepare('SELECT is_image, sanity_asset_id FROM attachment_assets WHERE storage_path = ?').get(p);
  expect(row.is_image).toBe(true);
  expect(row.sanity_asset_id).toBe('image-new');
  expect(mockRemove).toHaveBeenCalledWith([p]);
});

test('a PDF goes in as a plain file asset', async () => {
  const p = P(6).replace('.jpg', '.pdf'); paths.push(p);
  mockDownload.mockResolvedValue({ data: { arrayBuffer: async () => new Uint8Array([9]).buffer }, error: null });
  await storage.moveToSanityQuietly(p, { contentType: 'application/pdf', fileName: 'rx.pdf' });
  expect(fetchSpy.mock.calls[0][0]).toMatch(/assets\/files\/production/);
});

test('if Sanity fails the file stays in Supabase and nothing throws', async () => {
  const p = P(7); paths.push(p);
  mockDownload.mockResolvedValue({ data: { arrayBuffer: async () => new Uint8Array([9]).buffer }, error: null });
  fetchSpy.mockResolvedValue({ ok: false, status: 502, text: async () => 'bad gateway' });
  expect(await storage.moveToSanityQuietly(p, { contentType: 'image/jpeg' })).toBe(false);
  expect(mockRemove).not.toHaveBeenCalled();
  expect(await db.prepare('SELECT 1 AS x FROM attachment_assets WHERE storage_path = ?').get(p)).toBeFalsy();
});

test('removing a moved file deletes the Sanity asset and its mapping', async () => {
  const p = P(8); await mapping(p, true, 'image-gone');
  await storage.removeQuietly(p);
  const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
  expect(body.mutations[0].delete.id).toBe('image-gone');
  expect(await db.prepare('SELECT 1 AS x FROM attachment_assets WHERE storage_path = ?').get(p)).toBeFalsy();
});
