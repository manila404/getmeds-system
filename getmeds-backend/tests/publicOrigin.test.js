const { publicOrigin } = require('../src/services/publicOrigin');

// A minimal Express-like request.
const req = (headers = {}, protocol = 'http') => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: h, protocol, get: (k) => h[k.toLowerCase()] };
};

describe('publicOrigin (Nov 20, 2026: attachment links must be https behind Cloudflare / Coolify)', () => {
  const saved = process.env.PUBLIC_API_URL;
  afterEach(() => { if (saved === undefined) delete process.env.PUBLIC_API_URL; else process.env.PUBLIC_API_URL = saved; });

  it('a public host behind a proxy that says http is still https', () => {
    expect(publicOrigin(req({ host: 'api-hub.bishnoi.ai', 'x-forwarded-proto': 'http' }))).toBe('https://api-hub.bishnoi.ai');
  });

  it("follows Cloudflare's cf-visitor scheme", () => {
    expect(publicOrigin(req({ host: 'api-hub.bishnoi.ai', 'cf-visitor': '{"scheme":"https"}' }))).toBe('https://api-hub.bishnoi.ai');
  });

  it('uses the first X-Forwarded-Proto / X-Forwarded-Host of a list', () => {
    expect(publicOrigin(req({ host: 'internal:4000', 'x-forwarded-host': 'api.getmeds.ph, internal', 'x-forwarded-proto': 'https,http' })))
      .toBe('https://api.getmeds.ph');
  });

  it('localhost and LAN addresses keep http (mock / dev)', () => {
    expect(publicOrigin(req({ host: 'localhost:4000' }))).toBe('http://localhost:4000');
    expect(publicOrigin(req({ host: '192.168.1.20:4000' }))).toBe('http://192.168.1.20:4000');
  });

  it('PUBLIC_API_URL wins, without a trailing slash', () => {
    process.env.PUBLIC_API_URL = 'https://api.getmeds.ph/';
    expect(publicOrigin(req({ host: 'localhost:4000' }))).toBe('https://api.getmeds.ph');
  });
});
