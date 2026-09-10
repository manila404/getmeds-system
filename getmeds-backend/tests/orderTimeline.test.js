/**
 * Sep 10, 2026 (2c) — the ten-stage pipeline.
 *
 * ZOHO-SO-67262 had 20 trail rows for an order that did six things. 2b removed
 * the noise; this turns what is left into a pipeline that reads at a glance,
 * with everything that is not a stage collapsed under the stage it follows.
 *
 * The two flows must read the same way:
 *   OLD (ZOHO-)  raised and fulfilled in Zoho, imported here
 *   NEW (GM-)    raised, approved and verified here, fulfilled in Zoho
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { buildTimeline, tierOf, sourceOf, SPINE } = require('../src/services/orderTimelineService');

const ev = (over) => ({
  id: 1,
  event_type: 'ZOHO_SO_CREATED',
  actor_name: 'Aman Bishnoi',
  notes: 'x',
  metadata: null,
  created_at: '2026-09-09T07:14:00.000Z',
  ...over
});

const stage = (t, key) => t.stages.find((s) => s.key === key);

describe('The order pipeline', () => {
  describe('tiering', () => {
    test.each([
      ['ZOHO_SO_CREATED', 'milestone'],
      ['ZOHO_SO_CONFIRMED', 'milestone'],
      ['ZOHO_PAYMENT_VERIFIED', 'milestone'],
      ['ORDER_COMPLETED', 'milestone'],
      ['ZOHO_SO_EDITED', 'update'],
      ['ZOHO_SALES_RETURN', 'update'],
      ['ZOHO_PACKAGE_UNSHIPPED', 'update'],
      ['ORDER_REASSIGNED', 'update']
    ])('%s is a %s', (type, tier) => {
      expect(tierOf(type)).toBe(tier);
    });

    test('an event type nobody has classified is an update, never dropped', () => {
      // The same reasoning as the history classifier's `unknown` bucket:
      // hiding what we do not recognise is how Sales Returns went unnoticed.
      expect(tierOf('SOMETHING_INVENTED_NEXT_YEAR')).toBe('update');
    });
  });

  describe('an imported Zoho order', () => {
    const order = { getmeds_order_id: 'ZOHO-SO-67262' };
    const events = [
      ev({ id: 1, event_type: 'ORDER_IMPORTED_FROM_ZOHO', actor_name: 'Aaron Manila (Zoho import)', created_at: '2026-09-09T07:14:00.000Z' }),
      ev({ id: 2, event_type: 'ZOHO_SO_CREATED', actor_name: 'Aman Bishnoi', created_at: '2026-09-09T07:14:00.000Z' }),
      ev({ id: 3, event_type: 'ZOHO_SO_CONFIRMED', actor_name: 'Aman Bishnoi', created_at: '2026-09-09T07:36:00.000Z' }),
      ev({ id: 4, event_type: 'ZOHO_INVOICE_SENT', actor_name: 'Aman Bishnoi', created_at: '2026-09-09T07:38:00.000Z' }),
      ev({ id: 5, event_type: 'ZOHO_SO_EDITED', actor_name: 'Aaron Manila', created_at: '2026-09-10T00:06:00.000Z' })
    ];
    const t = buildTimeline(order, events);

    test('shows all ten stages, reached or not', () => {
      expect(t.stages).toHaveLength(SPINE.length);
      expect(t.counts.of).toBe(10);
    });

    test('the REAL person owns Created, not the import bookkeeping', () => {
      // ORDER_IMPORTED_FROM_ZOHO and ZOHO_SO_CREATED share a timestamp.
      // Choosing the earliest put "Aaron Manila (Zoho import)" on the stage
      // and demoted the person who actually raised the order to a collapsed
      // update — precisely backwards, which is why stages pick by type
      // preference rather than by time.
      expect(stage(t, 'created').by).toBe('Aman Bishnoi');
      expect(stage(t, 'created').event_type).toBe('ZOHO_SO_CREATED');
    });

    test('the import marker survives as an update under Created', () => {
      // Demoted, not deleted — it still answers "why is this order here".
      const u = stage(t, 'created').updates;
      expect(u.map((x) => x.event_type)).toContain('ORDER_IMPORTED_FROM_ZOHO');
    });

    test('the app-only stages say why they do not apply', () => {
      const approved = stage(t, 'approved');
      const verified = stage(t, 'verified');

      expect(approved.state).toBe('not_applicable');
      expect(verified.state).toBe('not_applicable');
      // A stage that silently vanished would be indistinguishable from a
      // control somebody skipped.
      expect(verified.note).toMatch(/google/i);
      expect(verified.note).toMatch(/thread/i);
    });

    test('stages not yet reached are pending, not hidden', () => {
      expect(stage(t, 'delivered').state).toBe('pending');
      expect(stage(t, 'completed').state).toBe('pending');
      expect(stage(t, 'completed').at).toBeNull();
    });

    test('an update attaches to the stage it followed', () => {
      // The edit happened after Invoiced, so it belongs there — that is what
      // makes "1 update" between two stages mean anything.
      expect(stage(t, 'invoiced').updates.map((u) => u.event_type)).toContain('ZOHO_SO_EDITED');
    });

    test('reports how far along the order is', () => {
      expect(t.counts.reached).toBe(3); // created, confirmed, invoiced
      expect(t.counts.updates).toBe(2);
    });
  });

  describe('an order raised in this app', () => {
    const order = { getmeds_order_id: 'GM-20260910-0001' };
    const t = buildTimeline(order, [
      ev({ id: 1, event_type: 'ORDER_CREATED', actor_name: 'Ana Mae Otucan', created_at: '2026-09-10T01:00:00.000Z' }),
      ev({ id: 2, event_type: 'MANAGEMENT_APPROVED', actor_name: 'Fhaye', created_at: '2026-09-10T02:00:00.000Z' }),
      ev({ id: 3, event_type: 'ZOHO_SO_CONFIRMED', actor_name: 'Aman Bishnoi', created_at: '2026-09-10T03:00:00.000Z' })
    ]);

    test('the app-only stages are real stages here, not "not applicable"', () => {
      // Same spine, different meaning — this is what reconciles the two flows.
      expect(stage(t, 'approved').state).toBe('done');
      expect(stage(t, 'approved').by).toBe('Fhaye');
      expect(stage(t, 'verified').state).toBe('pending');
    });

    test('the Zoho stages work identically for both flows', () => {
      expect(stage(t, 'confirmed').state).toBe('done');
      expect(stage(t, 'confirmed').source).toBe('zoho');
    });

    test('Created is attributed to the rep, not to Zoho', () => {
      expect(stage(t, 'created').by).toBe('Ana Mae Otucan');
      expect(stage(t, 'created').source).toBe('app');
    });
  });

  describe('reaching a stage twice', () => {
    test('keeps the first time and shows the repeat as an update', () => {
      // A package can be un-shipped and re-shipped. "When was this first
      // packed" should not silently become "when was it last packed".
      const t = buildTimeline({ getmeds_order_id: 'ZOHO-X' }, [
        ev({ id: 1, event_type: 'ZOHO_PACKAGE_CREATED', created_at: '2026-09-01T00:00:00.000Z' }),
        ev({ id: 2, event_type: 'ZOHO_PACKAGE_CREATED', created_at: '2026-09-05T00:00:00.000Z' })
      ]);

      expect(stage(t, 'packed').at).toBe('2026-09-01T00:00:00.000Z');
      expect(stage(t, 'packed').updates).toHaveLength(1);
      expect(stage(t, 'packed').updates[0].at).toBe('2026-09-05T00:00:00.000Z');
    });
  });

  describe('an order that ended badly', () => {
    test('cancellation gets its own row rather than being buried', () => {
      const t = buildTimeline({ getmeds_order_id: 'ZOHO-Y' }, [
        ev({ id: 1, event_type: 'ZOHO_SO_CREATED', created_at: '2026-09-01T00:00:00.000Z' }),
        ev({ id: 2, event_type: 'ZOHO_SO_CANCELLED', actor_name: 'Zoho', created_at: '2026-09-02T00:00:00.000Z' })
      ]);

      const terminal = t.stages.find((s) => s.state === 'terminal');
      expect(terminal).toBeTruthy();
      expect(terminal.label).toBe('Cancelled in Zoho');
      // And it is last, where the eye lands.
      expect(t.stages[t.stages.length - 1]).toBe(terminal);
    });
  });

  describe('source labelling', () => {
    test('a Zoho history entry is labelled zoho', () => {
      expect(sourceOf(ev({ metadata: '{"zohoCommentId":"c1"}' }))).toBe('zoho');
    });

    test('an app action is labelled app', () => {
      expect(sourceOf(ev({ event_type: 'MANAGEMENT_APPROVED', metadata: null }))).toBe('app');
    });

    test('malformed metadata does not mislabel the source', () => {
      expect(sourceOf(ev({ event_type: 'MANAGEMENT_APPROVED', metadata: 'not json' }))).toBe('app');
    });
  });

  describe('a stage satisfied by Zoho STATE rather than an event', () => {
    // SO-59373 exactly as the live org reports it: shipped via Lalamove on
    // 31 Jan with `tracking_number: ""`, so the reconcile never recorded a
    // shipment and the pipeline showed "Shipped: pending" while the order
    // header said Dispatched. 58,824 orders were in that state.
    const order = {
      getmeds_order_id: 'ZOHO-SO-59373',
      zoho_so_status: 'shipped',
      zoho_order_status: 'confirmed',
      zoho_invoiced_status: 'invoiced',
      zoho_paid_status: 'paid',
      zoho_shipped_status: 'shipped'
    };
    const t = buildTimeline(order, [
      ev({ id: 1, event_type: 'ZOHO_PACKAGE_CREATED', actor_name: 'Zoho', created_at: '2026-01-31T00:09:00.000Z' })
    ]);

    test('Shipped is done, even with no shipment event', () => {
      expect(stage(t, 'shipped').state).toBe('done');
      expect(stage(t, 'shipped').evidence).toBe('state');
    });

    test('it carries no time and no person, because Zoho gives neither', () => {
      // The failure this whole effort began with was a trail that looked
      // precise and was wrong. A state-satisfied stage must not invent a
      // timestamp to look tidy.
      expect(stage(t, 'shipped').at).toBeNull();
      expect(stage(t, 'shipped').by).toBeNull();
      expect(stage(t, 'shipped').note).toMatch(/current status/i);
    });

    test('an event beats state where both exist', () => {
      // Packed has a real event AND would be satisfied by shipped_status.
      expect(stage(t, 'packed').evidence).toBe('event');
      expect(stage(t, 'packed').at).toBe('2026-01-31T00:09:00.000Z');
    });

    test('shipped does NOT imply delivered', () => {
      // 'shipped' is in transit. Only Zoho's 'fulfilled' means it arrived,
      // and claiming delivery from a shipment would be inventing a fact.
      expect(stage(t, 'delivered').state).toBe('pending');
    });

    test('shipped does NOT imply completed while Zoho still calls it confirmed', () => {
      expect(stage(t, 'completed').state).toBe('pending');
    });

    test('the counts separate precise progress from merely-certain progress', () => {
      expect(t.counts.from_events).toBeGreaterThan(0);
      expect(t.counts.from_state).toBeGreaterThan(0);
      expect(t.counts.reached).toBe(t.counts.from_events + t.counts.from_state);
    });

    test('a fulfilled order reaches Delivered and Completed from state alone', () => {
      const done = buildTimeline(
        { getmeds_order_id: 'ZOHO-DONE', zoho_so_status: 'fulfilled', zoho_order_status: 'closed',
          zoho_invoiced_status: 'invoiced', zoho_paid_status: 'paid', zoho_shipped_status: 'fulfilled' },
        []
      );
      expect(stage(done, 'delivered').state).toBe('done');
      expect(stage(done, 'completed').state).toBe('done');
      expect(stage(done, 'packed').state).toBe('done'); // shipped implies packed
    });

    test('an order raised HERE is not swept along by Zoho state it does not have', () => {
      const gm = buildTimeline({ getmeds_order_id: 'GM-1' }, []);
      expect(gm.counts.reached).toBe(0);
      expect(stage(gm, 'shipped').state).toBe('pending');
    });
  });

  test('an order with no events at all is a clean empty pipeline', () => {
    const t = buildTimeline({ getmeds_order_id: 'GM-NEW' }, []);
    expect(t.counts.reached).toBe(0);
    expect(t.stages.every((s) => s.state === 'pending')).toBe(true);
  });
});

describe('GET /api/orders/:id serves the pipeline', () => {
  const ids = [];
  let token, customer, rep;

  beforeAll(async () => {
    const admin = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    token = admin.body.data.token;
    customer = await db.prepare('SELECT * FROM customers LIMIT 1').get();
    rep = await db.prepare("SELECT * FROM users WHERE LOWER(role)='medrep' LIMIT 1").get();
  });

  afterAll(async () => {
    for (const id of ids) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('the response carries both the raw events and the derived timeline', async () => {
    const now = new Date().toISOString();
    const info = await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_sync_status, created_at, updated_at)
         VALUES ('ZOHO-TIMELINE-API-1', ?, ?, 'ready_for_dispatch', 'direct', 100, 'x', 'synced', ?, ?)`
      )
      .run(customer.id, rep.id, now, now);
    const id = info.lastInsertRowid;
    ids.push(id);

    await db
      .prepare(
        `INSERT INTO order_events (order_id, event_type, actor_name, notes, metadata, created_at)
         VALUES (?, 'ZOHO_SO_CREATED', 'Aman Bishnoi', 'created', '{"zohoCommentId":"c1"}', '2026-09-09T07:14:00.000Z'),
                (?, 'ZOHO_SO_CONFIRMED', 'Aman Bishnoi', 'confirmed', '{"zohoCommentId":"c2"}', '2026-09-09T07:36:00.000Z'),
                (?, 'ZOHO_SO_EDITED', 'Fhaye', 'edited', NULL, '2026-09-09T08:00:00.000Z')`
      )
      .run(id, id, id);

    const res = await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(200);

    // `events` is untouched, so anything already reading it keeps working.
    expect(Array.isArray(res.body.data.events)).toBe(true);
    expect(res.body.data.events).toHaveLength(3);
    // …and every raw event now carries its tier, for anything that wants it.
    expect(res.body.data.events.map((e) => e.tier)).toEqual(['milestone', 'milestone', 'update']);

    const t = res.body.data.timeline;
    expect(t.stages).toHaveLength(SPINE.length);
    expect(t.counts.reached).toBe(2);

    const created = t.stages.find((s) => s.key === 'created');
    expect(created.state).toBe('done');
    expect(created.by).toBe('Aman Bishnoi');
    expect(created.source).toBe('zoho');

    // The edit collapses under the stage it followed rather than taking a row
    // of its own.
    const confirmed = t.stages.find((s) => s.key === 'confirmed');
    expect(confirmed.updates.map((u) => u.event_type)).toEqual(['ZOHO_SO_EDITED']);

    // And the imported order says where verification actually happened.
    const verified = t.stages.find((s) => s.key === 'verified');
    expect(verified.state).toBe('not_applicable');
    expect(verified.note).toMatch(/google/i);
  });
});
