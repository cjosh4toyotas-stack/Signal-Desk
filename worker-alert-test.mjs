// Unit test for the Worker's scheduled 13D alert scan: mocked SEC feed +
// filing texts + SEC reference files + Alpaca bars, in-memory KV, captured
// ntfy pushes. Asserts:
//   • a new 13D by a roster activist on a real NYSE name → one push
//   • a non-activist 13D/A (tier 1) → never read, never pushed
//   • a new 13D on an OTC shell → read, recorded, suppressed by the gate
//   • a new 13D on a big NYSE name whose text is a dividend-in-stock
//     issuance (the Rainmaker pattern) → suppressed by kind
//   • history rows carry ticker + gate verdict
//   • KV dedupe across runs
import * as F from './test/fixtures.mjs';
const link = (cik, acc) => `<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/x.html"/>`;
const atom = `<?xml version="1.0" encoding="ISO-8859-1" ?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>SCHEDULE 13D - ACME CORP (0001234567) (Subject)</title>${link(1234567, '000123456726000001')}<updated>2026-09-15T12:00:00-04:00</updated></entry>
<entry><title>SCHEDULE 13D - Elliott Investment Management LP (0007654321) (Filed by)</title>${link(1234567, '000123456726000001')}<updated>2026-09-15T12:00:00-04:00</updated></entry>
<entry><title>SCHEDULE 13D/A - BORING FAMILY TRUST CO (0001111111) (Filed by)</title>${link(2222222, '000123456726000002')}<updated>2026-09-15T11:00:00-04:00</updated></entry>
<entry><title>SCHEDULE 13D/A - SNOOZE CORP (0002222222) (Subject)</title>${link(2222222, '000123456726000002')}<updated>2026-09-15T11:00:00-04:00</updated></entry>
<entry><title>SCHEDULE 13D - Rainmaker Worldwide Inc. (0002149815) (Subject)</title>${link(2149815, '000149315226042453')}<updated>2026-09-11T16:00:00-04:00</updated></entry>
<entry><title>SCHEDULE 13D - Moore Ryan Dennis (0003333333) (Filed by)</title>${link(2149815, '000149315226042453')}<updated>2026-09-11T16:00:00-04:00</updated></entry>
<entry><title>SCHEDULE 13D - DIVIDEND MILL CORP (0004444444) (Subject)</title>${link(4444444, '000123456726000004')}<updated>2026-09-15T10:00:00-04:00</updated></entry>
<entry><title>SCHEDULE 13D - Some Capital LP (0005555555) (Filed by)</title>${link(4444444, '000123456726000004')}<updated>2026-09-15T10:00:00-04:00</updated></entry>
</feed>`;
const texts = {
  '0001234567-26-000001': F.elliott,
  '0001493152-26-042453': F.rakr,
  '0001234567-26-000004': F.pik,
};
const listing = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [
  [1234567, 'ACME CORP', 'ACME', 'NYSE'],
  [2222222, 'SNOOZE CORP', 'SNZ', 'Nasdaq'],
  [2149815, 'Rainmaker Worldwide Inc.', 'RAKR', 'OTC'],
  [4444444, 'DIVIDEND MILL CORP', 'DVML', 'NYSE'],
] };
const frame = { data: [{ cik: 1234567, val: 100e6 }, { cik: 2222222, val: 50e6 }, { cik: 2149815, val: 95e6 }, { cik: 4444444, val: 200e6 }] };
const bar = (c, v, n = 25) => Array.from({ length: n }, () => ({ c, v, h: c, l: c }));
const bars = { bars: { ACME: bar(50, 2e6), SNZ: bar(20, 1e6), RAKR: bar(0.002, 5e6), DVML: bar(30, 3e6) } };

const mk = body => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => (typeof body === 'string' ? JSON.parse(body) : body), headers: { get: () => (typeof body === 'string' ? 'text/plain' : 'application/json') } });
const pushes = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('ntfy.sh')) { pushes.push({ title: opts.headers.Title, body: opts.body }); return { ok: true }; }
  if (u.includes('company_tickers_exchange.json')) return mk(listing);
  if (u.includes('/api/xbrl/frames/')) return mk(frame);
  if (u.includes('data.alpaca.markets')) return mk(bars);
  if (u.includes('getcurrent')) return mk(atom);
  const m = u.match(/\/(\d{10}-\d{2}-\d{6})\.txt$/);
  if (m) return mk(texts[m[1]] || 'Item 4. Investment purposes.');
  throw new Error('unexpected fetch ' + u);
};
const kv = new Map();
const env = {
  SIGNAL_KV: { get: async (k, type) => { const v = kv.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => kv.set(k, v) },
  NTFY_TOPIC: 'test-topic', APCA_API_KEY_ID: 'k', APCA_API_SECRET_KEY: 's',
};

const mod = await import('./alpaca-proxy-worker.js');
const pending = []; const ctx = { waitUntil: p => pending.push(p) };
const drain = () => Promise.all(pending.splice(0));

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  ok  ' : '  FAIL ') + name); };

mod.default.scheduled({}, env, ctx); await drain();
const s1 = JSON.parse(kv.get('alerts:last'));
console.log(`run1: scanned=${s1.scanned} alerted=${s1.alerted} gate=${s1.suppressedGate} kind=${s1.suppressedKind} pushes=${pushes.length} errors=${JSON.stringify(s1.errors)}`);
t('four 13D filings scanned', s1.scanned === 4);
t('exactly one push (Elliott on ACME)', s1.alerted === 1 && pushes.length === 1);
t('push is the ★ ACTIVIST title on ACME', /ACTIVIST 13D: ACME CORP/.test(pushes[0]?.title || ''));
t('push body carries ticker + market cap', /ACME \$5\.0B cap/.test(pushes[0]?.body || ''));
t('Rainmaker (OTC, $0.002) suppressed by the universe gate', s1.suppressedGate === 1);
t('dividend-in-stock 13D on a real NYSE name suppressed by kind', s1.suppressedKind === 1);
t('no errors', s1.errors.length === 0);

const hist = JSON.parse(kv.get('sched13-history'));
const byAcc = Object.fromEntries(hist.map(r => [r.acc, r]));
t('history: ACME row carries ticker + passing gate', byAcc['000123456726000001']?.tickers?.[0] === 'ACME' && byAcc['000123456726000001']?.gate?.pass === true);
const rk = byAcc['000149315226042453'];
t('history: Rainmaker row is kind=issuance', rk?.kind === 'issuance');
t('history: Rainmaker gate fails on exchange, price and cap', rk?.gate?.pass === false && rk.gate.reasons.some(r => /OTC/.test(r)) && rk.gate.reasons.some(r => /price/.test(r)) && rk.gate.reasons.some(r => /market cap/.test(r)));
t('history: tier-1 amendment was never read (no kind)', byAcc['000123456726000002'] && !byAcc['000123456726000002'].kind);

pushes.length = 0;
mod.default.scheduled({}, env, ctx); await drain();
const s2 = JSON.parse(kv.get('alerts:last'));
t('run 2: KV dedupe — nothing re-pushed', s2.alerted === 0 && pushes.length === 0);

// Direct verdict checks on the gate itself.
const { universeVerdict, UNIVERSE } = mod;
t('verdict: NYSE $50 / $5B / $100M ADV passes', universeVerdict({ exchange: 'NYSE', price: 50, mcap: 5e9, adv20Usd: 1e8 }).pass);
t('verdict: Nasdaq passes too', universeVerdict({ exchange: 'Nasdaq', price: 10, mcap: 3e8, adv20Usd: 2e6 }).pass);
t('verdict: OTC fails on exchange alone', !universeVerdict({ exchange: 'OTC', price: 50, mcap: 5e9, adv20Usd: 1e8 }).pass);
t('verdict: $1.95 fails price', universeVerdict({ exchange: 'NYSE', price: 1.95, mcap: 5e9, adv20Usd: 1e8 }).reasons.some(r => /price/.test(r)));
t('verdict: $249M fails cap', universeVerdict({ exchange: 'NYSE', price: 20, mcap: 249e6, adv20Usd: 1e8 }).reasons.some(r => /market cap/.test(r)));
t('verdict: unknown cap is NOT a pass', !universeVerdict({ exchange: 'NYSE', price: 20, mcap: null, adv20Usd: 1e8 }).pass);
t('verdict: $400K/day fails liquidity', universeVerdict({ exchange: 'NYSE', price: 20, mcap: 1e9, adv20Usd: 4e5 }).reasons.some(r => /volume/.test(r)));
t('rules: $250M / $2 / $1M ADV', UNIVERSE.MIN_MCAP === 250e6 && UNIVERSE.MIN_PRICE === 2 && UNIVERSE.MIN_ADV_USD === 1e6);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
