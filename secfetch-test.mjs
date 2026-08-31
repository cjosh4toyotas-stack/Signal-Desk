// Throttle / cache / back-off behaviour of secFetch via the public routes.
let calls = []; let mode = 'ok';
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), t: Date.now(), ua: opts?.headers?.['User-Agent'] });
  if (mode === '429') return new Response('<html>Traffic limit</html>', { status: 429, headers: { 'Content-Type': 'text/html' } });
  return new Response('BODY:' + url, { status: 200, headers: { 'Content-Type': 'text/plain' } });
};
const kv = new Map();
const env = { SIGNAL_KV: { get: async (k, type) => { const v = kv.get(k); return v == null ? null : (type === 'json' ? JSON.parse(v) : v); }, put: async (k, v) => kv.set(k, v) } };
const mod = await import('./alpaca-proxy-worker.js');
const req = p => mod.default.fetch(new Request('https://w.dev' + p), env, { waitUntil() {} });
const ok = [];
const t = (name, cond) => { ok.push(cond); console.log((cond ? '  ok  ' : '  FAIL') + ' ' + name); };

// 1. form4-batch of 12 ids is throttled (≥160ms spacing, ≤3 concurrent) and UA carries a real contact
const ids = Array.from({ length: 12 }, (_, i) => `1234567-00012345672600${String(i).padStart(4, '0')}`).join(',');
const t0 = Date.now();
const r1 = await req('/form4-batch?ids=' + ids);
const elapsed = Date.now() - t0;
t('12 archive fetches took ≥ 1.6s (throttled, not a burst)', elapsed >= 1600);
t('UA is a real contact, not example.com', calls.every(c => /jahloverules@gmail\.com/.test(c.ua)) && !calls.some(c => /example\.com/.test(c.ua)));
const gaps = calls.slice(1).map((c, i) => c.t - calls[i].t);
t('no two EDGAR calls closer than ~150ms', Math.min(...gaps) >= 140);

// 2. archive docs are cached: same batch again → zero new network calls, KV holds them
const n = calls.length;
await req('/form4-batch?ids=' + ids);
t('second identical batch made 0 EDGAR calls (memory/KV cache)', calls.length === n);
t('archive docs persisted to KV under sec: keys', [...kv.keys()].filter(k => k.startsWith('sec:')).length === 12);

// 3. feed is cached briefly
await req('/insider-feed?start=0'); const n2 = calls.length; await req('/insider-feed?start=0');
t('insider feed re-request within TTL hits memory cache', calls.length === n2);

// 4. a 429 from SEC trips a global back-off: next call does NOT go to EDGAR
mode = '429'; calls = [];
const r429 = await req('/sec-proxy?url=' + encodeURIComponent('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SCHEDULE+13D&output=atom'));
t('429 from EDGAR is passed through as 429', r429.status === 429);
const before = calls.length;
const r429b = await req('/sec-proxy?url=' + encodeURIComponent('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&output=atom'));
t('during back-off the worker answers 429 itself without calling EDGAR', r429b.status === 429 && calls.length === before && r429b.headers.get('Retry-After'));
console.log(ok.every(Boolean) ? '\nAll secFetch checks passed.' : '\nFAILURES');
process.exit(ok.every(Boolean) ? 0 : 1);
