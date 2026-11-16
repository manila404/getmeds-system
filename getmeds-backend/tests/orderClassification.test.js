'use strict';

const { isKnownCspProductName } = require('../src/constants/cspCatalog');
const {
  normalizeEntityKey,
  formatEntitySiNumber,
  getOrderEntityKeys,
  classifyOrder
} = require('../src/services/orderClassificationService');

describe('CSP product catalog detection', () => {
  it('matches all canonical CSP molecules case-insensitively with dosage/brand text', () => {
    expect(isKnownCspProductName('Adagrasib 200mg Tablet')).toBe(true);
    expect(isKnownCspProductName('Nivolumab (Tishtha) 100mg')).toBe(true);
    expect(isKnownCspProductName('Anti D 300mcg/ml Solution for Injection')).toBe(true);
    expect(isKnownCspProductName('Venetoclax 100 mg Bottle of 60s')).toBe(true);
    expect(isKnownCspProductName('Levosimendan 12.5mg')).toBe(true);
  });

  it('does not false-match non-CSP medicines containing substrings like "Anti Diarrheal"', () => {
    expect(isKnownCspProductName('Anti Diarrheal Capsule 2mg')).toBe(false);
    expect(isKnownCspProductName('Paracetamol 500mg Tablet')).toBe(false);
    expect(isKnownCspProductName('Losartan 50mg Tab')).toBe(false);
  });
});

describe('Entity key & Oojeema SI formatting', () => {
  it('maps legal entity names to strict GPI / 2MG ledger prefixes', () => {
    expect(normalizeEntityKey('2mg Incorporated')).toBe('2MG');
    expect(normalizeEntityKey('Getmeds Philippines Inc.')).toBe('GPI');
    expect(normalizeEntityKey('gpi')).toBe('GPI');
    expect(normalizeEntityKey('')).toBeNull();
  });

  it('formats live Zoho invoice numbers without spaces around hyphen', () => {
    expect(formatEntitySiNumber('2mg Incorporated', 'SI000004987')).toBe('2MG-SI000004987');
    expect(formatEntitySiNumber('Getmeds Philippines Inc.', 'SI000003091')).toBe('GPI-SI000003091');
    expect(formatEntitySiNumber('2MG', '2MG - SI000004987')).toBe('2MG-SI000004987');
    expect(() => formatEntitySiNumber('2MG', '')).toThrow(/cannot be empty/i);
  });

  it('collects distinct entity keys for split orders', () => {
    expect(
      getOrderEntityKeys({
        order: { invoicing_from: 'Getmeds Philippines Inc.' },
        items: [{ invoicing_from: '2mg Incorporated' }],
        splits: [{ invoicing_from: '2mg Incorporated' }]
      })
    ).toEqual(['GPI', '2MG']);
  });
});

describe('Order SI / DR / CSP classification rules', () => {
  it('does not require SI or DR for doctors', () => {
    const res = classifyOrder({
      order: { division: 'MD Telesales', intake_source: 'Doctor order', invoicing_from: '2mg Incorporated' },
      customer: { category: 'doctor' },
      items: [{ id: 1, product_id: 10, product_name: 'Atorvastatin 20mg Tab' }]
    });
    expect(res).toMatchObject({
      transaction_kind: 'doctor',
      requires_si: false,
      requires_dr: false,
      is_csp: false,
      skip_so_print: false,
      primary_entity: '2MG'
    });
  });

  it('treats "Patient order referred by doctor" as standard patient (not doctor)', () => {
    const res = classifyOrder({
      order: { division: 'RX', intake_source: 'Patient order referred by doctor', invoicing_from: 'Getmeds Philippines Inc.' },
      customer: { category: 'patient' },
      items: [{ id: 1, product_id: 11, product_name: 'Losartan 50mg Tab' }]
    });
    expect(res.transaction_kind).toBe('patient');
    expect(res.requires_si).toBe(false);
    expect(res.requires_dr).toBe(false);
  });

  it('requires SI and DR for PCSO / GL / Office of the President assisted patients', () => {
    for (const order of [
      { intake_source: 'PCSO' },
      { intake_source: 'Office of the President' },
      { intake_source: 'B2C Order', intake_gl_number: 'GL-2026-0091' },
      { division: 'PAP', intake_source: 'DSWD' }
    ]) {
      const res = classifyOrder({ order, customer: { category: 'patient' }, items: [] });
      expect(res.transaction_kind).toBe('pap_gl');
      expect(res.requires_si).toBe(true);
      expect(res.requires_dr).toBe(true);
    }

    const withGlProof = classifyOrder({
      order: { intake_source: 'B2C Order' },
      customer: { category: 'patient' },
      paymentProofs: [{ file_type: 'gl' }]
    });
    expect(withGlProof.transaction_kind).toBe('pap_gl');
    expect(withGlProof.requires_si).toBe(true);
  });

  it('requires SI and DR for B2B, distributors, bidding, and hospitals', () => {
    expect(classifyOrder({ order: { division: 'B2B' }, customer: { category: 'distributor' } })).toMatchObject({
      transaction_kind: 'b2b',
      requires_si: true,
      requires_dr: true
    });
    expect(classifyOrder({ order: { division: 'BID', intake_source: 'Bidding Order' }, customer: {} })).toMatchObject({
      transaction_kind: 'b2b',
      requires_si: true,
      requires_dr: true
    });
    expect(classifyOrder({ order: { intake_source: 'Hospital PO' }, customer: { category: 'hospital' } })).toMatchObject({
      transaction_kind: 'hospital',
      requires_si: true,
      requires_dr: true
    });
  });

  it('flags CSP orders to skip SO printing regardless of customer SI rule', () => {
    const res = classifyOrder({
      order: { intake_source: 'Hospital PO', invoicing_from: 'Getmeds Philippines Inc.' },
      customer: { category: 'hospital' },
      items: [
        { id: 101, product_id: 50, product_name: 'Adagrasib 200mg Tablet', is_csp: 1 },
        { id: 102, product_id: 50, product_name: 'Adagrasib 200mg Tablet', is_csp: 0 }
      ]
    });
    expect(res.is_csp).toBe(true);
    expect(res.skip_so_print).toBe(true);
    expect(res.requires_si).toBe(true);
    expect(res.csp_items).toHaveLength(2);
  });

  it('respects manual requires_si overrides (both enabling for Patient and disabling)', () => {
    const patientWithSi = classifyOrder({
      order: { intake_source: 'B2C Order', requires_si: 1, si_override_reason: 'Patient requested official SI' },
      customer: { category: 'patient' }
    });
    expect(patientWithSi.requires_si).toBe(true);
    expect(patientWithSi.requires_dr).toBe(true);
    expect(patientWithSi.has_override).toBe(true);
    expect(patientWithSi.classification_reason).toBe('Patient requested official SI');

    const disabledSi = classifyOrder({
      order: { division: 'B2B', requires_si: 0, si_override_reason: 'Switched to No-SI' },
      customer: { category: 'distributor' }
    });
    expect(disabledSi.requires_si).toBe(false);
    expect(disabledSi.requires_dr).toBe(false);
  });
});
