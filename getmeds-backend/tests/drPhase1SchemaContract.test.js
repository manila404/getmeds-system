'use strict';

const fs = require('fs');
const path = require('path');
const { isDrWorkflowEnabled } = require('../src/services/workflowFlags');

const BACKEND_ROOT = path.resolve(__dirname, '..');

describe('Phase 1 DR schema, migration & controller contracts', () => {
  it('defines DR sequence, delivery receipt, partial unique index, and batch tables in schema.pg.sql', () => {
    const schema = fs.readFileSync(path.join(BACKEND_ROOT, 'src/db/schema.pg.sql'), 'utf8');
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS dr_sequences/);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS delivery_receipts/);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS delivery_receipt_items/);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS order_item_batches/);
    expect(schema).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_active_dr_per_order_entity/);
    expect(schema).toMatch(/is_csp INTEGER NOT NULL DEFAULT 0/);
    expect(schema).toMatch(/oojeema_si_number TEXT/);
  });

  it('includes idempotent reconcileDeliveryReceiptSchema in migrate.pg.js', () => {
    const migrateSrc = fs.readFileSync(path.join(BACKEND_ROOT, 'src/db/migrate.pg.js'), 'utf8');
    expect(migrateSrc).toMatch(/async function reconcileDeliveryReceiptSchema\(client\)/);
    expect(migrateSrc).toMatch(/await reconcileDeliveryReceiptSchema\(client\)/);
    expect(migrateSrc).toMatch(/INSERT INTO dr_sequences/);
    expect(migrateSrc).toMatch(/ON CONFLICT \(entity_key\) DO NOTHING/);
  });

  it('toggles isDrWorkflowEnabled strictly on GETMEDS_DR_WORKFLOW=true', () => {
    const prev = process.env.GETMEDS_DR_WORKFLOW;
    try {
      delete process.env.GETMEDS_DR_WORKFLOW;
      expect(isDrWorkflowEnabled()).toBe(false);
      process.env.GETMEDS_DR_WORKFLOW = 'yes';
      expect(isDrWorkflowEnabled()).toBe(false);
      process.env.GETMEDS_DR_WORKFLOW = 'true';
      expect(isDrWorkflowEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GETMEDS_DR_WORKFLOW;
      else process.env.GETMEDS_DR_WORKFLOW = prev;
    }
  });

  it('loads dispatch & inventory controllers cleanly without syntax or circular dependency errors', () => {
    const dispatchCtrl = require('../src/controllers/dispatch.controller');
    const inventoryCtrl = require('../src/controllers/inventory.controller');
    expect(typeof dispatchCtrl.getQueue).toBe('function');
    expect(typeof dispatchCtrl.getRecent).toBe('function');
    expect(typeof dispatchCtrl.getSlip).toBe('function');
    expect(typeof inventoryCtrl.syncPullStock).toBe('function');
    expect(typeof inventoryCtrl.__test__.reconcileItems).toBe('function');
  });
});
