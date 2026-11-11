/**
 * Nov 11, 2026: BIR 2303, LTO PERMIT, BUS. PERMIT upon creation of new Hospital.
 * Mandatory, restricted if no docs or details provided.
 */

jest.mock('../src/services/paymentProofStorage', () => {
  const real = jest.requireActual('../src/services/paymentProofStorage');
  return {
    ...real,
    createUploadUrl: jest.fn(async (p) => ({ signedUrl: `https://storage.test/upload/${p}`, token: 't', path: p })),
    createViewUrl: jest.fn(async (p) => `https://storage.test/view/${p}`),
    removeQuietly: jest.fn(async () => true),
    moveToSanityQuietly: jest.fn(async () => true)
  };
});

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const createdIds = [];
let medrepToken;
let managerToken;

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const validHospital = (overrides = {}) => {
  const phone = `+63917${String(uniq()).slice(-7)}`;
  return {
    category: 'hospital',
    display_name: `Test Hospital ${uniq()}`,
    phone,
    contact_number: phone,
    tin: '000-111-222-000',
    license_owner: 'Hospital Owner MD',
    lto_license_number: `LTO-HOSP-${uniq()}`,
    lto_type: 'Hospital',
    license_issuance_date: '2026-01-01',
    license_expiry_date: '2027-12-31',
    billing_address: { address: '100 Medical Center Blvd', city: 'Quezon City', phone },
    shipping_same_as_billing: true,
    ...overrides
  };
};

beforeAll(async () => {
  medrepToken = (await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' })).body.data.token;
  managerToken = (await request(app).post('/api/auth/login').send({ email: 'manager@getmeds.ph', password: 'demo123' })).body.data.token;
});

afterAll(async () => {
  for (const id of createdIds) {
    await db.prepare('DELETE FROM customer_documents WHERE customer_id = ?').run(id);
    await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  }
});

describe('Hospital creation mandatory details & document restrictions', () => {
  describe('Mandatory details restrictions', () => {
    test('restricted if TIN is missing', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(medrepToken))
        .send(validHospital({ tin: '' }));
      expect(res.status).toBe(400);
      expect(res.body.error.problems).toContain('TIN is mandatory for hospitals.');
    });

    test('restricted if License Owner is missing', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(medrepToken))
        .send(validHospital({ license_owner: '' }));
      expect(res.status).toBe(400);
      expect(res.body.error.problems).toContain('License Owner is mandatory for hospitals.');
    });

    test('restricted if LTO Number is missing', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(medrepToken))
        .send(validHospital({ lto_license_number: '' }));
      expect(res.status).toBe(400);
      expect(res.body.error.problems).toContain('LTO Number is mandatory for hospitals.');
    });

    test('restricted if LTO Type is missing', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(medrepToken))
        .send(validHospital({ lto_type: '' }));
      expect(res.status).toBe(400);
      expect(res.body.error.problems).toContain('LTO Type is mandatory for hospitals.');
    });

    test('restricted if License Issuance Date is missing', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(medrepToken))
        .send(validHospital({ license_issuance_date: '' }));
      expect(res.status).toBe(400);
      expect(res.body.error.problems).toContain('License Issuance Date is mandatory for hospitals.');
    });

    test('restricted if License Expiry Date is missing', async () => {
      const res = await request(app)
        .post('/api/customers')
        .set(auth(medrepToken))
        .send(validHospital({ license_expiry_date: '' }));
      expect(res.status).toBe(400);
      expect(res.body.error.problems).toContain('License Expiry Date is mandatory for hospitals.');
    });

    test('hospital creation succeeds when all mandatory details are provided', async () => {
      const body = validHospital();
      const res = await request(app)
        .post('/api/customers')
        .set(auth(medrepToken))
        .send(body);
      expect(res.status).toBe(201);
      expect(res.body.data.customer.id).toBeTruthy();
      createdIds.push(res.body.data.customer.id);
    });
  });

  describe('Document upload upon customer creation', () => {
    test('MedRep can upload BIR 2303, LTO PERMIT, and BUS. PERMIT documents to newly created hospital', async () => {
      const body = validHospital();
      const createRes = await request(app)
        .post('/api/customers')
        .set(auth(medrepToken))
        .send(body);
      expect(createRes.status).toBe(201);
      const customerId = createRes.body.data.customer.id;
      createdIds.push(customerId);

      const docs = [
        { name: '[BIR 2303] bir2303.pdf', type: 'application/pdf', size: 1024 },
        { name: '[LTO PERMIT] lto_permit.pdf', type: 'application/pdf', size: 2048 },
        { name: '[BUS. PERMIT] bus_permit.pdf', type: 'application/pdf', size: 3072 },
      ];

      for (const d of docs) {
        // Step 1: get upload url
        const urlRes = await request(app)
          .post(`/api/customers/${customerId}/documents/upload-url`)
          .set(auth(medrepToken))
          .send({ file_name: d.name, content_type: d.type, file_size: d.size });
        expect(urlRes.status).toBe(200);
        const { storagePath } = urlRes.body.data;

        // Step 2: attach document
        const attachRes = await request(app)
          .post(`/api/customers/${customerId}/documents`)
          .set(auth(medrepToken))
          .send({
            file_name: d.name,
            content_type: d.type,
            file_size: d.size,
            storage_path: storagePath
          });
        expect(attachRes.status).toBe(201);
        expect(attachRes.body.data.document.file_name).toBe(d.name);
      }

      // Verify that pending customer endpoint returns the 3 attached documents
      const pendingRes = await request(app)
        .get(`/api/customers/${customerId}/pending`)
        .set(auth(managerToken));
      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body.data.documents.length).toBe(3);
      const names = pendingRes.body.data.documents.map((x) => x.file_name);
      expect(names).toContain('[BIR 2303] bir2303.pdf');
      expect(names).toContain('[LTO PERMIT] lto_permit.pdf');
      expect(names).toContain('[BUS. PERMIT] bus_permit.pdf');
    });
  });
});
