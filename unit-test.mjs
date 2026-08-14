// ══ Unit tests: (1) debt rescue path, (2) filed-first shares, (3) tape seeding ══
import { readFileSync } from 'fs';
let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : (fail++, console.log('FAIL:', name)); console.log((cond?'  ok ':'  FAIL '), name); };

// ── Load fundamentals.js in a fake browser env ──
global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {} };
global.ALPACA_PROXY_URL = 'https://fake.workers.dev';

// Fixtures modeled on LEU's actual filing shape:
// - No LongTermDebtNoncurrent/Current/LongTermDebt (404s)
// - Converts under ConvertibleDebtNoncurrent ($775M), senior notes under SeniorLongTermNotes ($402.5M)
// - InterestExpense annual $38M  → coverage check must fire
// - dei shares: stale fact with LATER end date from an OLD filing (13.7M, end 2026-09-30 typo'd in an amended old accession)
//   vs correct fact 16.6M + 1.2M two classes in the newest accession (end 2026-07-31)
const FIXTURES = {
  'us-gaap/OperatingIncomeLoss': { units: { USD: [
    { start:'2025-07-01', end:'2026-06-30', val: 7.4e6, form:'10-Q', filed:'2026-08-05', fp:'Q2' },
    { start:'2025-01-01', end:'2025-12-31', val: 12e6, form:'10-K', filed:'2026-02-10', fy:2025, fp:'FY' },
  ]}},
  'us-gaap/DepreciationDepletionAndAmortization': { units: { USD: [
    { start:'2025-01-01', end:'2025-12-31', val: 9.6e6, form:'10-K', filed:'2026-02-10', fy:2025, fp:'FY' },
  ]}},
  'us-gaap/Revenues': { units: { USD: [
    { start:'2025-01-01', end:'2025-12-31', val: 442e6, form:'10-K', filed:'2026-02-10', fy:2025, fp:'FY' },
  ]}},
  'us-gaap/CashAndCashEquivalentsAtCarryingValue': { units: { USD: [
    { end:'2026-06-30', val: 1871e6, form:'10-Q', filed:'2026-08-05' },
  ]}},
  'us-gaap/InterestExpense': { units: { USD: [
    { start:'2025-01-01', end:'2025-12-31', val: 38e6, form:'10-K', filed:'2026-02-10', fy:2025, fp:'FY' },
  ]}},
  'us-gaap/ConvertibleDebtNoncurrent': { units: { USD: [
    { end:'2026-06-30', val: 775e6, form:'10-Q', filed:'2026-08-05' },
  ]}},
  'us-gaap/SeniorLongTermNotes': { units: { USD: [
    { end:'2026-06-30', val: 402.5e6, form:'10-Q', filed:'2026-08-05' },
  ]}},
  'dei/EntityCommonStockSharesOutstanding': { units: { shares: [
    // stale fact from an OLD accession but with the latest 'end' date (the trap)
    { end:'2026-09-30', val: 13.7e6, accn:'0001-23-000001', filed:'2023-11-01', fy:2023, fp:'Q3' },
    // correct multi-class facts in the NEWEST filing
    { end:'2026-07-31', val: 16.6e6, accn:'0001-26-000099', filed:'2026-08-05', fy:2026, fp:'Q2' },
    { end:'2026-07-31', val: 1.2e6,  accn:'0001-26-000099', filed:'2026-08-05', fy:2026, fp:'Q2' },
  ]}},
};

global.fetch = async (url) => {
  const m = /url=(.+?)(&|$)/.exec(url);
  const target = m ? decodeURIComponent(m[1]) : url;
  if (String(url).includes('company_tickers') || target.includes('company_tickers')) {
    return { ok: true, json: async () => ({ '0': { cik_str: 1065059, ticker: 'LEU' } }) };
  }
  const key = Object.keys(FIXTURES).find(k => target.includes(k));
  if (key) return { ok: true, json: async () => FIXTURES[key] };
  return { ok: false, status: 404, json: async () => ({}) };
};

// Evaluate the module
const src = readFileSync('fundamentals.js', 'utf8');
eval(src);
const SDF = global.window.SDFundamentals;

const facts = await SDF.getFacts('LEU');
t('debt rescued from note tags: $1,177.5M', facts.debt === 775e6 + 402.5e6);
t('debtApprox flagged (rescue path used)', facts.debtApprox === true);
t('debtSuspect cleared after rescue (coverage now sane)', facts.debtSuspect === false);
t('shares filed-first: 17.8M (not stale 13.7M)', Math.abs(facts.shares - 17.8e6) < 1);
t('sharesAsOf from newest filing: 2026-07-31', facts.sharesAsOf === '2026-07-31');
t('cash correct: $1,871M', facts.cash === 1871e6);
t('warnings array present with debt note', Array.isArray(facts.warnings) && facts.warnings.some(w => /note tags|approximate/i.test(w)));

const m2 = SDF.deriveMetrics(facts, 177);
t('market cap = 177 × 17.8M ≈ $3.15B', Math.abs(m2.marketCap - 177*17.8e6) < 1);
t('EV includes rescued debt', m2.ev != null && Math.abs(m2.ev - (177*17.8e6 + 1177.5e6 - 1871e6)) < 1);
t('evApprox propagates from debtApprox', m2.evApprox === true);

// ── Tape seeding logic (extracted from index.html) ──
const html = readFileSync('index.html', 'utf8');
const fnMatch = html.match(/function etDateStr\(\)[\s\S]*?function seedQuoteFromBars[\s\S]*?\n\}/);
t('seeding helpers exist in index.html', !!fnMatch);
const liveQuotes = {};
const mk = new Function('liveQuotes', fnMatch[0] + '\nreturn { etDateStr, seedQuoteFromBars };');
const { etDateStr, seedQuoteFromBars } = mk(liveQuotes);

const todayET = etDateStr();
const yest = '2026-08-13', dayBefore = '2026-08-12';

// Case 1: market hours — today's bar is the newest
seedQuoteFromBars('AAA', [
  { t: dayBefore + 'T04:00:00Z', c: 100 },
  { t: yest + 'T04:00:00Z', c: 110 },
  { t: todayET + 'T04:00:00Z', c: 113 },
]);
t('intraday: base = yesterday close (110), not today (113)', liveQuotes['AAA'].prevClose === 110);
t('intraday: seeded last = today latest (113) → +2.73% immediately', liveQuotes['AAA'].last === 113);

// Case 2: market closed — newest bar is a past session
seedQuoteFromBars('BBB', [
  { t: dayBefore + 'T04:00:00Z', c: 50 },
  { t: yest + 'T04:00:00Z', c: 55 },
]);
t('closed: shows last session real move (55 vs 50 = +10%)', liveQuotes['BBB'].prevClose === 50 && liveQuotes['BBB'].last === 55);

// Case 3: old behavior would have been prevClose === last (0.00%) — confirm gone
t('no symbol seeded with prevClose === last (the 0.00%% bug)',
  Object.values(liveQuotes).every(q => q.prevClose !== q.last));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
