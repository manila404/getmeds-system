/**
 * A very small in-memory throttle for the one public write endpoint this API
 * has, POST /api/auth/register.
 *
 * Sep 2, 2026. Everything else that writes is behind requireAuth, so an
 * abusive caller needs an account first. Sign-up is the exception: it is
 * reachable by anyone who can reach the server and it inserts a row every
 * time. This caps that at a rate no real person signing up would ever reach,
 * while still being generous enough that a testing session creating a handful
 * of accounts in a row never notices it.
 *
 * Deliberately in-memory and deliberately per-process — the same reasoning as
 * services/syncJobs.js. It is a speed bump, not a security control: it resets
 * on restart and would need a shared store if this ever ran as more than one
 * process. It is not a substitute for turning SIGNUP_ENABLED off, or for
 * putting a real WAF/rate limiter in front of a public deployment.
 *
 * Skipped entirely under jest and in TEST_MODE, so neither the test suite nor
 * a demo creating accounts in bulk trips over it.
 */
const { isTestModeEnabled } = require('./testMode');

const WINDOW_MS = Number(process.env.SIGNUP_RATE_WINDOW_MS) || 10 * 60 * 1000; // 10 minutes
const MAX_PER_WINDOW = Number(process.env.SIGNUP_RATE_MAX) || 10;

// ip -> array of timestamps within the current window
const hits = new Map();

// Bounded cleanup: drop ips whose window has fully expired. Runs on write, so
// there is no timer to leak and nothing to unref.
function sweep(now) {
  for (const [ip, times] of hits) {
    if (!times.length || now - times[times.length - 1] > WINDOW_MS) hits.delete(ip);
  }
}

function signupRateLimit(req, res, next) {
  if (process.env.IS_JEST === 'true' || isTestModeEnabled()) return next();

  const now = Date.now();
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';

  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_PER_WINDOW) {
    const retryAfterSec = Math.ceil((WINDOW_MS - (now - recent[0])) / 1000);
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      success: false,
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: `Too many sign-up attempts from this address. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`
      }
    });
  }

  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) sweep(now);

  next();
}

// Exposed for tests and for anyone who needs to clear state between runs.
signupRateLimit._reset = () => hits.clear();

module.exports = { signupRateLimit };
