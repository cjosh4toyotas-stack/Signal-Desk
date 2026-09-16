#!/usr/bin/env python3
"""Signal Desk — test updates for the universe gate. Run from the repo root."""
import sys, pathlib
HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path.cwd()
T = ROOT / 'signal-metrics-test.mjs'
src = T.read_text()
if 'classify13D:begin' in src:
    sys.exit('signal-metrics-test.mjs already patched')

def replace_once(s, old, new, label):
    n = s.count(old)
    assert n == 1, f'{label}: expected exactly 1 match, found {n}'
    return s.replace(old, new)

src = replace_once(src,
    "const fnHtml = slice(html, 'function classify13D', '// Parse the cover page');\n"
    "const fnWorker = slice(worker, 'function classify13D', 'function parse13DPercent');\n",
    "const fnHtml = slice(html, '// ── classify13D:begin', '// ── classify13D:end');\n"
    "const fnWorker = slice(worker, '// ── classify13D:begin', '// ── classify13D:end');\n",
    'parity slice')
src = replace_once(src,
    "const classify13D = new Function(fnWorker + '; return classify13D;')();\n",
    "const classify13D = new Function(fnWorker + '; return classify13D;')();\n"
    "const F = await import('./test/fixtures.mjs');\n",
    'fixtures import')
src = replace_once(src,
    "t('activist intent > open-market > plain > affiliate', SCHED13_KIND_MULT.activist > SCHED13_KIND_MULT.accumulation && SCHED13_KIND_MULT.accumulation > SCHED13_KIND_MULT.plain && SCHED13_KIND_MULT.plain > SCHED13_KIND_MULT.affiliate);\n",
    "t('activist intent > open-market > plain', SCHED13_KIND_MULT.activist > SCHED13_KIND_MULT.accumulation && SCHED13_KIND_MULT.accumulation > SCHED13_KIND_MULT.plain);\n"
    "t('issuance, consideration and affiliate are ZERO, not discounts', SCHED13_KIND_MULT.issuance === 0 && SCHED13_KIND_MULT.consideration === 0 && SCHED13_KIND_MULT.affiliate === 0);\n",
    'mult ordering')
src = replace_once(src,
    "t('financing 13Ds are demoted out of ★ Opportunities (tier→1)', /r\\.kind === 'financing' && r\\.tier >= 2\\) \\{ r\\.tierBefore = r\\.tier; r\\.tier = 1; \\}/.test(html));\n",
    "t('dead-kind 13Ds are demoted out of ★ Opportunities (tier→1)', /SCHED13_DEAD_KINDS\\.has\\(r\\.kind\\) && r\\.tier >= 2\\) \\{ r\\.tierBefore = r\\.tier; r\\.tier = 1; \\}/.test(html));\n",
    'demotion regex')
src = replace_once(src,
    "console.log(`\\n${pass} passed, ${fail} failed`);\n",
    """
// ── (4) The universe gate + the Rainmaker case (2026-09-16) ──
// A 13D on an OTC shell where the insider's own preferred dividends were
// paid in stock, plus "20,000 shares at $0.01" of open-market buying, was
// surfacing as OPEN-MARKET BUYING. Now: the READING says issuance/insider/
// token, and the GATE says not a public company you can trade.
const rakr = classify13D(F.rakr);
t('Rainmaker → issuance (dividends paid in stock, nobody bought)', rakr.kind === 'issuance');
t('Rainmaker: filer shares the issuer\\'s address (Item 1 vs Item 2)', rakr.sameAddress === true && rakr.affiliate === true);
t('Rainmaker: $0.01/share open-market buying is token, not accumulation', rakr.purchaseUsd === 200 && rakr.openMarket === false);
t('Rainmaker: sub-dollar price flagged', rakr.subDollar === true);
t('PIK dividend in shares → issuance', classify13D(F.pik).kind === 'issuance');
t('15,000 shares at $0.42 → not accumulation (token)', classify13D(F.tokenBuyer).kind !== 'accumulation');
t('$61.5M open-market buyer with Item 4 denial boilerplate → accumulation, not activist', classify13D(F.passiveBoiler).kind === 'accumulation');
t('$412M Elliott-style buyer still reads activist with real open-market dollars', classify13D(F.elliott).kind === 'activist' && classify13D(F.elliott).purchaseUsd > 1e6);
t('Expion still reads financing', classify13D(F.expion).kind === 'financing');
const deadSrc = slice(worker, 'const SCHED13_DEAD_KINDS', '// ── classify13D:end');
const SCHED13_DEAD_KINDS = new Function(deadSrc + '; return SCHED13_DEAD_KINDS;')();
t('dead kinds = financing, issuance, consideration, affiliate', ['financing', 'issuance', 'consideration', 'affiliate'].every(k => SCHED13_DEAD_KINDS.has(k)) && !SCHED13_DEAD_KINDS.has('accumulation'));
// Every board stream and Top Signals consult gateFor(); unknown is not a pass.
t('confluence: insider/13F stream is gated', /const g = gateFor\\(s\\.ticker\\);\\s*if \\(!g\\.pass\\)/.test(html));
t('confluence: 13D stream requires a real ticker, then the gate', /if \\(!isRealTicker\\(r\\.ticker\\)\\) \\{[^\\n]*continue; \\}\\s*const g13 = gateFor\\(r\\.ticker\\);\\s*if \\(!g13\\.pass\\)/.test(html));
t('confluence: 13D dead kinds are rejected before scoring', /if \\(SCHED13_DEAD_KINDS\\.has\\(r\\.kind\\)\\) \\{ reject\\(/.test(html));
t('confluence: proxy-fight stream is gated', /const gc = gateFor\\(ct\\);\\s*if \\(!gc\\.pass\\)/.test(html));
t('confluence: deal stream is gated', /const gd = gateFor\\(d\\.ticker\\);\\s*if \\(!gd\\.pass\\)/.test(html));
t('Top Signals rows are gated', /\\.filter\\(s => !isRealTicker\\(s\\.ticker\\) \\|\\| gateFor\\(s\\.ticker\\)\\.pass\\)/.test(html));
t('★ Opportunities requires sched13Eligible', /r\\.tier >= 2 && sched13Eligible\\(r\\)/.test(html));
t('gateFor: unknown verdict is NOT a pass', /return \\{ known: false, pass: false/.test(html));
t('microcap ×0.7 discount removed (the gate owns it now)', !/r\\.mcap < 50e6 && mult > 0\\) mult \\*= 0\\.7/.test(html));
t('Filtered tab exists and renders rejects', /id="tab-filtered"/.test(html) && /function renderFiltered\\(\\)/.test(html) && /if \\(name === 'filtered'\\) renderFiltered\\(\\);/.test(html));
t('worker: /universe route exposed', /url\\.pathname === '\\/universe'/.test(worker));
t('worker: alert scan gates before kind', /if \\(!gate \\|\\| !gate\\.pass\\) \\{ status\\.suppressedGate\\+\\+; continue; \\}[\\s\\S]{0,400}SCHED13_DEAD_KINDS\\.has\\(reading\\.kind\\)/.test(worker));
t('worker: history rows carry the gate verdict', /gate: gates\\[r\\.acc\\],/.test(worker));
t('classification cache key bumped (old verdicts recomputed)', /sd_sched13_class_v4/.test(html));

console.log(`\\n${pass} passed, ${fail} failed`);
""",
    'append gate tests')
T.write_text(src)
print('signal-metrics-test.mjs patched')
