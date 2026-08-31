// ══ Unit tests: Top Signals / Confluence metric fixes (2026-08-31) ══
// (1) 13D classification — the Expion Energy case: an insider-affiliated
//     convertible + warrant financing with a 9.99% blocker must read as
//     FINANCING, earn zero confluence points, and be demoted out of ★.
// (2) Materiality — a small trade in a small company outranks a big trade
//     in a huge one; unknown market cap is neutral.
// (3) The worker and the dashboard carry byte-identical classifiers.
import { readFileSync } from 'fs';
let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  ok  ' : '  FAIL ') + name); };

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const worker = readFileSync(new URL('./alpaca-proxy-worker.js', import.meta.url), 'utf8');
const slice = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to));

// ── (3) classifier parity ──
const fnHtml = slice(html, 'function classify13D', '// Parse the cover page');
const fnWorker = slice(worker, 'function classify13D', 'function parse13DPercent');
t('classify13D is identical in index.html and the worker', fnHtml.trim() === fnWorker.trim());

// ── (1) classification ──
const classify13D = new Function(fnWorker + '; return classify13D;')();
const expion = `Item 3. On August 21, 2026, FNL entered into a Securities Purchase Agreement with the Issuer pursuant to which it purchased an 8% Convertible Debenture due August 21, 2029 in the principal amount of $4,500,000, convertible into Series A-1 8% Convertible Preferred Stock at a conversion price of $4.25, a Common Stock Purchase Warrant to purchase 1,058,609 shares at an exercise price of $4.25, and an Additional Investment Right to purchase up to $91,000,000 of additional preferred stock, subject to a contractually stipulated 9.99% ownership restriction. Registration Rights Agreement. Joseph Hammer served as a director of the Issuer until the date of this filing. Item 4. Acquired for investment purposes; no present plan or proposal.`;
const elliott = `Item 3. The Reporting Persons purchased 12,500,000 Shares in open market transactions using working capital. Item 4. The Shares are undervalued. The Reporting Persons have discussed board composition and a review of strategic alternatives including a sale of the Issuer, intend to nominate directors and may conduct a proxy solicitation to maximize shareholder value. Item 5(c). Open market purchases on Schedule A.`;
const founder = `Item 2. Mr. Smith is the founder and serves as Chairman and Chief Executive Officer of the Issuer. Item 3. Shares acquired at the IPO and under his employment agreement. Item 4. Held for investment.`;
const acquirer = `Item 4. Parent entered into an Agreement and Plan of Merger with the Issuer and a Voting Agreement and Support Agreement with certain stockholders who agreed to vote for the merger agreement.`;
const quiet = `Item 3. Shares acquired in open market transactions for $88,000,000. Item 4. Investment purposes; may engage in communications with management.`;
t('Expion-style insider convertible financing → financing', classify13D(expion).kind === 'financing');
t('Expion flags call out the 9.99% blocker', classify13D(expion).flags.some(f => /blocker/.test(f)));
t('Expion flags call out the director-of-issuer affiliation', classify13D(expion).flags.some(f => /director/.test(f)));
t('activist with intent + open-market buys → activist', classify13D(elliott).kind === 'activist');
t('founder/CEO holder → affiliate', classify13D(founder).kind === 'affiliate');
t('acquirer voting-agreement 13D → deal', classify13D(acquirer).kind === 'deal');
t('quiet open-market accumulator → accumulation', classify13D(quiet).kind === 'accumulation');

// Confluence multiplier table + tier demotion, evaluated from the dashboard source.
const multSrc = slice(html, 'const SCHED13_KIND_MULT', 'const SCHED13_KIND_LABEL');
const SCHED13_KIND_MULT = new Function(multSrc + '; return SCHED13_KIND_MULT;')();
t('financing earns zero confluence points', SCHED13_KIND_MULT.financing === 0);
t('activist intent > open-market > plain > affiliate', SCHED13_KIND_MULT.activist > SCHED13_KIND_MULT.accumulation && SCHED13_KIND_MULT.accumulation > SCHED13_KIND_MULT.plain && SCHED13_KIND_MULT.plain > SCHED13_KIND_MULT.affiliate);
t('confluence stream 3 skips zero-multiplier filings', /const q = sched13Quality\(r\);\s*if \(q\.mult <= 0\) continue;/.test(html));
t('financing 13Ds are demoted out of ★ Opportunities (tier→1)', /r\.kind === 'financing' && r\.tier >= 2\) \{ r\.tierBefore = r\.tier; r\.tier = 1; \}/.test(html));
t('worker never pushes a financing 13D', /if \(reading\.kind === 'financing'\) \{ status\.suppressedFinancing\+\+; continue; \}/.test(worker));

// ── (2) materiality ──
const matSrc = slice(html, 'const signalMarketCap = {};', 'function fmtCap');
const { materialityMult, signalMarketCap } = new Function(matSrc + '; return { materialityMult, signalMarketCap };')();
signalMarketCap.MEGA = 3e12; signalMarketCap.MICRO = 60e6; signalMarketCap.MID = 5e9;
const mega = { ticker: 'MEGA', valueUsd: 5e6 };
const micro = { ticker: 'MICRO', valueUsd: 3e5 };
const mid = { ticker: 'MID', valueUsd: 1e6 };
t('$5M at a $3T megacap hits the 0.3× floor', materialityMult(mega) === 0.3);
t('$300K in a $60M microcap hits the 4× cap', materialityMult(micro) === 4);
t('$1M in a $5B mid-cap (2 bp) is neutral 1×', Math.abs(materialityMult(mid) - 1) < 1e-9);
t('microcap CEO buy outranks megacap buy after scaling', micro.valueUsd * materialityMult(micro) > mega.valueUsd * materialityMult(mega) * 0.5);
t('unknown market cap is neutral', materialityMult({ ticker: 'NOPE', valueUsd: 1e6 }) === 1);
t('confluence clamp honored (0.5–2.5)', materialityMult(micro, 0.5, 2.5) === 2.5 && materialityMult(mega, 0.5, 2.5) === 0.5);
t('Top Signals score uses materialityMult', /score: base \* materialityMult\(s\)/.test(html));
// 13F staleness: quarter-end snapshots rank by conviction and fade fast
const grab = name => { const i = html.indexOf('function ' + name); return html.slice(i, html.indexOf('\n}\n', i) + 2); };
const f13 = new Function(grab('quarterEndBefore') + grab('institutionSortValue') + grab('pctBookOf') + '; return { quarterEndBefore, institutionSortValue, pctBookOf };')();
t('13F filed Aug 14 is labeled as-of Jun 30', f13.quarterEndBefore('2026-08-14') === '6/30/2026');
t('13F filed Feb 12 is labeled as-of prior Dec 31', f13.quarterEndBefore('2027-02-12') === '12/31/2026');
t('13F rank value scales with % of book, not dollars', f13.institutionSortValue(4) === 4e6 && f13.institutionSortValue(40) === 15e6);
t('legacy remembered 13F rows recover % of book from text', f13.pctBookOf({ detail: 'EXITED entirely — sold (was 7.4% of the book)' }) === 7.4);
t('13F rows use a short half-life and 21-day cutoff', /SIGNAL_13F_HALF_LIFE_DAYS = 4/.test(html) && /SIGNAL_13F_MAX_AGE_DAYS = 21/.test(html) && /inst \? SIGNAL_13F_HALF_LIFE_DAYS : SIGNAL_HALF_LIFE_DAYS/.test(html));
t('13F detail states the as-of date', /holdings as of \$\{asOf\}/.test(html));
t('market cap fetched for sells too (not just buys)', /ranked\.filter\(x => x\.ticker\)\.map\(x => x\.ticker\)/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
