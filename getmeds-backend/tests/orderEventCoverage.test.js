/**
 * Sep 26, 2026 — order_events only takes dates its partitions cover.
 *
 * The historical partition was dropped, leaving order_events_current from
 * 2026-03-01. A Zoho reconcile that backfilled an event dated 12 Oct 2023 was refused
 * by Postgres ("no partition of relation order_events found for row") and failed the
 * whole reconcile, every pass. Those old-dated events are now skipped.
 */
const mockAll = jest.fn();
jest.mock('../src/db/database', () => ({
  prepare: () => ({ all: (...a) => mockAll(...a) }),
}));

const { isCovered, coverageFloor, parseBound, resetCoverageCache } = require('../src/services/orderEventCoverage');

const CURRENT = "FOR VALUES FROM ('2026-03-01T00:00:00.000Z') TO (MAXVALUE)";

beforeEach(() => {
  resetCoverageCache();
  mockAll.mockReset();
});

describe('parseBound', () => {
  test('reads a from/to range, MINVALUE and MAXVALUE, and DEFAULT', () => {
    expect(parseBound(CURRENT)).toEqual({ from: '2026-03-01T00:00:00.000Z', to: null });
    expect(parseBound("FOR VALUES FROM (MINVALUE) TO ('2026-03-01T00:00:00.000Z')")).toEqual({ from: null, to: '2026-03-01T00:00:00.000Z' });
    expect(parseBound('DEFAULT')).toEqual({ any: true });
    expect(parseBound('something unexpected')).toEqual({ any: true });
  });
});

describe('isCovered', () => {
  test('with only order_events_current, 2023 is not covered and today is', async () => {
    mockAll.mockResolvedValue([{ bound: CURRENT }]);
    expect(await isCovered('2023-10-12T08:12:50.000Z')).toBe(false);
    expect(await isCovered('2026-02-28T23:59:59.999Z')).toBe(false);
    expect(await isCovered('2026-03-01T00:00:00.000Z')).toBe(true);
    expect(await isCovered('2026-09-26T07:13:23.530Z')).toBe(true);
    expect(await coverageFloor()).toBe('2026-03-01T00:00:00.000Z');
  });

  test('a historical partition covers the old dates again', async () => {
    mockAll.mockResolvedValue([
      { bound: "FOR VALUES FROM (MINVALUE) TO ('2026-03-01T00:00:00.000Z')" },
      { bound: CURRENT },
    ]);
    expect(await isCovered('2023-10-12T08:12:50.000Z')).toBe(true);
    expect(await coverageFloor()).toBeNull();
  });

  test('a DEFAULT partition, no partitions, or an unreadable catalogue: everything counts as covered', async () => {
    mockAll.mockResolvedValue([{ bound: CURRENT }, { bound: 'DEFAULT' }]);
    expect(await isCovered('2023-10-12T08:12:50.000Z')).toBe(true);

    resetCoverageCache();
    mockAll.mockResolvedValue([]);
    expect(await isCovered('2023-10-12T08:12:50.000Z')).toBe(true);

    resetCoverageCache();
    mockAll.mockRejectedValue(new Error('not postgres'));
    expect(await isCovered('2023-10-12T08:12:50.000Z')).toBe(true);
    expect(await coverageFloor()).toBeNull();
  });

  test('the catalogue is read once, not per event', async () => {
    mockAll.mockResolvedValue([{ bound: CURRENT }]);
    await isCovered('2026-04-01T00:00:00.000Z');
    await isCovered('2023-01-01T00:00:00.000Z');
    await coverageFloor();
    expect(mockAll).toHaveBeenCalledTimes(1);
  });
});
