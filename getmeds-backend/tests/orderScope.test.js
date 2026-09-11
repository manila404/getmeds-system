/**
 * Sep 11, 2026 — scoped manager visibility (Phase A).
 *
 * Three managers: one who sees everything and owns the approval queue, and two
 * who each cover their own divisions. This file covers the two pieces that
 * decide what anyone can see:
 *
 *   divisionFromSalesperson — what division an imported order belongs to
 *   orderScopeService       — what a given user may see and act on
 *
 * The assertions that matter most are the negative ones. A scoping bug does
 * not throw; it silently shows somebody another division's orders, and every
 * screen still looks right. So the tests below spend most of their effort on
 * what must NOT be visible.
 */
const db = require('../src/db/database');
const { divisionFromSalesperson, prefixOf } = require('../src/services/divisionFromSalesperson');
const scope = require('../src/services/orderScopeService');

describe('divisionFromSalesperson', () => {
  test('reads the division out of Zoho’s "DIVISION | who" convention', () => {
    expect(divisionFromSalesperson('HOS | LAGUNA')).toBe('HOS');
    expect(divisionFromSalesperson('B2B | RENROSE')).toBe('B2B');
    expect(divisionFromSalesperson('CLIDP | someone')).toBe('CLIDP');
  });

  test('prefers the longest matching division', () => {
    // The one that silently mis-files orders if it regresses: "TeleSales
    // Anesthesia" starts with "TeleSales", so a shortest-first match would put
    // all 493 Anesthesia orders in front of whoever covers plain TeleSales.
    expect(divisionFromSalesperson('TeleSales Anesthesia | X')).toBe('TeleSales Anesthesia');
    expect(divisionFromSalesperson('TeleSales | X')).toBe('TeleSales');
    expect(divisionFromSalesperson('MD Telesales l Visayas')).toBe('MD Telesales');
  });

  test('returns the canonical spelling, whatever case Zoho holds', () => {
    // Zoho has "Telesales", "TeleSales" and "TELESALES" for one division. The
    // column must end up with a single form or scope rules match some orders
    // and not others.
    expect(divisionFromSalesperson('telesales | x')).toBe('TeleSales');
    expect(divisionFromSalesperson('TELESALES | x')).toBe('TeleSales');
  });

  test('tolerates a missing separator', () => {
    expect(divisionFromSalesperson('B2B FILRES BELARMINO')).toBe('B2B');
  });

  test('never guesses — anything that is not a division is null', () => {
    // Each of these is real data, and each would be an order shown to the
    // wrong manager if this matched loosely.
    expect(divisionFromSalesperson('Mohit Kumar')).toBeNull();   // a person
    expect(divisionFromSalesperson('WEB')).toBeNull();           // a channel
    expect(divisionFromSalesperson('Shopee')).toBeNull();
    expect(divisionFromSalesperson('Lazada')).toBeNull();
    expect(divisionFromSalesperson('DSWD')).toBeNull();          // removed division
    expect(divisionFromSalesperson('PCSO')).toBeNull();
    // A prefix that merely STARTS with a division name is not that division.
    expect(divisionFromSalesperson('B2Bsomething')).toBeNull();
  });

  test('handles the 30,854 orders that carry no salesperson at all', () => {
    expect(divisionFromSalesperson('')).toBeNull();
    expect(divisionFromSalesperson('   ')).toBeNull();
    expect(divisionFromSalesperson(null)).toBeNull();
    expect(divisionFromSalesperson(undefined)).toBeNull();
    expect(prefixOf(null)).toBe('');
  });
});

describe('orderScopeService', () => {
  const ALL = { mode: scope.SCOPE_ALL, rules: [] };
  const B2B_AND_CLIDP = {
    mode: scope.SCOPE_DIVISIONS,
    rules: [{ division: 'B2B', sub_division: null }, { division: 'CLIDP', sub_division: null }]
  };
  const B2B_NBD_ONLY = {
    mode: scope.SCOPE_DIVISIONS,
    rules: [{ division: 'B2B', sub_division: 'NBD' }]
  };

  describe('scopeSql', () => {
    test('a full-scope user gets no restriction at all', () => {
      const { sql, params } = scope.scopeSql(ALL);
      expect(sql).toBeNull();
      expect(params).toEqual([]);
    });

    test('FAILS CLOSED: a scoped user with no rules sees nothing', () => {
      // The single most important assertion here. The tempting default is
      // "nothing configured, so no restrictions" — which turns a half-finished
      // setup into full access and looks completely normal on screen.
      const { sql, params } = scope.scopeSql({ mode: scope.SCOPE_DIVISIONS, rules: [] });
      expect(sql).toBe('1 = 0');
      expect(params).toEqual([]);
    });

    test('a division rule matches the whole division', () => {
      const { sql, params } = scope.scopeSql(B2B_AND_CLIDP);
      expect(sql).toBe('(o.division = ? OR o.division = ?)');
      expect(params).toEqual(['B2B', 'CLIDP']);
    });

    test('a sub-division rule narrows to that sub-division', () => {
      const { sql, params } = scope.scopeSql(B2B_NBD_ONLY);
      // The outer parens wrap the OR list, so a lone AND clause nests. Assert
      // the shape rather than the exact string — the grouping is what matters,
      // and pinning the spelling makes this fail on a harmless reformat.
      expect(sql).toContain('o.division = ?');
      expect(sql).toContain('AND o.sub_division = ?');
      expect(sql.startsWith('(')).toBe(true);
      expect(sql.endsWith(')')).toBe(true);
      expect(params).toEqual(['B2B', 'NBD']);
    });

    test('groups a mixed division + sub-division scope correctly', () => {
      // Precedence is the real risk: AND binds tighter than OR, so without the
      // inner parens `division = 'B2B' OR division = 'HOS' AND sub = 'LAGUNA'`
      // reads as "all of B2B, or HOS/LAGUNA" only by luck of ordering, and
      // flips meaning the moment the rules come back in a different order.
      const mixed = {
        mode: scope.SCOPE_DIVISIONS,
        rules: [
          { division: 'B2B', sub_division: null },
          { division: 'HOS', sub_division: 'LAGUNA' }
        ]
      };
      const { sql, params } = scope.scopeSql(mixed);
      expect(sql).toBe('(o.division = ? OR (o.division = ? AND o.sub_division = ?))');
      expect(params).toEqual(['B2B', 'HOS', 'LAGUNA']);

      // And the same scope, evaluated in JS, must agree with that SQL.
      expect(scope.covers(mixed, { division: 'B2B', sub_division: 'anything' })).toBe(true);
      expect(scope.covers(mixed, { division: 'HOS', sub_division: 'LAGUNA' })).toBe(true);
      expect(scope.covers(mixed, { division: 'HOS', sub_division: 'CEBU' })).toBe(false);
    });

    test('honours the caller’s table alias', () => {
      const { sql } = scope.scopeSql(B2B_AND_CLIDP, 'ord');
      expect(sql).toContain('ord.division');
      expect(sql).not.toContain('o.division');
    });
  });

  describe('covers — the guard on approve / reject / send back', () => {
    test('full scope covers everything, including an order with no division', () => {
      expect(scope.covers(ALL, { division: 'HOS' })).toBe(true);
      expect(scope.covers(ALL, { division: null })).toBe(true);
    });

    test('covers a division it holds, and refuses one it does not', () => {
      expect(scope.covers(B2B_AND_CLIDP, { division: 'B2B' })).toBe(true);
      expect(scope.covers(B2B_AND_CLIDP, { division: 'CLIDP' })).toBe(true);
      // Manager 3's division. If this ever returns true, manager 2 can approve
      // a HOS order.
      expect(scope.covers(B2B_AND_CLIDP, { division: 'HOS' })).toBe(false);
      expect(scope.covers(B2B_AND_CLIDP, { division: 'B2C' })).toBe(false);
    });

    test('an order with NO division is never covered by a scoped manager', () => {
      // 35,977 orders are in this state — half the imported history has no
      // Salesperson in Zoho, so no division can be attributed. They belong to
      // the full-scope manager alone; showing them to a scoped one would be a
      // guess dressed up as data.
      expect(scope.covers(B2B_AND_CLIDP, { division: null })).toBe(false);
      expect(scope.covers(B2B_AND_CLIDP, { division: '' })).toBe(false);
      expect(scope.covers(B2B_AND_CLIDP, {})).toBe(false);
      expect(scope.covers(B2B_AND_CLIDP, null)).toBe(false);
    });

    test('FAILS CLOSED: no rules covers nothing', () => {
      const none = { mode: scope.SCOPE_DIVISIONS, rules: [] };
      expect(scope.covers(none, { division: 'B2B' })).toBe(false);
      expect(scope.covers(none, { division: null })).toBe(false);
    });

    test('a whole-division rule covers every sub-division under it', () => {
      expect(scope.covers(B2B_AND_CLIDP, { division: 'B2B', sub_division: 'NBD' })).toBe(true);
      expect(scope.covers(B2B_AND_CLIDP, { division: 'B2B', sub_division: 'anything' })).toBe(true);
    });

    test('a sub-division rule does NOT cover the rest of its division', () => {
      expect(scope.covers(B2B_NBD_ONLY, { division: 'B2B', sub_division: 'NBD' })).toBe(true);
      expect(scope.covers(B2B_NBD_ONLY, { division: 'B2B', sub_division: 'CRR' })).toBe(false);
      // A B2B order with no sub-division recorded — which today is all 8,892 of
      // them — is not covered by an NBD-only rule.
      expect(scope.covers(B2B_NBD_ONLY, { division: 'B2B', sub_division: null })).toBe(false);
    });
  });

  describe('validateRule', () => {
    test('accepts a known division', () => {
      expect(scope.validateRule({ division: 'B2B' })).toBeNull();
      expect(scope.validateRule({ division: 'HOS', sub_division: 'LAGUNA' })).toBeNull();
    });

    test('accepts a free-text sub-division', () => {
      // B2B has no fixed sub-division list, and NBD/CRR are exactly the case
      // this has to allow.
      expect(scope.validateRule({ division: 'B2B', sub_division: 'NBD' })).toBeNull();
      expect(scope.validateRule({ division: 'B2B', sub_division: 'CRR' })).toBeNull();
    });

    test('rejects a division that is not on the list', () => {
      expect(scope.validateRule({ division: 'DSWD' })).toMatch(/Division must be one of/);
      expect(scope.validateRule({ division: '' })).toMatch(/Division must be one of/);
      expect(scope.validateRule({})).toMatch(/Division must be one of/);
    });
  });

  describe('loadScope', () => {
    test('roles that are not division-scoped get full scope', async () => {
      // Scoping is a MANAGEMENT concept. Finance and Dispatch work the whole
      // pipeline by function, and a MedRep is already limited to their own
      // orders by medrep_id — applying division scope to them would break
      // their queues rather than secure anything.
      for (const role of ['admin', 'finance', 'dispatch', 'medrep']) {
        const s = await scope.loadScope({ id: 1, role });
        expect(s.mode).toBe(scope.SCOPE_ALL);
      }
    });

    test('no user at all is scoped to nothing', async () => {
      const s = await scope.loadScope(null);
      expect(s.mode).toBe(scope.SCOPE_DIVISIONS);
      expect(s.rules).toEqual([]);
      expect(scope.scopeSql(s).sql).toBe('1 = 0');
    });
  });

  afterAll(async () => {
    if (db.close) await db.close();
  });
});
