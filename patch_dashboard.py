#!/usr/bin/env python3
"""Signal Desk — universe gate + Filtered tab + unified 13D classifier (dashboard).
Run from the repo root on a FRESH pull: python3 patch_dashboard.py
Idempotent: refuses to run twice."""
import sys, pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path.cwd()
H = ROOT / 'index.html'
src = H.read_text()
if 'classify13D:begin' in src:
    sys.exit('index.html already patched')
CLASSIFIER = (HERE / 'classify13d.js').read_text()
CLIENT = (HERE / 'dashboard-universe.js').read_text()

def replace_once(s, old, new, label):
    n = s.count(old)
    assert n == 1, f'{label}: expected exactly 1 match, found {n}'
    return s.replace(old, new)

# ── 1. Tab bar + panel + switch ──────────────────────────────
src = replace_once(src,
    '    <button class="tab-btn" data-tab="watchlist" onclick="switchTab(\'watchlist\')">Watchlist</button>\n',
    '    <button class="tab-btn" data-tab="watchlist" onclick="switchTab(\'watchlist\')">Watchlist</button>\n'
    '    <button class="tab-btn" data-tab="filtered" onclick="switchTab(\'filtered\')" title="Everything the universe gate and the 13D reading kept OFF the board, with the reason — audit it here">Filtered</button>\n',
    'tab button')
src = replace_once(src,
    '  <!-- WATCHLIST -->\n  <div class="tab-panel" id="tab-watchlist">\n',
    '  <!-- FILTERED — what the gate kept off the board, and why -->\n'
    '  <div class="tab-panel" id="tab-filtered">\n'
    '    <div id="filtered-body"><div class="status-box">Nothing filtered yet — open this tab after the board has loaded.</div></div>\n'
    '  </div>\n\n'
    '  <!-- WATCHLIST -->\n  <div class="tab-panel" id="tab-watchlist">\n',
    'tab panel')
src = replace_once(src,
    "  if (name === 'history') renderHistory();\n}\n",
    "  if (name === 'history') renderHistory();\n  if (name === 'filtered') renderFiltered();\n}\n",
    'switchTab')

# ── 2. Board copy: say what the gate is ──────────────────────
src = replace_once(src,
    '      <div class="cc-sub">signals + live M&amp;A deals stacked by recency — <span id="cc-updated">loading…</span></div>\n',
    '      <div class="cc-sub">signals + live M&amp;A deals stacked by recency — <span id="cc-updated">loading…</span> · <span id="cc-gate-note" title="Universe gate: NYSE/Nasdaq listing, $2+ price, $250M+ market cap, $1M+/day traded. Anything else never scores — see the Filtered tab.">gate: NYSE/Nasdaq · $2+ · $250M+ · $1M/day+</span></div>\n',
    'cc-sub')

# ── 3. Shared classifier replaces the dashboard copy ─────────
start = src.index('const NEGATED_SENTENCE = ')
end = src.index('// Parse the cover page: percent of class')
src = src[:start] + CLASSIFIER + '\n' + src[end:]
# The old header comment above the block still lists kinds — refresh it.
src = replace_once(src,
    "const SCHED13_CLASS_KEY = 'sd_sched13_class_v3';\n",
    "const SCHED13_CLASS_KEY = 'sd_sched13_class_v4'; // v4: issuance kind, same-address insider, token-buying test\n",
    'class key')
src = replace_once(src,
    "const SCHED13_KIND_MULT = { financing: 0, consideration: 0.2, deal: 0.8, activist: 1.5, accumulation: 1.25, affiliate: 0.5, plain: 1, unknown: 1 };\n",
    "// Dead kinds are 0 — not discounted, ZERO. A founder's amendment, a\n"
    "// dividend paid in stock, a PIPE: none of them can earn a card by\n"
    "// stacking multipliers any more.\n"
    "const SCHED13_KIND_MULT = { financing: 0, issuance: 0, consideration: 0, deal: 0.8, activist: 1.5, accumulation: 1.25, affiliate: 0, plain: 1, unknown: 1 };\n",
    'kind mult')
src = replace_once(src,
    "  financing: '⚠ FINANCING / DILUTION', consideration: '🧾 DEAL CONSIDERATION', deal: '🤝 DEAL-LINKED', activist: '★ ACTIVIST INTENT',\n",
    "  financing: '⚠ FINANCING / DILUTION', issuance: '🖨 ISSUED, NOT BOUGHT', consideration: '🧾 DEAL CONSIDERATION', deal: '🤝 DEAL-LINKED', activist: '★ ACTIVIST INTENT',\n",
    'kind label')

# ── 4. Tier demotion + quality use the dead-kind set ─────────
src = replace_once(src,
    "  if ((r.kind === 'financing' || r.kind === 'consideration') && r.tier >= 2) { r.tierBefore = r.tier; r.tier = 1; }\n",
    "  if (SCHED13_DEAD_KINDS.has(r.kind) && r.tier >= 2) { r.tierBefore = r.tier; r.tier = 1; }\n",
    'tier demotion')
src = replace_once(src,
    "  if (r.mcap > 0 && r.mcap < 50e6 && mult > 0) mult *= 0.7; // sub-$50M names: thin float, hard to trade\n",
    "  // (the sub-$50M discount is gone — the universe gate holds those out entirely)\n",
    'microcap discount')
src = replace_once(src,
    "  const base = kind === 'financing' ? 'financing, not accumulation'\n",
    "  const base = kind === 'financing' ? 'financing, not accumulation'\n"
    "    : kind === 'issuance' ? 'shares issued to settle an obligation, not bought'\n",
    'quality note')
src = replace_once(src,
    "  const color = kind === 'financing' ? 'var(--rose)' : (kind === 'activist' || kind === 'accumulation') ? 'var(--teal)' : kind === 'unknown' ? 'var(--text-muted)' : 'var(--text-dim)';\n",
    "  const color = (kind === 'financing' || kind === 'issuance') ? 'var(--rose)' : (kind === 'activist' || kind === 'accumulation') ? 'var(--teal)' : kind === 'unknown' ? 'var(--text-muted)' : 'var(--text-dim)';\n",
    'kind color')
# The Read cell also states the gate verdict.
src = replace_once(src,
    "  return `<span class=\"badge-pill\" style=\"color:${color};border:1px solid var(--border);background:transparent\" title=\"${escHtml(title)}\">${SCHED13_KIND_LABEL[kind] || kind}</span>${micro}`;\n}\n",
    "  const g = sched13Gate(r);\n"
    "  const gateHtml = g.known && !g.pass\n"
    "    ? ` <span class=\"badge-pill\" style=\"background:var(--rose-dim,rgba(255,80,110,0.12));color:var(--rose)\" title=\"${escHtml(g.reasons.join(' · '))}\">⛔ ${escHtml(g.reasons[0] || 'filtered')}</span>`\n"
    "    : g.known && g.v && g.v.mcap > 0 ? ` <span class=\"badge-pill\" style=\"color:var(--text-muted);border:1px solid var(--border);background:transparent\" title=\"${escHtml(universeLabel(g.v))}\">${escHtml(g.v.exchange || '')} · ${fmtCap(g.v.mcap)}</span>` : '';\n"
    "  return `<span class=\"badge-pill\" style=\"color:${color};border:1px solid var(--border);background:transparent\" title=\"${escHtml(title)}\">${SCHED13_KIND_LABEL[kind] || kind}</span>${micro}${gateHtml}`;\n}\n",
    'kind html gate')

# ── 5. Universe client module, ahead of computeConfluence ────
marker = 'function computeConfluence() {\n'
assert src.count(marker) == 1
src = src.replace(marker, CLIENT + '\n' + marker)

# ── 6. Confluence board: gate every stream ───────────────────
src = replace_once(src,
    """  for (const s of combinedSignals()) {
    if (!(s.valueUsd > 0) || s.direction === 'sell') continue;
    const key = isRealTicker(s.ticker) ? 'T:' + s.ticker : null;
    if (!key) continue;
""",
    """  ccRejects = {};
  const reject = (label, ticker, source, reasons, detail, link, time) => {
    const k = ticker || 'N:' + normName(label);
    const e = ccRejects[k] = ccRejects[k] || { label, ticker: ticker || null, sources: new Set(), reasons: new Set(), details: [], links: [], latest: null };
    e.sources.add(source);
    (reasons || []).forEach(x => e.reasons.add(x));
    if (detail && e.details.length < 3 && !e.details.includes(detail)) e.details.push(detail);
    if (link && e.links.length < 3 && !e.links.includes(link)) e.links.push(link);
    if (time && (!e.latest || new Date(time) > new Date(e.latest))) e.latest = time;
  };
  for (const s of combinedSignals()) {
    if (!(s.valueUsd > 0) || s.direction === 'sell') continue;
    const key = isRealTicker(s.ticker) ? 'T:' + s.ticker : null;
    if (!key) continue;
    // UNIVERSE GATE — one gate for every stream. Unknown is not a pass.
    const g = gateFor(s.ticker);
    if (!g.pass) { if (g.known) reject(s.ticker, s.ticker, s.source, g.reasons, s.detail, s.link, s.time); continue; }
""",
    'stream 1+2 gate')
src = replace_once(src,
    """  for (const r of sched13Filings) {
    if (r.tier < 2) continue;
    // WHAT KIND of 13D: the filing text is read (sched13Quality) before a
""",
    """  for (const r of sched13Filings) {
    if (r.tier < 2 && !(r.tierBefore >= 2)) continue;
    const lbl = isRealTicker(r.ticker) ? r.ticker : r.subject;
    const s13detail = `${r.form === 'SCHEDULE 13D' ? 'New 13D' : '13D amendment'} by ${r.filers.slice(0, 2).join(', ')}`;
    // UNIVERSE GATE — a 13D with no NYSE/Nasdaq ticker behind it is not a
    // company you can trade; one that fails price / cap / liquidity is
    // recorded on the Filtered tab and never scores.
    if (!isRealTicker(r.ticker)) { if (r.tickerLookedUp) reject(lbl, null, 'sched13', ['no NYSE/Nasdaq ticker matches the subject'], s13detail, r.link, r.filed); continue; }
    const g13 = gateFor(r.ticker);
    if (!g13.pass) { if (g13.known) reject(lbl, r.ticker, 'sched13', g13.reasons, s13detail, r.link, r.filed); continue; }
    if (SCHED13_DEAD_KINDS.has(r.kind)) { reject(lbl, r.ticker, 'sched13', [SCHED13_KIND_LABEL[r.kind] + ' — ' + (r.flags || []).slice(0, 3).join(' · ')], s13detail, r.link, r.filed); continue; }
    if (r.tier < 2) continue;
    // WHAT KIND of 13D: the filing text is read (sched13Quality) before a
""",
    'stream 3 gate')
src = replace_once(src,
    """  for (const c of Object.values(campaignStore)) {
    if (campaignStage(c) !== 'proxy-fight' || !c.events.length) continue;
    const key = 'N:' + normName(c.company);
""",
    """  for (const c of Object.values(campaignStore)) {
    if (campaignStage(c) !== 'proxy-fight' || !c.events.length) continue;
    const ct = universeTickerForName(c.company); // undefined = not looked up yet, null = no listed ticker
    if (!ct) { if (ct === null) reject(c.company, null, 'campaign', ['no NYSE/Nasdaq ticker matches the subject'], 'Proxy fight', null, c.events[0].date); continue; }
    const gc = gateFor(ct);
    if (!gc.pass) { if (gc.known) reject(c.company, ct, 'campaign', gc.reasons, 'Proxy fight', null, c.events[0].date); continue; }
    const key = 'T:' + ct;
""",
    'stream 4 gate')
src = replace_once(src,
    "      'Contested proxy fight underway — see Campaigns tab for the timeline', null, null, c.events[0].date);\n",
    "      'Contested proxy fight underway — see Campaigns tab for the timeline', null, ct, c.events[0].date);\n",
    'stream 4 ticker')
src = replace_once(src,
    """    if (!isRealTicker(d.ticker)) continue;
    const key = 'T:' + d.ticker;
    const isRumor = d.status === 'rumored';
""",
    """    if (!isRealTicker(d.ticker)) continue;
    const gd = gateFor(d.ticker);
    if (!gd.pass) { if (gd.known) reject(d.ticker, d.ticker, 'deal', gd.reasons, `${d.acquirer} deal`, d.source_url, d.updated_at || d.ann_date); continue; }
    const key = 'T:' + d.ticker;
    const isRumor = d.status === 'rumored';
""",
    'stream 5 gate')
# Kick the universe lookups off with the board's whole candidate set.
src = replace_once(src,
    "function renderCommandCenter() {\n  const grid = document.getElementById('cc-grid');\n  if (!grid) return;\n  const entries = computeConfluence();\n",
    "function renderCommandCenter() {\n  const grid = document.getElementById('cc-grid');\n  if (!grid) return;\n  ensureUniverseForBoard();\n  const entries = computeConfluence();\n",
    'renderCommandCenter hook')
src = replace_once(src,
    "    if (boardLastFetch) grid.innerHTML = '<div class=\"cc-empty\">Quiet tape right now — no name has a fresh stacked signal or near-term deal catalyst (signals older than 3 weeks age off this board; see History and the M&amp;A Deals tab for the long tail).</div>';\n",
    "    if (boardLastFetch) grid.innerHTML = `<div class=\"cc-empty\">${universeOffline ? 'Universe gate offline — the Worker\\'s /universe route isn\\'t deployed yet (run npx wrangler deploy); showing nothing rather than unverified names. ' : ''}Quiet tape right now — no name that passes the universe gate has a fresh stacked signal or near-term deal catalyst (signals older than 3 weeks age off this board; the Filtered tab shows what was held out and why).</div>`;\n",
    'empty board copy')

# ── 7. Top Signals: gate + reject log ────────────────────────
src = replace_once(src,
    """    .map(s => ({ ...s, ageDays: signalAgeDays(s) }))
    .filter(s => s.ageDays <= (s.source === 'institution' ? SIGNAL_13F_MAX_AGE_DAYS : SIGNAL_MAX_AGE_DAYS))
""",
    """    .map(s => ({ ...s, ageDays: signalAgeDays(s) }))
    .filter(s => s.ageDays <= (s.source === 'institution' ? SIGNAL_13F_MAX_AGE_DAYS : SIGNAL_MAX_AGE_DAYS))
    // UNIVERSE GATE: a Top Signal on a name that isn't NYSE/Nasdaq, $2+,
    // $250M+ and liquid is not a top signal. (Board rejects are logged in
    // computeConfluence, which runs right after this.)
    .filter(s => !isRealTicker(s.ticker) || gateFor(s.ticker).pass)
""",
    'top signals gate')
src = replace_once(src,
    "      Conviction events, ranked by <strong>materiality</strong> — each trade's size",
    "      <strong>Universe gate:</strong> only NYSE/Nasdaq names at $2+, $250M+ market cap and $1M+/day traded can appear here or on the board; everything else is on the Filtered tab with its reason. Conviction events, ranked by <strong>materiality</strong> — each trade's size",
    'top signals copy')

# ── 8. 13D Watch: ★ Opportunities honors the gate; history seeds it ──
src = replace_once(src,
    "    ? [...sched13Filings].filter(r => r.tier >= 2).sort((a, b) => new Date(b.filed) - new Date(a.filed))\n",
    "    ? [...sched13Filings].filter(r => r.tier >= 2 && sched13Eligible(r)).sort((a, b) => new Date(b.filed) - new Date(a.filed))\n",
    'opp filter')
src = replace_once(src,
    "      Rows highlighted in green are the likeliest opportunities: a new 13D, or any 13D activity from a <strong>★ known activist</strong> — most other raw 13D filings are founders and family holders, not campaigns. \"★ Opportunities\" shows only those.",
    "      Rows highlighted in green are the likeliest opportunities: a new 13D, or any 13D activity from a <strong>★ known activist</strong>, on a company that passes the <strong>universe gate</strong> (NYSE/Nasdaq, $2+, $250M+ market cap, $1M+/day traded) — most other raw 13D filings are founders, family holders and shells, not campaigns. \"★ Opportunities\" shows only those; a ⛔ pill in the Read column says why a row was held out.",
    '13d copy')
src = replace_once(src,
    "          <tr${r.tier >= 2 ? ' style=\"background:rgba(57,255,143,0.05)\"' : r.kind === 'financing' ? ' style=\"background:rgba(255,80,110,0.05)\"' : ''}>\n",
    "          <tr${r.tier >= 2 && sched13Eligible(r) ? ' style=\"background:rgba(57,255,143,0.05)\"' : (SCHED13_DEAD_KINDS.has(r.kind) || (sched13Gate(r).known && !sched13Gate(r).pass)) ? ' style=\"background:rgba(255,80,110,0.05)\"' : ''}>\n",
    '13d row color')
src = replace_once(src,
    """              byAcc.set(h.acc, {
                acc: h.acc, form: (h.form || '').toUpperCase(), filed: h.filed,
                link: h.link, subject: h.subject || '', filers: h.filers || [],
                ticker: (h.tickers && h.tickers[0]) || null, fromHistory: true,
                workerKind: h.kind || null, workerFlags: h.flags || null, workerPct: h.pct != null ? h.pct : null
              });
            } else {
              if (h.tickers && h.tickers.length && !existing.ticker) existing.ticker = h.tickers[0]; // efts records know the subject's ticker; the atom feed doesn't
              if (h.kind && !existing.workerKind) { existing.workerKind = h.kind; existing.workerFlags = h.flags || null; existing.workerPct = h.pct != null ? h.pct : null; }
            }
""",
    """              byAcc.set(h.acc, {
                acc: h.acc, form: (h.form || '').toUpperCase(), filed: h.filed,
                link: h.link, subject: h.subject || '', filers: h.filers || [],
                ticker: (h.tickers && h.tickers[0]) || null, fromHistory: true, tickerLookedUp: !!h.gate,
                workerKind: h.kind || null, workerFlags: h.flags || null, workerPct: h.pct != null ? h.pct : null
              });
            } else {
              if (h.tickers && h.tickers.length && !existing.ticker) existing.ticker = h.tickers[0]; // efts records know the subject's ticker; the atom feed doesn't
              if (h.gate) existing.tickerLookedUp = true;
              if (h.kind && !existing.workerKind) { existing.workerKind = h.kind; existing.workerFlags = h.flags || null; existing.workerPct = h.pct != null ? h.pct : null; }
            }
            // The Worker already ran the universe gate for this subject —
            // seed the local verdict cache so the row never has to wait.
            if (h.gate) universeSeed(h.gate, h.subject);
""",
    'history seed')

# ── 9. A failed EDGAR read must not erase the Worker's classification ──
src = replace_once(src,
    "    a = { pct: null, kind: 'unknown', flags: [], at: Date.now(), failed: true };\n",
    "    // Keep whatever the Worker's history already told us (kind/flags/pct)\n"
    "    // rather than downgrading a known reading to 'unknown' on a bad fetch.\n"
    "    a = { pct: r.pct != null ? r.pct : null, kind: r.kind || 'unknown', flags: r.flags || [], affiliate: r.affiliate, at: Date.now(), failed: true };\n",
    'failed read keeps worker kind')

# ── 10. Keep the old parity-test slice markers valid ─────────
assert '// Parse the cover page' in src and 'function classify13D' in src

H.write_text(src)
print('index.html patched')
