'use strict';

/**
 * Posts to a real Discord channel: a webhook for messages, the bot for threads.
 *
 * Sep 13, 2026. Carried over from the record_database practice project, where
 * it was tested against a stand-in that enforces Discord's documented limits.
 *
 * Every webhook post goes through DiscordQueue, which sends one at a time and
 * paces to Discord's rate limits instead of retrying through 429s (see the
 * header of DiscordQueue.js for why a 429 is worth avoiding, not surviving).
 *
 * Errors never include a URL: the webhook URL carries its own token.
 */
const { DiscordQueue, describeDiscordError } = require('./DiscordQueue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// https://discord.com/api/webhooks/{id}/{token} -> its parts, plus the API base on the same host.
function parseWebhookUrl(url) {
  const u = new URL(url);
  const match = u.pathname.match(/\/webhooks\/(\d+)\/([^/]+)/);
  if (!match) throw new Error('DISCORD_AUDIT_WEBHOOK_URL does not look like a Discord webhook URL');
  return { api: `${u.origin}/api/v10`, id: match[1], token: match[2] };
}

function explain(status, url, body) {
  const what = url.includes('/threads') ? 'thread' : url.includes('/channels/') ? 'channel' : 'webhook';
  if (status === 401 && what !== 'webhook') return 'Discord refused DISCORD_BOT_TOKEN (401). Copy it again from the bot page';
  if (status === 403 && what === 'thread') return "The bot can't start threads (403). Invite it with Create Public Threads";
  if (status === 403) return "The bot can't see the audit channel (403). Add it with View Channels and Read Message History";
  if (status === 404 && what === 'webhook') return "Discord doesn't know this webhook (404). Check DISCORD_AUDIT_WEBHOOK_URL";
  return `Discord answered ${status} (${describeDiscordError(body) ?? 'no details'})`;
}

// One bot API call with Discord's rate limits respected.
async function request(method, url, botToken, body) {
  for (let attempt = 1; ; attempt++) {
    const headers = {};
    if (botToken) headers.Authorization = `Bot ${botToken}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep((Number(res.headers.get('retry-after')) || 1) * 1000);
      continue;
    }
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      const err = new Error(explain(res.status, url, info));
      err.status = res.status;
      err.code = info.code;
      throw err;
    }
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      await sleep((Number(res.headers.get('x-ratelimit-reset-after')) || 0) * 1000);
    }
    return res.json();
  }
}

class LiveDiscordAdapter {
  constructor({ webhookUrl, botToken, perMinute }) {
    this.mode = 'live';
    this.webhookUrl = webhookUrl;
    this.hook = parseWebhookUrl(webhookUrl);
    this.botToken = botToken;
    this.channelId = null;
    this.botLine = Promise.resolve();   // bot writes go one at a time, like the webhook queue
    this.queue = new DiscordQueue((job) => this.send(job), perMinute > 0 ? { perMinute } : {});
  }

  /** Joins the queue. Resolves once Discord has stored the message; threadId posts inside that thread. */
  async post(payload, { threadId } = {}) {
    const { attempts, text } = await this.queue.push({ payload, threadId });
    const message = text ? JSON.parse(text) : null;
    return { messageId: message?.id ?? null, attempts };
  }

  /**
   * Exactly one HTTP call, no retries: the queue decides when and what the
   * answer means. ?wait=true makes Discord answer with the stored message,
   * which carries its id. Posting into an archived thread reopens it.
   */
  async send({ payload, threadId }) {
    const url = new URL(this.webhookUrl);
    url.searchParams.set('wait', 'true');
    if (threadId) url.searchParams.set('thread_id', threadId);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),   // a hung request would stall the whole queue
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  /** The channel the webhook posts to, looked up once. */
  async channel() {
    if (!this.channelId) {
      const { api, id, token } = this.hook;
      this.channelId = (await request('GET', `${api}/webhooks/${id}/${token}`)).channel_id;
    }
    return this.channelId;
  }

  /**
   * Starts a public thread on one of our messages. A thread started from a
   * message takes the message's id. Needs the bot's Create Public Threads.
   */
  startThread(messageId, name) {
    const run = async () => {
      const channelId = await this.channel();
      try {
        return await request('POST', `${this.hook.api}/channels/${channelId}/messages/${messageId}/threads`, this.botToken, {
          name: String(name).slice(0, 100),
          auto_archive_duration: 10080,   // a week without activity; the next post reopens it
        });
      } catch (err) {
        if (err.code === 160004) return { id: messageId };   // already has a thread, e.g. on a retry
        throw err;
      }
    };
    const result = this.botLine.then(run, run);
    this.botLine = result.catch(() => {});
    return result;
  }

  stats() {
    return this.queue.stats();
  }
}

module.exports = LiveDiscordAdapter;
