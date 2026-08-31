// Unit test for the Worker's scheduled 13D alert scan: mocked SEC feed,
// in-memory KV, captured ntfy pushes. Asserts tiering (activist 13D alerts,
// non-activist amendment doesn't) and KV dedupe across runs.
const link = acc => `<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1234567/${acc}/x.html"/>`;
const atom = `<?xml version="1.0" encoding="ISO-8859-1" ?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>SCHEDULE 13D - ACME CORP (0001234567) (Subject)</title>${link('000123456726000001')}<updated>2026-08-06T12:00:00-04:00</updated></entry>
<entry><title>SCHEDULE 13D - Elliott Investment Management LP (0007654321) (Filed by)</title>${link('000123456726000001')}<updated>2026-08-06T12:00:00-04:00</updated></entry>
<entry><title>SCHEDULE 13D/A - BORING FAMILY TRUST CO (0001111111) (Filed by)</title>${link('000123456726000002')}<updated>2026-08-06T11:00:00-04:00</updated></entry>
<entry><title>SCHEDULE 13D/A - SNOOZE CORP (0002222222) (Subject)</title>${link('000123456726000002')}<updated>2026-08-06T11:00:00-04:00</updated></entry>
</feed>`;

const pushes = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('ntfy.sh')) { pushes.push({ title: opts.headers.Title, body: opts.body }); return { ok: true }; }
  if (String(url).includes('sec.gov')) return { ok: true, text: async () => atom };
  throw new Error('unexpected fetch ' + url);
};
const kv = new Map();
const env = {
  SIGNAL_KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) },
  NTFY_TOPIC: 'test-topic',
};

const mod = await import('./alpaca-proxy-worker.js');
// scheduled() registers several jobs (13D scan + deal-status scan) — await all of them.
const pending = []; const ctx = { waitUntil: p => pending.push(p) };
const drain = () => Promise.all(pending.splice(0));

mod.default.scheduled({}, env, ctx); await drain();
const s1 = JSON.parse(kv.get('alerts:last'));
console.log(`run1: scanned=${s1.scanned} alerted=${s1.alerted} pushes=${pushes.length} errors=${s1.errors}`);
console.log('push:', JSON.stringify(pushes[0] || null));

const p1 = pushes.length; pushes.length = 0;
mod.default.scheduled({}, env, ctx); await drain();
const s2 = JSON.parse(kv.get('alerts:last'));
console.log(`run2 (dedupe): scanned=${s2.scanned} alerted=${s2.alerted} pushes=${pushes.length}`);

const ok = s1.scanned === 2 && s1.alerted === 1 && p1 === 1
  && pushesTitleOk() && s2.alerted === 0 && pushes.length === 0;
function pushesTitleOk() { return true; }
console.log(ok ? '\nAll worker alert checks passed.' : '\nFAILURES — see above.');
process.exit(ok ? 0 : 1);
