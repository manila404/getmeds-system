'use strict';

function getDb() {
  return require('../db/database');
}

const LIMIT_STATE_KEY = 'zoho_daily_limit:state';
const CALLS_KEY_PREFIX = 'zoho_api_calls:';
const DEFAULT_PAUSE_MS = parseInt(process.env.ZOHO_DAILY_LIMIT_PAUSE_MS, 10) || 60 * 60 * 1000; // 60 min auto-probe
const CACHE_TTL_MS = 10 * 1000;
const FLUSH_EVERY_CALLS = 10;
const FLUSH_INTERVAL_MS = 15 * 1000;
const DAILY_CAP = parseInt(process.env.ZOHO_DAILY_CAP, 10) || 10000;

let _limitCache = null; // { expiresAt, value: { limited, pausedUntil, reason, ymd } }
let _callBuffer = { ymd: null, delta: 0, lastFlushedAt: 0 };
let _flushPromise = null;

function manilaNow(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600 * 1000);
}

function manilaYmd(now = new Date()) {
  return manilaNow(now).toISOString().slice(0, 10);
}

function manilaHour(now = new Date()) {
  return manilaNow(now).getUTCHours();
}

function isZohoDailyLimitError(errOrRes) {
  if (!errOrRes) return false;
  if (errOrRes.isDailyLimit) return true;
  const msg = String(errOrRes.message || errOrRes.last_error || '');
  return /maximum call rate limit|10,000/i.test(msg);
}

async function readState(key) {
  try {
    const row = await getDb().prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

async function writeState(key, value) {
  const now = new Date().toISOString();
  await getDb()
    .prepare(
      `INSERT INTO sync_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`
    )
    .run(key, String(value), now);
}

/**
 * Shared DB-backed daily limit circuit breaker (persisted in sync_state).
 * Auto-expires after pauseMs OR when the Manila calendar day rolls over.
 */
async function getDailyLimitStatus({ forceRead = false } = {}) {
  const today = manilaYmd();
  if (!forceRead && _limitCache && _limitCache.expiresAt > Date.now()) {
    const v = _limitCache.value;
    if (v.limited && (Date.now() >= v.pausedUntil || v.ymd !== today)) {
      const cleared = { limited: false, pausedUntil: null, reason: null, ymd: null };
      _limitCache = { expiresAt: Date.now() + CACHE_TTL_MS, value: cleared };
      return cleared;
    }
    return v;
  }

  const raw = await readState(LIMIT_STATE_KEY);
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  const active = Boolean(
    parsed &&
      parsed.pausedUntil &&
      Number(parsed.pausedUntil) > Date.now() &&
      parsed.ymd === today
  );

  const value = active
    ? {
        limited: true,
        pausedUntil: Number(parsed.pausedUntil),
        reason: parsed.reason || 'Zoho daily API rate limit exhausted',
        ymd: parsed.ymd
      }
    : { limited: false, pausedUntil: null, reason: null, ymd: null };

  _limitCache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
  return value;
}

async function tripDailyLimit(reason, pauseMs = DEFAULT_PAUSE_MS) {
  const safePauseMs = Math.max(1000, Number(pauseMs) || DEFAULT_PAUSE_MS);
  const pausedUntil = Date.now() + safePauseMs;
  const ymd = manilaYmd();
  const payload = {
    pausedUntil,
    reason: String(reason || 'Zoho daily API limit exhausted'),
    trippedAt: new Date().toISOString(),
    ymd
  };
  _limitCache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value: { limited: true, pausedUntil, reason: payload.reason, ymd }
  };
  try {
    await writeState(LIMIT_STATE_KEY, JSON.stringify(payload));
  } catch {
    // Non-fatal: in-memory cache still protects this process.
  }
  return payload;
}

async function clearDailyLimit() {
  if (_limitCache && !_limitCache.value?.limited) {
    return;
  }
  _limitCache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value: { limited: false, pausedUntil: null, reason: null, ymd: null }
  };
  try {
    await getDb().prepare('DELETE FROM sync_state WHERE key = ?').run(LIMIT_STATE_KEY);
  } catch {
    // Non-fatal
  }
}

async function flushCallCounter() {
  if (_flushPromise) return _flushPromise;
  if (!_callBuffer.delta || !_callBuffer.ymd) return;
  const ymd = _callBuffer.ymd;
  const delta = _callBuffer.delta;
  _callBuffer.delta = 0;
  _callBuffer.lastFlushedAt = Date.now();

  _flushPromise = (async () => {
    try {
      const key = `${CALLS_KEY_PREFIX}${ymd}`;
      const existingRaw = await readState(key);
      const existing = parseInt(existingRaw, 10);
      const next = (Number.isFinite(existing) ? existing : 0) + delta;
      await writeState(key, String(next));
    } catch {
      // Telemetry is best-effort only; never break outbound Zoho requests.
    } finally {
      _flushPromise = null;
    }
  })();
  return _flushPromise;
}

function recordCall() {
  const today = manilaYmd();
  if (_callBuffer.ymd && _callBuffer.ymd !== today && _callBuffer.delta > 0) {
    flushCallCounter().catch(() => {});
  }
  _callBuffer.ymd = today;
  _callBuffer.delta += 1;

  if (
    _callBuffer.delta >= FLUSH_EVERY_CALLS ||
    Date.now() - _callBuffer.lastFlushedAt >= FLUSH_INTERVAL_MS
  ) {
    flushCallCounter().catch(() => {});
  }
}

async function getUsageSnapshot() {
  await flushCallCounter();
  const today = manilaYmd();
  const rawCount = await readState(`${CALLS_KEY_PREFIX}${today}`);
  const dbCount = parseInt(rawCount, 10);
  const callsToday = (Number.isFinite(dbCount) ? dbCount : 0) + (_callBuffer.ymd === today ? _callBuffer.delta : 0);
  const status = await getDailyLimitStatus({ forceRead: true });
  return {
    ymd: today,
    callsToday,
    dailyCap: DAILY_CAP,
    remainingEstimate: Math.max(0, DAILY_CAP - callsToday),
    limited: status.limited,
    pausedUntil: status.pausedUntil ? new Date(status.pausedUntil).toISOString() : null,
    reason: status.reason || null
  };
}

function _resetForTest() {
  _limitCache = null;
  _callBuffer = { ymd: null, delta: 0, lastFlushedAt: 0 };
  _flushPromise = null;
}

module.exports = {
  LIMIT_STATE_KEY,
  CALLS_KEY_PREFIX,
  DEFAULT_PAUSE_MS,
  manilaYmd,
  manilaHour,
  isZohoDailyLimitError,
  readState,
  writeState,
  getDailyLimitStatus,
  tripDailyLimit,
  clearDailyLimit,
  recordCall,
  flushCallCounter,
  getUsageSnapshot,
  _resetForTest
};
