// ══════════════════════════════════════════════════════════════
// UNIVERSE GATE — is this even a tradeable public company?
// ══════════════════════════════════════════════════════════════
// Every earlier fix was a multiplier: financing ×0, microcap ×0.7, reverse
// split ×0.5 … and the garbage still leaked through because a "new 13D"
// starts with enough points to survive three discounts. This is a hard
// gate instead. A name that fails it never scores, never alerts, never
// gets a card — it is recorded with its reasons (the dashboard's Filtered
// tab) and that is all. The rules:
//   • listed on NYSE or Nasdaq per SEC's own company_tickers_exchange.json
//     (OTC, CBOE-only, null, or no SEC ticker at all → out)
//   • last close ≥ MIN_PRICE
//   • market cap ≥ MIN_MCAP (SEC XBRL shares outstanding × last close;
//     Finnhub as a fallback when a key is configured)
//   • 20-day average dollar volume ≥ MIN_ADV_USD (thin tape → out)
// Unknown is NOT a pass: if the cap can't be measured the name is held
// out with the reason "market cap unknown", where you can see it.
const UNIVERSE = {
  MIN_MCAP: 250e6,
  MIN_PRICE: 2,
  MIN_ADV_USD: 1e6,
  EXCHANGE_OK: /^(?:NYSE|Nasdaq)/i,
  PER_CALL: 25,                 // tickers per /universe request
  TTL_S: 6 * 3600,              // per-ticker verdict cache in KV
};

// Ticker → { cik, name, exchange }, plus normalized-name → ticker, from
// SEC's exchange-aware ticker file. Daily in KV.
async function getListingIndex(env) {
  const key = 'sec-listing-index-v1';
  if (env.SIGNAL_KV) {
    try { const c = await env.SIGNAL_KV.get(key, 'json'); if (c) return c; } catch { /* rebuild */ }
  }
  const res = await secFetch('https://www.sec.gov/files/company_tickers_exchange.json', {}, env);
  if (!res.ok) return null;
  const data = await res.json();
  const f = data.fields || ['cik', 'name', 'ticker', 'exchange'];
  const iCik = f.indexOf('cik'), iName = f.indexOf('name'), iTicker = f.indexOf('ticker'), iEx = f.indexOf('exchange');
  const byTicker = {}, byName = {};
  for (const row of (data.data || [])) {
    const ticker = String(row[iTicker] || '').toUpperCase();
    if (!ticker) continue;
    const rec = { cik: row[iCik], name: row[iName], exchange: row[iEx] || null };
    if (!byTicker[ticker]) byTicker[ticker] = rec;
    const norm = cusipNormName(row[iName]);
    // First writer wins — the file is ordered by market cap, so an
    // ambiguous name resolves to the larger, listed company.
    if (norm && !byName[norm]) byName[norm] = ticker;
  }
  const index = { byTicker, byName, at: new Date().toISOString() };
  if (env.SIGNAL_KV) { try { await env.SIGNAL_KV.put(key, JSON.stringify(index), { expirationTtl: 86400 }); } catch { /* non-fatal */ } }
  return index;
}

// CIK → common shares outstanding, from the XBRL frames API (one file per
// calendar quarter covering every filer's cover-page dei value). The three
// most recent quarters are merged, newest first, so a company that filed
// its 10-Q last month is current and one that hasn't is at most ~9 months
// stale — plenty for a $250M gate. Daily in KV.
async function getSharesIndex(env) {
  const key = 'sec-shares-index-v1';
  if (env.SIGNAL_KV) {
    try { const c = await env.SIGNAL_KV.get(key, 'json'); if (c) return c; } catch { /* rebuild */ }
  }
  const now = new Date();
  const frames = [];
  let y = now.getUTCFullYear(), q = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < 3; i++) { frames.push(`CY${y}Q${q}I`); if (--q === 0) { q = 4; y--; } }
  const shares = {};
  for (const fr of frames) {
    try {
      const res = await secFetch(`https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/${fr}.json`, { headers: { 'Accept': 'application/json' } }, env);
      if (!res.ok) continue;
      const data = await res.json();
      for (const d of (data.data || [])) {
        if (!(d.val > 0) || shares[d.cik]) continue; // newest frame wins
        shares[d.cik] = d.val;
      }
    } catch { /* one missing frame is fine */ }
  }
  const index = { shares, frames, at: now.toISOString() };
  if (env.SIGNAL_KV && Object.keys(shares).length) {
    try { await env.SIGNAL_KV.put(key, JSON.stringify(index), { expirationTtl: 86400 }); } catch { /* non-fatal */ }
  }
  return index;
}

// Last close + 20-day average dollar volume for many tickers in ONE Alpaca
// call (multi-symbol daily bars, IEX feed).
async function alpacaDailyStats(env, tickers) {
  const out = {};
  if (!tickers.length || !env.APCA_API_KEY_ID) return out;
  const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 45);
  const ymd = d => d.toISOString().slice(0, 10);
  const u = new URL(`${ALPACA_BASE}/v2/stocks/bars`);
  u.searchParams.set('symbols', tickers.join(','));
  u.searchParams.set('timeframe', '1Day');
  u.searchParams.set('start', ymd(start));
  u.searchParams.set('end', ymd(end));
  u.searchParams.set('adjustment', 'split');
  u.searchParams.set('feed', 'iex');
  u.searchParams.set('limit', '10000');
  try {
    const res = await fetch(u.toString(), { headers: { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY } });
    if (!res.ok) return out;
    const data = await res.json();
    for (const [sym, bars] of Object.entries(data.bars || {})) {
      if (!Array.isArray(bars) || !bars.length) continue;
      const last20 = bars.slice(-20);
      const adv = last20.reduce((s, b) => s + (b.c || 0) * (b.v || 0), 0) / last20.length;
      out[sym.toUpperCase()] = { price: bars[bars.length - 1].c, adv20Usd: adv, bars: bars.length };
    }
  } catch { /* leave unknown */ }
  return out;
}

// Finnhub market cap (millions USD) — only used when SEC shares are missing
// and a key is configured. Capped so one request never burns the budget.
async function finnhubCap(env, ticker) {
  if (!env.FINNHUB_API_KEY) return null;
  try {
    const res = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${env.FINNHUB_API_KEY}`);
    if (!res.ok) return null;
    const d = await res.json();
    const m = d.metric && d.metric.marketCapitalization;
    return m > 0 ? m * 1e6 : null;
  } catch { return null; }
}

function universeVerdict(t) {
  const reasons = [];
  if (!t.exchange) reasons.push('no NYSE/Nasdaq listing in SEC ticker file');
  else if (!UNIVERSE.EXCHANGE_OK.test(t.exchange)) reasons.push(`${t.exchange}-listed, not NYSE/Nasdaq`);
  if (t.price == null) reasons.push('no price data');
  else if (t.price < UNIVERSE.MIN_PRICE) reasons.push(`price $${t.price < 1 ? t.price.toFixed(4) : t.price.toFixed(2)} < $${UNIVERSE.MIN_PRICE}`);
  if (t.mcap == null) reasons.push('market cap unknown');
  else if (t.mcap < UNIVERSE.MIN_MCAP) reasons.push(`market cap $${(t.mcap / 1e6).toFixed(t.mcap < 10e6 ? 1 : 0)}M < $${UNIVERSE.MIN_MCAP / 1e6}M`);
  if (t.adv20Usd == null) reasons.push('no volume data');
  else if (t.adv20Usd < UNIVERSE.MIN_ADV_USD) reasons.push(`avg $ volume $${(t.adv20Usd / 1e3).toFixed(0)}K/day < $${UNIVERSE.MIN_ADV_USD / 1e6}M`);
  return { pass: reasons.length === 0, reasons };
}

// Resolve a batch of tickers (and/or issuer names) to gate verdicts.
// Returns { tickers: { T: { ticker, exchange, price, mcap, adv20Usd, pass,
// reasons, at } }, byName: { name: T | null }, rules }.
async function resolveUniverse(env, tickersIn, namesIn = []) {
  const listing = await getListingIndex(env);
  const byName = {};
  const tickers = new Set(tickersIn.map(t => String(t || '').toUpperCase().trim()).filter(t => TICKER_RE.test(t)));
  for (const n of namesIn) {
    const t = listing ? (listing.byName[cusipNormName(n)] || null) : null;
    byName[n] = t;
    if (t) tickers.add(t);
  }
  const want = [...tickers].slice(0, UNIVERSE.PER_CALL);
  const out = {};
  const misses = [];
  if (env.SIGNAL_KV) {
    await Promise.all(want.map(async t => {
      try { const c = await env.SIGNAL_KV.get('universe:' + t, 'json'); if (c) out[t] = c; else misses.push(t); } catch { misses.push(t); }
    }));
  } else misses.push(...want);
  if (misses.length) {
    const [shares, stats] = await Promise.all([getSharesIndex(env), alpacaDailyStats(env, misses)]);
    let finnhubCalls = 0;
    for (const t of misses) {
      const l = listing ? listing.byTicker[t] : null;
      const s = stats[t] || {};
      let mcap = null;
      const sh = l && shares && shares.shares ? shares.shares[l.cik] : null;
      if (sh > 0 && s.price > 0) mcap = sh * s.price;
      else if (l && s.price > 0 && finnhubCalls < 10) { finnhubCalls++; mcap = await finnhubCap(env, t); }
      const rec = {
        ticker: t, name: l ? l.name : null, cik: l ? l.cik : null, exchange: l ? l.exchange : null,
        price: s.price != null ? s.price : null, mcap, sharesOut: sh || null, adv20Usd: s.adv20Usd != null ? s.adv20Usd : null,
        at: new Date().toISOString(),
      };
      Object.assign(rec, universeVerdict(rec));
      out[t] = rec;
      if (env.SIGNAL_KV) { try { await env.SIGNAL_KV.put('universe:' + t, JSON.stringify(rec), { expirationTtl: UNIVERSE.TTL_S }); } catch { /* non-fatal */ } }
    }
  }
  return { tickers: out, byName, rules: { minMcap: UNIVERSE.MIN_MCAP, minPrice: UNIVERSE.MIN_PRICE, minAdvUsd: UNIVERSE.MIN_ADV_USD, exchanges: 'NYSE, Nasdaq' } };
}

// ── GET /universe?tickers=AAPL,MSFT&names=ACME%20CORP|OTHER%20INC
async function handleUniverse(url, env) {
  const tickers = (url.searchParams.get('tickers') || '').split(',').map(s => s.trim()).filter(Boolean);
  const names = (url.searchParams.get('names') || '').split('|').map(s => s.trim()).filter(Boolean).slice(0, 40);
  if (!tickers.length && !names.length) return json({ error: 'tickers (comma) and/or names (pipe) required', rules: UNIVERSE }, 400);
  try {
    const out = await resolveUniverse(env, tickers, names);
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900', ...corsHeaders() } });
  } catch (err) {
    return json({ error: 'universe resolution failed: ' + err.message }, 502);
  }
}

