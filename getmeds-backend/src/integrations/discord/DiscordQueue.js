// Sends webhook messages one at a time, at the pace Discord allows, so a burst of
// records waits in line instead of turning into a pile of 429s.
//
// What Discord enforces on a webhook:
//   - A short bucket, typically 5 requests per 2 seconds. Every response reports it in
//     X-RateLimit-Remaining and X-RateLimit-Reset-After, so we read those and wait.
//   - About 30 messages per minute per channel. The headers don't warn about this one,
//     so we count our own sends (DISCORD_MAX_PER_MINUTE).
//   - 10,000 invalid requests (401, 403, 429) in 10 minutes gets your IP banned by
//     Cloudflare. So the aim is to never get a 429, not just to survive one, and a
//     webhook Discord refuses stops the queue instead of failing message by message.
//
// One at a time is deliberate: parallel requests to one webhook only race each other
// for the same bucket.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULTS = {
  perMinute: 30,       // most requests in any window
  windowMs: 60_000,
  maxAttempts: 5,      // per message, across 429s, 5xx and network errors
  maxWaiting: 1000,    // past this, new messages fail at once instead of piling up in memory
  backoffMs: 1000,     // first wait after a 5xx or network error, doubling each time
  maxPauseMs: 60_000,  // cap on any single wait Discord asks for
};

class DiscordQueue {
  // send(payload) makes exactly one HTTP call and resolves to { status, headers, text }.
  constructor(send, options = {}) {
    this.send = send;
    this.opts = { ...DEFAULTS, ...options };
    this.jobs = [];            // oldest first; jobs[0] is the one in flight
    this.sentAt = [];          // requests still inside the window, stamped when Discord answered
    this.resumeAt = 0;         // no request before this, from Discord's headers or a 429
    this.reason = null;
    this.running = false;
    this.rejected = null;      // set once Discord refuses the webhook itself
    this.totals = { sent: 0, failed: 0, rateLimited: 0 };
  }

  // Resolves with { ok, attempts, text } once Discord accepts the message, rejects if it never does.
  // onUpdate({ state, attempts, note }) reports progress while the message waits.
  push(payload, onUpdate = () => {}) {
    let refusal = this.rejected;
    if (!refusal && this.jobs.length >= this.opts.maxWaiting) {
      refusal = new Error(`discord queue full (${this.opts.maxWaiting} waiting)`);
    }
    if (refusal) {
      this.totals.failed += 1;
      return Promise.reject(refusal);
    }
    return new Promise((resolve, reject) => {
      this.jobs.push({ payload, onUpdate, attempts: 0, resolve, reject });
      this.run().catch((err) => console.error('[discord] queue stopped:', err));
    });
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        await this.waitForTurn();
        const job = this.jobs[0];
        job.attempts += 1;
        job.onUpdate({ state: 'sending', attempts: job.attempts, note: null });
        this.sentAt.push(Date.now());   // counts toward the window while in flight

        let res;
        try {
          res = await this.send(job.payload);
        } catch (err) {
          res = { status: 0, headers: new Headers(), text: err.message };   // network error or timeout
        }
        // Discord counted this request somewhere between sending and answering. Keep the later
        // time, so our window never frees up before Discord's does.
        this.sentAt[this.sentAt.length - 1] = Date.now();
        this.readBucket(res.headers);
        this.settle(job, res);
      }
    } finally {
      this.running = false;
    }
  }

  async waitForTurn() {
    for (let slot = this.nextSlot(); slot.at > Date.now(); slot = this.nextSlot()) {
      const ms = slot.at - Date.now();
      if (ms > 2500) console.log(`[discord] holding ${this.jobs.length} message(s) for ${Math.ceil(ms / 1000)}s: ${slot.reason}`);
      await sleep(ms);
    }
  }

  // When the next request may go out, and why not sooner.
  nextSlot(now = Date.now()) {
    while (this.sentAt.length && now - this.sentAt[0] >= this.opts.windowMs) this.sentAt.shift();
    let at = now;
    let reason = null;
    if (this.resumeAt > at) {
      at = this.resumeAt;
      reason = this.reason;
    }
    if (this.sentAt.length >= this.opts.perMinute) {
      const free = this.sentAt[0] + this.opts.windowMs;
      if (free > at) {
        at = free;
        reason = `${this.opts.perMinute} per minute limit`;
      }
    }
    return { at, reason };
  }

  // Discord says how many requests are left in the current bucket. At zero, wait for the reset.
  readBucket(headers) {
    if (headers.get('x-ratelimit-remaining') !== '0') return;
    const resetAfter = Number(headers.get('x-ratelimit-reset-after'));   // seconds
    if (resetAfter > 0) this.pause(resetAfter * 1000, 'Discord bucket empty');
  }

  settle(job, { status, headers, text }) {
    if (status >= 200 && status < 300) {
      this.totals.sent += 1;
      return this.finish(job, null, { ok: true, attempts: job.attempts, text });
    }

    if (status === 401 || (status === 404 && discordCode(text) === 10015)) {
      // The webhook itself is wrong (401) or deleted (404 Unknown Webhook). Every later message
      // would fail the same way and count against the invalid-request limit, so stop sending
      // altogether. Other 4xx, like a deleted message or thread, fail just that one below.
      this.rejected = new Error(`discord ${status}: ${discordMessage(text)}. Fix DISCORD_WEBHOOK_URL and restart`);
      console.warn(`[discord] ${this.rejected.message}. Dropping ${this.jobs.length} queued message(s).`);
      for (const j of this.jobs.splice(0)) this.finish(j, this.rejected);
      return;
    }

    if (status !== 429 && status !== 0 && status < 500) {
      // 400 and friends: the payload is wrong. Sending it again won't change the answer.
      return this.finish(job, new Error(`discord ${status}: ${discordMessage(text)}`));
    }

    let why;
    let wait;
    if (status === 429) {
      this.totals.rateLimited += 1;
      why = 'Discord answered 429';
      wait = retryAfterMs(headers, text);
    } else {
      why = status ? `Discord answered ${status}` : `network error (${text})`;
      wait = this.opts.backoffMs * 2 ** (job.attempts - 1);
    }
    const paused = this.pause(wait, why);   // the whole line waits, so order is kept

    if (job.attempts >= this.opts.maxAttempts) {
      return this.finish(job, new Error(`${why}, gave up after ${job.attempts} attempts`));
    }
    console.warn(`[discord] ${why}, retrying in ${Math.ceil(paused / 1000)}s (attempt ${job.attempts} of ${this.opts.maxAttempts})`);
    job.onUpdate({ state: 'queued', note: `${why}, retrying.` });
  }

  finish(job, err, result) {
    if (this.jobs[0] === job) this.jobs.shift();
    if (err) {
      this.totals.failed += 1;
      job.reject(err);
    } else {
      job.resolve(result);
    }
  }

  pause(ms, reason) {
    const wait = Math.min(ms, this.opts.maxPauseMs);
    const until = Date.now() + wait;
    if (until > this.resumeAt) {
      this.resumeAt = until;
      this.reason = reason;
    }
    return wait;
  }

  // Depth and pacing, for the test page.
  stats() {
    const now = Date.now();
    const slot = this.nextSlot(now);
    const held = this.jobs.length > 0 && slot.at > now;
    return {
      waiting: this.jobs.length,
      sentInWindow: this.sentAt.length,
      perMinute: this.opts.perMinute,
      resumeInMs: held ? slot.at - now : 0,
      reason: held ? slot.reason : null,
      totals: { ...this.totals },
      rejected: this.rejected?.message ?? null,
    };
  }
}

// How long a 429 says to wait. The Retry-After header is in seconds; the JSON body is the fallback.
function retryAfterMs(headers, text) {
  const header = Number(headers.get('retry-after'));
  if (header > 0) return header * 1000;
  try {
    const { retry_after: seconds } = JSON.parse(text);
    if (seconds > 0) return seconds * 1000;
  } catch { /* not JSON, e.g. a Cloudflare error page */ }
  return 1000;
}

// Discord errors look like {"message": "Unknown Webhook", "code": 10015}.
function discordCode(text) {
  try {
    return JSON.parse(text).code;
  } catch {
    return undefined;
  }
}

function discordMessage(text) {
  try {
    return describeDiscordError(JSON.parse(text)) ?? text;
  } catch {
    return text || 'no details';
  }
}

// Discord's message, plus the first field error when it's an Invalid Form Body, which nests them
// by field: {"message": "Invalid Form Body", "errors": {"content": {"_errors": [{"message": "..."}]}}}
function describeDiscordError(body) {
  if (!body || typeof body !== 'object') return null;
  const detail = firstFieldError(body.errors);
  return detail ? `${body.message} (${detail})` : body.message ?? null;
}

function firstFieldError(errors, path = []) {
  if (!errors || typeof errors !== 'object') return null;
  const own = errors._errors?.[0]?.message;
  if (own) return path.length ? `${path.join('.')}: ${own}` : own;
  for (const [key, value] of Object.entries(errors)) {
    if (key === '_errors') continue;
    const found = firstFieldError(value, [...path, key]);
    if (found) return found;
  }
  return null;
}

module.exports = { DiscordQueue, describeDiscordError };
