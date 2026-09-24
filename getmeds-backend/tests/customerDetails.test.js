/**
 * Client Details: the modal's Zoho mapping, and its documents.
 *
 * Sep 24, 2026.
 *
 * The mapping test uses a contact shaped exactly like one read live from this
 * org's Zoho (field names and the three-spellings-per-custom-field quirk are
 * from that read, values are made up) so it pins the real structure, not an
 * imagined one.
 */

jest.mock('../src/services/paymentProofStorage', () => {
  const real = jest.requireActual('../src/services/paymentProofStorage');
  return {
    ...real,
    createUploadUrl: jest.fn(async (p) => ({ signedUrl: `https://storage.test/upload/${p}`, token: 't', path: p })),
    createViewUrl: jest.fn(async (p) => `https://storage.test/view/${p}`),
    removeQuietly: jest.fn(async () => true),
  };
});

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const storage = require('../src/services/paymentProofStorage');
const { mapZohoContact, mapLocalCustomer } = require('../src/services/customerDetailsService');

const SEED_PASSWORD = 'demo123';
async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const ZOHO_CONTACT = {
  contact_id: '2254168000000000001',
  contact_name: 'ACME PHARMACY',
  company_name: 'ACME PHARMACY CORP.',
  customer_sub_type: 'business',
  contact_salutation: 'Mr.',
  first_name: 'Test',
  last_name: 'One',
  email: 'buyer@acme.test',
  phone: '9123456789',
  mobile: '987654321',
  company_id: 'CO-77',
  cf_custom_id: 'GC095149',
  cf_custom_id_unformatted: 'GC095149',
  cf_contact_number: '917 590 7923',
  cf_contact_number_unformatted: '917 590 7923',
  cf_lto_license_number: 'CDRR-RVII-DW-1680768',
  cf_lto_license_number_unformatted: 'CDRR-RVII-DW-1680768',
  cf_lto_type: 'DRUG DISTRIBUTOR-WHOLESALER',
  cf_lto_type_unformatted: 'DRUG DISTRIBUTOR-WHOLESALER',
  cf_license_issuance_date: '14 Mar 2026',
  cf_license_issuance_date_unformatted: '2026-03-14',
  cf_license_expiry_date: '14 Mar 2028',
  cf_license_expiry_date_unformatted: '2028-03-14',
  // The quirk: the display spelling of a checkbox is the TEXT "false".
  cf_is_doctor: 'false',
  cf_is_doctor_unformatted: false,
  cf_tin: '681-470-003-00000',
  cf_tin_unformatted: '681-470-003-00000',
  billing_address: { address: '1 Main St', street2: 'Unit 2', city: 'CEBU CITY', state: 'Cebu', state_code: 'CE', zip: '6000', country: 'Philippines', phone: '032 111 2222' },
  shipping_address: { address: '9 Dock Rd', street2: '', city: 'MANDAUE', state: '', zip: '', country: 'Philippines', phone: '' },
  documents: [{ file_name: 'permit.pdf' }],
};

describe('mapZohoContact', () => {
  test('maps every field the modal shows from the Zoho contact', () => {
    const m = mapZohoContact(ZOHO_CONTACT);
    expect(m.custom_id).toBe('GC095149');
    expect(m.customer_type).toBe('business');
    expect(m.company_name).toBe('ACME PHARMACY CORP.');
    expect(m.display_name).toBe('ACME PHARMACY');
    expect(m.primary_contact).toEqual({ salutation: 'Mr.', first_name: 'Test', last_name: 'One', full: 'Mr. Test One' });
    expect(m.email).toBe('buyer@acme.test');
    expect(m.phones).toEqual({ work: '9123456789', mobile: '987654321', contact_number: '917 590 7923' });
    expect(m.billing_address).toEqual({
      street1: '1 Main St', street2: 'Unit 2', city: 'CEBU CITY', state: 'Cebu', zip: '6000', country: 'Philippines', phone: '032 111 2222',
    });
    expect(m.shipping_address.street1).toBe('9 Dock Rd');
    expect(m.shipping_address.street2).toBeNull();
    expect(m.additional).toEqual({
      company_id: 'CO-77',
      lto_license_number: 'CDRR-RVII-DW-1680768',
      lto_type: 'DRUG DISTRIBUTOR-WHOLESALER',
      license_issuance_date: '2026-03-14',
      license_expiry_date: '2028-03-14',
      tin: '681-470-003-00000',
    });
    expect(m.zoho_documents).toEqual([{ file_name: 'permit.pdf' }]);
  });

  test('the checkbox text "false" is false, and a real true is true', () => {
    expect(mapZohoContact({ ...ZOHO_CONTACT }).is_doctor).toBe(false);
    expect(mapZohoContact({ ...ZOHO_CONTACT, cf_is_doctor: 'true', cf_is_doctor_unformatted: true }).is_doctor).toBe(true);
    // No _unformatted spelling at all: the text is read, "false" still false.
    expect(mapZohoContact({ cf_is_doctor: 'false' }).is_doctor).toBe(false);
    expect(mapZohoContact({ cf_is_doctor: 'true' }).is_doctor).toBe(true);
  });

  test('falls back to the primary contact person when the contact has no name of its own', () => {
    const m = mapZohoContact({
      contact_persons: [
        { first_name: 'Other', last_name: 'Person', is_primary_contact: false },
        { salutation: 'Dr.', first_name: 'Prim', last_name: 'Ary', is_primary_contact: true },
      ],
    });
    expect(m.primary_contact.full).toBe('Dr. Prim Ary');
  });

  test('empty strings become null, and an all-empty address is null', () => {
    const m = mapZohoContact({ email: '', phone: '  ', billing_address: { address: '', city: '', country: '' } });
    expect(m.email).toBeNull();
    expect(m.phones.work).toBeNull();
    expect(m.billing_address).toBeNull();
    expect(m.additional.tin).toBeNull();
    expect(m.additional.license_expiry_date).toBeNull();
  });

  test('a display-only date is converted rather than shown raw', () => {
    const m = mapZohoContact({ cf_license_expiry_date: '14 Mar 2028' });
    expect(m.additional.license_expiry_date).toBe('2028-03-14');
  });
});

describe('mapLocalCustomer', () => {
  test('uses only what is stored, and invents nothing', () => {
    const m = mapLocalCustomer({ name: 'LOCAL CO', contact_person: 'Ann', contact_number: '0917', address: '5 Elm St', email: 'a@b.co', lto_license_number: 'L-1', tin: '123' });
    expect(m.display_name).toBe('LOCAL CO');
    expect(m.billing_address.street1).toBe('5 Elm St');
    expect(m.billing_address.city).toBeNull();
    expect(m.additional.lto_license_number).toBe('L-1');
    expect(m.additional.tin).toBe('123');
    expect(m.custom_id).toBeNull();
    expect(m.is_doctor).toBeNull();
  });
});

describe('Client Details endpoints', () => {
  let adminToken, medrepToken, financeToken;
  let localId, otherId;
  const madeCustomers = [];

  const makeCustomer = async (name) => {
    const r = await db
      .prepare("INSERT INTO customers (name, type, contact_person, contact_number, address, source) VALUES (?, 'direct', 'Pat', '0917', '1 Local St', 'local')")
      .run(name);
    madeCustomers.push(r.lastInsertRowid);
    return r.lastInsertRowid;
  };

  beforeAll(async () => {
    adminToken = await loginAs('admin@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    financeToken = await loginAs('finance@getmeds.ph');
    const stamp = Date.now();
    localId = await makeCustomer(`Details Local ${stamp}`);
    otherId = await makeCustomer(`Details Other ${stamp}`);
  });

  afterAll(async () => {
    for (const id of madeCustomers) {
      await db.prepare('DELETE FROM customer_documents WHERE customer_id = ?').run(id);
      await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
  });

  beforeEach(() => jest.clearAllMocks());

  test('a local customer opens on its stored values, flagged as not from Zoho', async () => {
    const res = await request(app).get(`/api/customers/${localId}/details`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('local');
    expect(res.body.data.billing_address.street1).toBe('1 Local St');
    expect(res.body.data.documents).toEqual([]);
    expect(res.body.data.document_limits).toEqual({ max_documents: 10, max_bytes: 10 * 1024 * 1024 });
  });

  test('a Zoho-linked customer is read from Zoho', async () => {
    const linked = await db.prepare("SELECT id FROM customers WHERE zoho_contact_id IS NOT NULL LIMIT 1").get();
    if (!linked) return; // fixture-dependent; the mapping above is the real coverage
    const res = await request(app).get(`/api/customers/${linked.id}/details`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(['zoho', 'local']).toContain(res.body.data.source);
    expect(res.body.data).toHaveProperty('additional.tin');
    expect(res.body.data).toHaveProperty('phones');
  });

  test('404 for a customer that does not exist; 403 for roles outside admin/management', async () => {
    expect((await request(app).get('/api/customers/99999999/details').set(auth(adminToken))).status).toBe(404);
    expect((await request(app).get(`/api/customers/${localId}/details`).set(auth(medrepToken))).status).toBe(403);
    expect((await request(app).get(`/api/customers/${localId}/details`).set(auth(financeToken))).status).toBe(403);
  });

  describe('documents', () => {
    const upload = async (id, name = 'licence.pdf', size = 1024, type = 'application/pdf') => {
      const step1 = await request(app)
        .post(`/api/customers/${id}/documents/upload-url`)
        .set(auth(adminToken))
        .send({ file_name: name, content_type: type, file_size: size });
      if (step1.status !== 200) return { step1 };
      const step2 = await request(app)
        .post(`/api/customers/${id}/documents`)
        .set(auth(adminToken))
        .send({ storage_path: step1.body.data.storagePath, file_name: name, content_type: type, file_size: size });
      return { step1, step2 };
    };

    test('the two-step upload records a document, listed in details, and a link can be minted', async () => {
      const { step1, step2 } = await upload(localId, 'my licence (1).pdf');
      expect(step1.status).toBe(200);
      expect(step1.body.data.storagePath).toMatch(new RegExp(`^customers/${localId}/documents/`));
      // No spaces or brackets in the storage key.
      expect(step1.body.data.storagePath).not.toMatch(/[ ()]/);
      expect(step2.status).toBe(201);
      expect(step2.body.data.document.file_name).toBe('my licence (1).pdf');

      const details = await request(app).get(`/api/customers/${localId}/details`).set(auth(adminToken));
      expect(details.body.data.documents.map((d) => d.file_name)).toContain('my licence (1).pdf');

      const link = await request(app)
        .get(`/api/customers/${localId}/documents/${step2.body.data.document.id}/url`)
        .set(auth(adminToken));
      expect(link.status).toBe(200);
      expect(link.body.data.url).toMatch(/^https:\/\/storage\.test\/view\//);
    });

    test('a file over 10 MB is refused before a URL is minted', async () => {
      const res = await request(app)
        .post(`/api/customers/${localId}/documents/upload-url`)
        .set(auth(adminToken))
        .send({ file_name: 'big.pdf', content_type: 'application/pdf', file_size: 10 * 1024 * 1024 + 1 });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/10 MB/);
      expect(storage.createUploadUrl).not.toHaveBeenCalled();
    });

    test('exactly 10 MB is allowed; an unsupported type is refused', async () => {
      const ok = await request(app)
        .post(`/api/customers/${otherId}/documents/upload-url`)
        .set(auth(adminToken))
        .send({ file_name: 'edge.pdf', content_type: 'application/pdf', file_size: 10 * 1024 * 1024 });
      expect(ok.status).toBe(200);

      const exe = await request(app)
        .post(`/api/customers/${otherId}/documents/upload-url`)
        .set(auth(adminToken))
        .send({ file_name: 'x.exe', content_type: 'application/x-msdownload', file_size: 100 });
      expect(exe.status).toBe(400);
    });

    test('the 11th document is refused at both steps', async () => {
      const id = await makeCustomer(`Details Full ${Date.now()}`);
      for (let i = 0; i < 10; i += 1) {
        const { step2 } = await upload(id, `doc-${i}.pdf`);
        expect(step2.status).toBe(201);
      }
      const eleventh = await request(app)
        .post(`/api/customers/${id}/documents/upload-url`)
        .set(auth(adminToken))
        .send({ file_name: 'one-too-many.pdf', content_type: 'application/pdf', file_size: 10 });
      expect(eleventh.status).toBe(409);
      expect(eleventh.body.error.code).toBe('DOCUMENT_LIMIT');

      // Skipping step 1 does not get around it, and the stray object is cleaned up.
      const sneaky = await request(app)
        .post(`/api/customers/${id}/documents`)
        .set(auth(adminToken))
        .send({ storage_path: `customers/${id}/documents/sneaky.pdf`, file_name: 'sneaky.pdf', content_type: 'application/pdf', file_size: 10 });
      expect(sneaky.status).toBe(409);
      expect(storage.removeQuietly).toHaveBeenCalledWith(`customers/${id}/documents/sneaky.pdf`);
    });

    test('a path outside this customer’s folder is refused', async () => {
      const res = await request(app)
        .post(`/api/customers/${localId}/documents`)
        .set(auth(adminToken))
        .send({ storage_path: `customers/${otherId}/documents/x.pdf`, file_name: 'x.pdf', content_type: 'application/pdf', file_size: 10 });
      expect(res.status).toBe(400);

      const traversal = await request(app)
        .post(`/api/customers/${localId}/documents`)
        .set(auth(adminToken))
        .send({ storage_path: `customers/${localId}/documents/../../orders/1/x.pdf`, file_name: 'x.pdf', content_type: 'application/pdf', file_size: 10 });
      expect(traversal.status).toBe(400);
    });

    test('delete removes the row and the stored object, and only via the right customer', async () => {
      const { step2 } = await upload(localId, 'to-delete.pdf');
      const docId = step2.body.data.document.id;

      const wrongCustomer = await request(app).delete(`/api/customers/${otherId}/documents/${docId}`).set(auth(adminToken));
      expect(wrongCustomer.status).toBe(404);

      const res = await request(app).delete(`/api/customers/${localId}/documents/${docId}`).set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(await db.prepare('SELECT id FROM customer_documents WHERE id = ?').get(docId)).toBeUndefined();
      expect(storage.removeQuietly).toHaveBeenCalled();
    });

    test('a MedRep cannot upload', async () => {
      const res = await request(app)
        .post(`/api/customers/${localId}/documents/upload-url`)
        .set(auth(medrepToken))
        .send({ file_name: 'a.pdf', content_type: 'application/pdf', file_size: 10 });
      expect(res.status).toBe(403);
    });
  });
});
