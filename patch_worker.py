#!/usr/bin/env python3
"""Signal Desk — universe gate + unified 13D classifier (worker side).
Run from the repo root on a FRESH pull: python3 patch_worker.py
Idempotent: refuses to run twice."""
import re, sys, pathlib

HERE = pathlib.Path(__file__).resolve().parent   # the patch folder (classify13d.js etc. live here)
ROOT = pathlib.Path.cwd()                          # the repo root you run it from
W = ROOT / 'alpaca-proxy-worker.js'
src = W.read_text()
if 'classify13D:begin' in src:
    sys.exit('alpaca-proxy-worker.js already patched')

CLASSIFIER = (HERE / 'classify13d.js').read_text()
UNIVERSE = (HERE / 'worker-universe.js').read_text()

def replace_once(s, old, new, label):
    n = s.count(old)
    assert n == 1, f'{label}: expected exactly 1 match, found {n}'
    return s.replace(old, new)

# 1. Router: expose /universe (public-data route, before the Alpaca gate).
src = replace_once(src,
    "    if (url.pathname === '/board-data') return handleBoardData(env);\n",
    "    if (url.pathname === '/board-data') return handleBoardData(env);\n"
    "    if (url.pathname === '/universe') return handleUniverse(url, env);\n",
    'router')
src = replace_once(src,
    "/alerts-status, /board-data, and /stream are exposed",
    "/alerts-status, /board-data, /universe, and /stream are exposed",
    'router 404 text')

# 2. SEC cache TTLs for the two daily reference files.
src = replace_once(src,
    "  if (/\\/files\\/company_tickers\\.json/.test(url)) return 86400e3;\n",
    "  if (/\\/files\\/company_tickers(?:_exchange)?\\.json/.test(url)) return 86400e3;\n"
    "  if (/data\\.sec\\.gov\\/api\\/xbrl\\/frames\\//.test(url)) return 86400e3;\n",
    'sec cache ttl')

# 3. Replace the worker's classify13D with the shared block.
start = src.index('// ── WHAT KIND OF 13D — mirrors classify13D() in index.html')
end = src.index('function parse13DPercent(text)')
src = src[:start] + CLASSIFIER + '\n' + src[end:]

# 4. Universe gate section, inserted before the alert scan.
marker = '// ══════════════════════════════════════════════════════════════\n// ALERT SCAN — cron-driven 13D watcher'
assert src.count(marker) == 1, 'alert scan marker'
src = src.replace(marker, UNIVERSE + marker)

# 5. readSched13 stores the richer reading.
src = replace_once(src,
    "  const out = { kind: cls.kind, flags: cls.flags, pct: parse13DPercent(text), at: new Date().toISOString() };\n",
    "  const out = { kind: cls.kind, flags: cls.flags, pct: parse13DPercent(text), sameAddress: cls.sameAddress, purchaseUsd: cls.purchaseUsd, at: new Date().toISOString() };\n",
    'readSched13 out')

# 6. Alert scan: resolve tickers + gate, persist both, alert only through the gate.
src = replace_once(src,
    "  const status = { ran: new Date().toISOString(), scanned: 0, alerted: 0, suppressedFinancing: 0, errors: [] };\n",
    "  const status = { ran: new Date().toISOString(), scanned: 0, alerted: 0, suppressedFinancing: 0, suppressedKind: 0, suppressedGate: 0, errors: [] };\n",
    'status shape')

src = replace_once(src,
    """    // Persist everything this scan saw into the rolling 13D history — this
    // is what lets the frontend's ★ Opportunities view accumulate 24/7
    // instead of only knowing whatever the live feed shows at page load.
    try {
      await mergeSched13History(env, [...byAcc.values()].map(r => ({
        acc: r.acc, form: r.form, filed: r.filed, link: r.link,
        subject: r.subject, tickers: [], filers: r.filers,
        kind: readings[r.acc] ? readings[r.acc].kind : undefined,
        flags: readings[r.acc] ? readings[r.acc].flags : undefined,
        pct: readings[r.acc] ? readings[r.acc].pct : undefined,
      })));
    } catch (err) {
      status.errors.push('history merge failed: ' + err.message);
    }
""",
    """    // UNIVERSE GATE: resolve every tier-2+ subject to its SEC ticker and
    // run the listing / price / market-cap / liquidity check ONCE here, so
    // the verdict rides along in history and the dashboard never has to
    // guess. A subject with no NYSE/Nasdaq ticker fails by definition.
    const gates = {};
    try {
      const subjects = [...byAcc.values()].filter(r => r.tier >= 2 && r.subject).map(r => r.subject);
      if (subjects.length) {
        const uni = await resolveUniverse(env, [], [...new Set(subjects)]);
        for (const rec of byAcc.values()) {
          if (rec.tier < 2) continue;
          const t = uni.byName[rec.subject] || null;
          rec.ticker = t;
          const v = t ? uni.tickers[t] : null;
          gates[rec.acc] = v
            ? { pass: v.pass, reasons: v.reasons, ticker: t, price: v.price, mcap: v.mcap, exchange: v.exchange, adv20Usd: v.adv20Usd }
            : { pass: false, reasons: [t ? 'universe lookup incomplete' : 'no NYSE/Nasdaq ticker matches the subject name'], ticker: t };
        }
      }
    } catch (err) { status.errors.push('universe gate failed: ' + err.message); }

    // Persist everything this scan saw into the rolling 13D history — this
    // is what lets the frontend's ★ Opportunities view accumulate 24/7
    // instead of only knowing whatever the live feed shows at page load.
    try {
      await mergeSched13History(env, [...byAcc.values()].map(r => ({
        acc: r.acc, form: r.form, filed: r.filed, link: r.link,
        subject: r.subject, tickers: r.ticker ? [r.ticker] : [], filers: r.filers,
        kind: readings[r.acc] ? readings[r.acc].kind : undefined,
        flags: readings[r.acc] ? readings[r.acc].flags : undefined,
        pct: readings[r.acc] ? readings[r.acc].pct : undefined,
        gate: gates[r.acc],
      })));
    } catch (err) {
      status.errors.push('history merge failed: ' + err.message);
    }
""",
    'gate block')

src = replace_once(src,
    """      // The metric fix: a financing 13D is not an accumulation signal. It
      // is recorded (history carries kind='financing') but never pushed.
      if (reading.kind === 'financing') { status.suppressedFinancing++; continue; }
""",
    """      // The universe gate first: not NYSE/Nasdaq, under $2, under $250M,
      // or too thin to trade → recorded with reasons, never pushed. No
      // exception for roster activists — a real one doesn't file on a shell.
      const gate = gates[rec.acc];
      if (!gate || !gate.pass) { status.suppressedGate++; continue; }
      // Then the reading: a financing / issuance / consideration /
      // affiliate 13D is not an accumulation signal, whoever filed it.
      if (reading.kind === 'financing') { status.suppressedFinancing++; continue; }
      if (SCHED13_DEAD_KINDS.has(reading.kind)) { status.suppressedKind++; continue; }
""",
    'alert gate')

src = replace_once(src,
    "        const body = `${rec.form} — filed by ${rec.filers.join(', ') || 'unknown'}${activist ? ` (roster match: ${activist})` : ''}${reading.pct != null ? ` — ${reading.pct.toFixed(1)}% stake` : ''}${kindTag}\\n${rec.link}`;\n",
    "        const capTag = gate.mcap > 0 ? ` · ${gate.ticker} $${(gate.mcap / 1e9).toFixed(gate.mcap >= 10e9 ? 0 : 1)}B cap` : gate.ticker ? ` · ${gate.ticker}` : '';\n"
    "        const body = `${rec.form} — filed by ${rec.filers.join(', ') || 'unknown'}${activist ? ` (roster match: ${activist})` : ''}${reading.pct != null ? ` — ${reading.pct.toFixed(1)}% stake` : ''}${kindTag}${capTag}\\n${rec.link}`;\n",
    'alert body')

# 7. History merge keeps the newest gate verdict and ticker.
src = replace_once(src,
    "      if (rec.kind && !prev.kind) { prev.kind = rec.kind; prev.flags = rec.flags; prev.pct = rec.pct; }\n",
    "      if (rec.kind && !prev.kind) { prev.kind = rec.kind; prev.flags = rec.flags; prev.pct = rec.pct; }\n"
    "      if (rec.gate) prev.gate = rec.gate;\n",
    'history merge gate')

# 8. Export the pieces the tests exercise.
src = src.rstrip('\n') + "\n\nexport { classify13D, universeVerdict, resolveUniverse, UNIVERSE, SCHED13_DEAD_KINDS };\n"

W.write_text(src)
print('alpaca-proxy-worker.js patched')
