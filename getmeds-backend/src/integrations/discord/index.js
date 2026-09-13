/**
 * Discord adapter factory — the single place the DISCORD_AUDIT_* settings are
 * read. Same shape as integrations/zoho/index.js.
 *
 * Sep 13, 2026. Used by services/discordAuditService.js to mirror each order's
 * audit trail into a Discord thread.
 *
 * Off unless DISCORD_AUDIT_ENABLED=true. Then DISCORD_AUDIT_MODE picks:
 *
 *   "mock"  (default, and the fallback for anything unknown)
 *           Nothing leaves this app. Each post is logged as [DISCORD_MOCK].
 *
 *   "live"  Posts through DISCORD_AUDIT_WEBHOOK_URL, and starts threads with
 *           DISCORD_BOT_TOKEN (a webhook can post, but not start a thread).
 *           Missing either one turns audit threads OFF with a warning rather
 *           than stopping the server: this is a side channel, never the system
 *           of record, and the order flow must not depend on it.
 */
require('dotenv').config();

const MockDiscordAdapter = require('./MockDiscordAdapter');
const LiveDiscordAdapter = require('./LiveDiscordAdapter');

const OFF = Object.freeze({ enabled: false, mode: 'off' });

let _instance = null;

function buildAdapter(env = process.env) {
  if ((env.DISCORD_AUDIT_ENABLED || '').trim().toLowerCase() !== 'true') return OFF;

  const mode = (env.DISCORD_AUDIT_MODE || 'mock').trim().toLowerCase();
  if (mode === 'live') {
    const missing = ['DISCORD_AUDIT_WEBHOOK_URL', 'DISCORD_BOT_TOKEN'].filter((k) => !env[k]);
    if (missing.length) {
      console.warn(`[DISCORD] DISCORD_AUDIT_MODE=live needs ${missing.join(' and ')}; order audit threads are OFF.`);
      return OFF;
    }
    try {
      const adapter = new LiveDiscordAdapter({
        webhookUrl: env.DISCORD_AUDIT_WEBHOOK_URL,
        botToken: env.DISCORD_BOT_TOKEN,
        perMinute: Number(env.DISCORD_MAX_PER_MINUTE),
      });
      adapter.enabled = true;
      console.log('[DISCORD] audit mode=live — order audit trails post to Discord threads.');
      return adapter;
    } catch (err) {
      console.warn(`[DISCORD] ${err.message}; order audit threads are OFF.`);
      return OFF;
    }
  }

  if (mode !== 'mock') console.warn(`[DISCORD] Unknown DISCORD_AUDIT_MODE="${mode}" — using mock.`);
  console.log('[DISCORD] audit mode=mock — audit posts are logged, nothing is sent.');
  const adapter = new MockDiscordAdapter();
  adapter.enabled = true;
  return adapter;
}

/** Lazy, like the Zoho factory: requiring this module never builds or throws. */
function getDiscordAdapter() {
  if (!_instance) _instance = buildAdapter();
  return _instance;
}

module.exports = {
  get enabled() { return getDiscordAdapter().enabled; },
  get mode() { return getDiscordAdapter().mode; },
  post: (...args) => getDiscordAdapter().post(...args),
  startThread: (...args) => getDiscordAdapter().startThread(...args),
  queueStats: () => getDiscordAdapter().stats?.() ?? null,
  getDiscordAdapter,
  /** For tests: build from an arbitrary env object, bypassing the singleton. */
  _buildAdapterForTest: buildAdapter,
  _resetForTest: () => { _instance = null; },
};
