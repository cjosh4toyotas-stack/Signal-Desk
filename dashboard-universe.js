// ══════════════════════════════════════════════════════════════
// UNIVERSE GATE (client) — one hard gate for every stream
// ══════════════════════════════════════════════════════════════
// The Worker's /universe route answers, per ticker: NYSE/Nasdaq listing
// (from SEC's own file), last close, market cap (SEC XBRL shares × close)
// and 20-day average dollar volume, plus a pass/fail verdict with reasons.
// The dashboard asks once per ticker (6-hour local cache), and NOTHING
// scores until the answer is back — unknown is not a pass. Names that fail
// are collected in ccRejects and shown on the Filtered tab with the
// reason, so the gate can be audited instead of trusted.
const UNIVERSE_LS_KEY = 'sd_universe_v1';
const UNIVERSE_TTL = 6 * 3600 * 1000;
const universeCache = sdMemGet(UNIVERSE_LS_KEY, {}) || {};   // ticker -> { v, at }
const universeNames = {};                                    // normName(subject) -> ticker | null
const universePending = new Set();
let universeOffline = false;
let universeRules = null;
let ccRejects = {};

function universeSave() {
  const keys = Object.keys(universeCache);
  if (keys.length > 400) keys.sort((a, b) => universeCache[a].at - universeCache[b].at).slice(0, keys.length - 400).forEach(k => delete universeCache[k]);
  sdMemSet(UNIVERSE_LS_KEY, universeCache);
}

// { known, pass, reasons, v }. Offline gate (old Worker) passes everything
// and says so on the board rather than silently going dark.
function gateFor(ticker) {
  const t = String(ticker || '').toUpperCase();
  if (!isRealTicker(t)) return { known: true, pass: false, reasons: ['no listed ticker'], v: null };
  const hit = universeCache[t];
  if (hit && Date.now() - hit.at < UNIVERSE_TTL) return { known: true, pass: !!hit.v.pass, reasons: hit.v.reasons || [], v: hit.v };
  if (universeOffline) return { known: true, pass: true, reasons: ['universe gate offline — unverified'], v: null };
  return { known: false, pass: false, reasons: ['verifying…'], v: null };
}
function universeLabel(v) {
  if (!v) return '';
  const px = v.price != null ? '$' + (v.price < 1 ? v.price.toFixed(4) : v.price.toFixed(2)) : '—';
  const adv = v.adv20Usd != null ? (v.adv20Usd >= 1e6 ? '$' + (v.adv20Usd / 1e6).toFixed(1) + 'M/day' : '$' + (v.adv20Usd / 1e3).toFixed(0) + 'K/day') : '—';
  return `${v.exchange || 'unlisted'} · ${px} · ${v.mcap > 0 ? fmtCap(v.mcap) + ' cap' : 'cap unknown'} · ${adv}`;
}
// Worker history rows carry the verdict the cron already computed.
function universeSeed(gate, subject) {
  if (!gate) return;
  if (subject) universeNames[normName(subject)] = gate.ticker || null;
  if (!gate.ticker || !isRealTicker(gate.ticker)) return;
  const t = gate.ticker.toUpperCase();
  const hit = universeCache[t];
  if (hit && Date.now() - hit.at < UNIVERSE_TTL) return;
  universeCache[t] = { at: Date.now(), v: { ticker: t, pass: !!gate.pass, reasons: gate.reasons || [], price: gate.price ?? null, mcap: gate.mcap ?? null, exchange: gate.exchange || null, adv20Usd: gate.adv20Usd ?? null } };
}
// undefined = not looked up yet; null = looked up, no NYSE/Nasdaq ticker.
function universeTickerForName(name) {
  const k = normName(name);
  return k in universeNames ? universeNames[k] : undefined;
}
function sched13Gate(r) {
  if (!isRealTicker(r.ticker)) return { known: !!r.tickerLookedUp, pass: false, reasons: ['no NYSE/Nasdaq ticker matches the subject'], v: null };
  return gateFor(r.ticker);
}
function sched13Eligible(r) {
  return sched13Gate(r).pass && !SCHED13_DEAD_KINDS.has(r.kind);
}

// Ask the Worker about everything the board might score, in batches.
let universeFetching = false;
async function ensureUniverseForBoard() {
  if (!ALPACA_PROXY_URL || universeOffline || universeFetching) return;
  const tickers = new Set();
  const names = new Set();
  const need = t => { const u = String(t || '').toUpperCase(); if (isRealTicker(u) && !gateFor(u).known && !universePending.has(u)) tickers.add(u); };
  for (const s of combinedSignals()) if (s.direction !== 'sell' && s.valueUsd > 0) need(s.ticker);
  for (const r of sched13Filings) {
    if (r.tier < 2 && !(r.tierBefore >= 2)) continue;
    if (isRealTicker(r.ticker)) need(r.ticker);
    else if (!r.tickerLookedUp && r.subject && !(normName(r.subject) in universeNames) && !universePending.has('N:' + normName(r.subject))) names.add(r.subject);
  }
  for (const c of Object.values(campaignStore || {})) {
    if (campaignStage(c) !== 'proxy-fight') continue;
    if (!(normName(c.company) in universeNames) && !universePending.has('N:' + normName(c.company))) names.add(c.company);
  }
  for (const d of ((typeof boardData !== 'undefined' && boardData.deals) || [])) if (isRealTicker(d.ticker)) need(d.ticker);
  if (!tickers.size && !names.size) return;
  const tList = [...tickers].slice(0, 25), nList = [...names].slice(0, 30);
  tList.forEach(t => universePending.add(t)); nList.forEach(n => universePending.add('N:' + normName(n)));
  universeFetching = true;
  try {
    const qs = [];
    if (tList.length) qs.push('tickers=' + encodeURIComponent(tList.join(',')));
    if (nList.length) qs.push('names=' + encodeURIComponent(nList.join('|')));
    const res = await fetch(`${ALPACA_PROXY_URL}/universe?${qs.join('&')}`);
    if (res.status === 404) { universeOffline = true; return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    universeRules = data.rules || universeRules;
    for (const [t, v] of Object.entries(data.tickers || {})) universeCache[t.toUpperCase()] = { at: Date.now(), v };
    for (const [n, t] of Object.entries(data.byName || {})) universeNames[normName(n)] = t || null;
    // Resolve the ticker-less 13D rows we asked about.
    for (const r of sched13Filings) {
      if (isRealTicker(r.ticker) || !r.subject) continue;
      const k = normName(r.subject);
      if (k in universeNames) { r.tickerLookedUp = true; if (universeNames[k]) r.ticker = universeNames[k]; }
    }
    // Anything asked for that didn't come back is a known miss, not a retry loop.
    for (const t of tList) if (!universeCache[t]) universeCache[t] = { at: Date.now(), v: { ticker: t, pass: false, reasons: ['no data from universe lookup'] } };
    universeSave();
    const note = document.getElementById('cc-gate-note');
    if (note && universeRules) note.textContent = `gate: ${universeRules.exchanges} · $${universeRules.minPrice}+ · $${universeRules.minMcap / 1e6}M+ · $${universeRules.minAdvUsd / 1e6}M/day+`;
  } catch (e) {
    // Leave these pending for this page-load so the board doesn't spin on a
    // flaky route; a reload retries.
    console.warn('universe gate lookup failed', e);
    return;
  } finally {
    universeFetching = false;
    tList.forEach(t => universePending.delete(t)); nList.forEach(n => universePending.delete('N:' + normName(n)));
  }
  // Re-rank with the verdicts in hand (renderSignals → renderCommandCenter
  // → ensureUniverseForBoard, which finds nothing missing and stops).
  if (typeof renderSignals === 'function') renderSignals(); else renderCommandCenter();
  if (typeof renderSched13 === 'function' && sched13Filings.length) renderSched13();
  if (document.getElementById('tab-filtered')?.classList.contains('active')) renderFiltered();
}

// ── FILTERED TAB ─────────────────────────────────────────────
function renderFiltered() {
  const body = document.getElementById('filtered-body');
  if (!body) return;
  const rows = Object.values(ccRejects)
    .map(e => ({ ...e, sources: [...e.sources], reasons: [...e.reasons] }))
    .sort((a, b) => new Date(b.latest || 0) - new Date(a.latest || 0))
    .slice(0, 150);
  const rules = universeRules ? `${universeRules.exchanges} · $${universeRules.minPrice}+ · $${universeRules.minMcap / 1e6}M+ market cap · $${universeRules.minAdvUsd / 1e6}M+/day traded` : 'NYSE/Nasdaq · $2+ · $250M+ market cap · $1M+/day traded';
  const srcLabel = s => ({ insider: 'insider', 'insider:cluster': 'insider cluster', institution: '13F', sched13: '13D', campaign: 'proxy fight', deal: 'deal' })[s] || s;
  body.innerHTML = `
    <div class="status-box" style="text-align:left;padding:14px 18px;font-size:11px">
      Everything the board refused, with the reason. The <strong>universe gate</strong> is a hard floor — <strong>${escHtml(rules)}</strong> — applied to every stream before anything scores; a 13D additionally has to read as a real accumulation (not a financing, a dividend paid in stock, deal consideration, or a founder's own holdings). ${universeOffline ? '<strong style="color:var(--rose)">The gate is offline (Worker /universe route not deployed) — the board is currently showing unverified names.</strong>' : ''} If a name you'd want is listed here, the reason tells you which rule to loosen.
    </div>
    ${rows.length ? `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Stream</th><th>Why it's out</th><th>What it was</th><th>Newest</th><th></th></tr></thead>
      <tbody>
        ${rows.map(e => `
          <tr>
            <td style="font-weight:600">${e.ticker ? tickerLink(e.ticker) : escHtml(e.label || '—')}${e.ticker && universeCache[e.ticker] && universeCache[e.ticker].v ? `<div style="font-size:10px;color:var(--text-muted)">${escHtml(universeLabel(universeCache[e.ticker].v))}</div>` : ''}</td>
            <td style="white-space:nowrap;color:var(--text-dim)">${e.sources.map(srcLabel).map(escHtml).join(', ')}</td>
            <td style="color:var(--rose)">${e.reasons.map(escHtml).join('<br>')}</td>
            <td style="color:var(--text-dim);font-size:11px">${e.details.map(escHtml).join('<br>')}</td>
            <td class="mono" style="white-space:nowrap;color:var(--text-muted)">${e.latest ? relTime(e.latest) : '—'}</td>
            <td style="white-space:nowrap">${e.links.slice(0, 2).map((l, i) => `<a class="fund-link" href="${escHtml(l)}" target="_blank" rel="noopener">filing ${i + 1} →</a>`).join(' ')}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : '<div class="status-box">Nothing has been filtered yet this session — either every candidate passed, or the streams haven\'t loaded. Come back after the board fills in.</div>'}
  `;
}
