// ══════════════════════════════════════════════════════════════════════
// SIGNAL DESK — SEC XBRL FUNDAMENTALS MODULE (fundamentals.js)
//
// Computes EBITDA, EBITDA margin, and EV/EBITDA straight from SEC XBRL
// company facts — no API key, no new Worker routes. All SEC calls go
// through the existing `${ALPACA_PROXY_URL}/sec-proxy` route (which
// already whitelists data.sec.gov) so the SEC sees a proper User-Agent
// and the browser gets CORS headers.
//
// EBITDA is NOT a GAAP-reported tag; it is computed here as:
//     EBITDA = OperatingIncomeLoss + Depreciation & Amortization
// using each company's most recent ANNUAL (10-K / 20-F) facts, and the
// result is labeled with that fiscal year so nobody mistakes it for TTM.
// Enterprise value = (price × shares outstanding) + total debt − cash.
//
// Everything degrades to '—': missing tags, unresolved tickers, REITs,
// banks (no meaningful EBITDA), rate limits — nothing here ever throws
// into the page.
//
// Depends on a global ALPACA_PROXY_URL (defined by every Signal Desk
// page). Include AFTER that constant exists, or just before the page's
// main inline <script> — the module reads it lazily at fetch time.
// ══════════════════════════════════════════════════════════════════════
window.SDFundamentals = (function () {
  'use strict';

  const CACHE_KEY = 'sd_sec_fundamentals_v4';   // per-CIK computed facts, 24h TTL (v4: debt rescue + filed-first shares)
  const CIK_MAP_KEY = 'sd_ticker_cik_map_v1';   // ticker -> CIK map, 7d TTL
  const FACTS_TTL_MS = 24 * 3600 * 1000;
  const CIK_TTL_MS = 7 * 24 * 3600 * 1000;
  const MAX_CONCURRENT = 3;                     // stay well under SEC's 10 req/s

  const proxyUrl = () => (typeof ALPACA_PROXY_URL !== 'undefined' ? ALPACA_PROXY_URL : '');
  const proxyConfigured = () => !!proxyUrl() && !proxyUrl().includes('YOUR-WORKER-SUBDOMAIN');

  // ── tag fallback chains (coverage varies wildly by filer) ────────────
  const TAGS = {
    opInc: ['OperatingIncomeLoss'],
    dna: ['DepreciationDepletionAndAmortization',
          'DepreciationAmortizationAndAccretionNet',
          'DepreciationAndAmortization'],
    revenue: ['Revenues',
              'RevenueFromContractWithCustomerExcludingAssessedTax',
              'RevenueFromContractWithCustomerIncludingAssessedTax',
              'SalesRevenueNet'],
    cash: ['CashAndCashEquivalentsAtCarryingValue',
           'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    ltDebtNoncurrent: ['LongTermDebtNoncurrent'],
    ltDebtCurrent: ['LongTermDebtCurrent'],
    ltDebtTotal: ['LongTermDebt', 'DebtLongtermAndShorttermCombinedAmount'],
    // Interest expense — used as a sanity check on the debt figure. If a
    // company pays $30M+/yr of interest, it does not have $6M of debt.
    interest: ['InterestExpense', 'InterestExpenseDebt', 'InterestAndDebtExpense'],
  };

  // Some filers (Centrus/LEU is the canonical case) carry their notes ONLY
  // under instrument-specific tags — the generic LongTermDebt* concepts
  // come back tiny or absent, which once reported $6M of "total debt"
  // against $1.18B of actual notes. These are fetched as a RESCUE pass,
  // only when the interest-coverage check says the standard tags look
  // impossibly light. Concepts are grouped into families: tags within a
  // family often re-tag the SAME instrument (take the max), while the
  // families themselves are distinct instruments (sum across families).
  const DEBT_RESCUE_FAMILIES = [
    ['ConvertibleDebtNoncurrent', 'ConvertibleDebt',
     'ConvertibleLongTermNotesPayable', 'ConvertibleNotesPayable'],       // max within
    ['SeniorLongTermNotes', 'NotesPayableNoncurrent', 'LongTermNotesPayable'], // max within
    ['SecuredLongTermDebt'], ['UnsecuredLongTermDebt'],                   // complementary — summed
  ];

  // ── tiny localStorage helpers (storage may be unavailable — non-fatal)
  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota/unavailable — fine */ }
  }

  // ── concurrency gate + per-ticker in-flight dedupe ───────────────────
  let active = 0;
  const waiters = [];
  function gate() {
    if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
    return new Promise(res => waiters.push(res));
  }
  function release() {
    active--;
    const next = waiters.shift();
    if (next) { active++; next(); }
  }
  const inflight = {}; // ticker -> Promise

  async function secFetch(targetUrl) {
    const res = await fetch(`${proxyUrl()}/sec-proxy?url=${encodeURIComponent(targetUrl)}`);
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  // ── ticker → CIK (company_tickers.json lives on www.sec.gov/files, ──
  //    which /sec-proxy does not allow, so use public CORS relays here)
  let cikMapPromise = null;
  function getCikMap() {
    if (cikMapPromise) return cikMapPromise;
    const cached = lsGet(CIK_MAP_KEY);
    if (cached && cached.at && (Date.now() - cached.at) < CIK_TTL_MS && cached.map) {
      cikMapPromise = Promise.resolve(cached.map);
      return cikMapPromise;
    }
    const src = 'https://www.sec.gov/files/company_tickers.json';
    const relays = [
      u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
      u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
      u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
    ];
    cikMapPromise = (async () => {
      let data = null, lastErr = null;
      for (const relay of relays) {
        try {
          const res = await fetch(relay(src));
          if (!res.ok) throw new Error('HTTP ' + res.status);
          data = await res.json();
          break;
        } catch (e) { lastErr = e; }
      }
      if (!data) { cikMapPromise = null; throw (lastErr || new Error('CIK map unavailable')); }
      const map = {};
      for (const entry of Object.values(data)) {
        if (entry && entry.ticker) map[String(entry.ticker).toUpperCase()] = entry.cik_str;
      }
      lsSet(CIK_MAP_KEY, { at: Date.now(), map });
      return map;
    })();
    return cikMapPromise;
  }

  async function resolveCik(ticker) {
    const map = await getCikMap();
    // 13F tickers like BRK.B may map as BRK-B in SEC data — try both forms
    const t = String(ticker || '').toUpperCase().trim();
    return map[t] ?? map[t.replace(/\./g, '-')] ?? map[t.replace(/-/g, '.')] ?? null;
  }

  // ── XBRL companyconcept fetch with tag fallback ──────────────────────
  async function fetchConcept(cik10, taxonomy, tagList) {
    for (const tag of tagList) {
      try {
        const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10}/${taxonomy}/${tag}.json`;
        const data = await secFetch(url);
        if (data && data.units) return { tag, units: data.units };
      } catch (e) {
        if (e.status && e.status !== 404) throw e; // real failure — don't mask as "no data"
        // 404 → filer doesn't use this tag; try the next one
      }
    }
    return null;
  }

  // Fetch EVERY tag in a list that exists (vs fetchConcept's first-hit).
  // Used by the debt rescue pass, where a filer may carry several distinct
  // instruments under several distinct concepts at once.
  async function fetchConceptsAll(cik10, taxonomy, tagList) {
    const found = [];
    await Promise.all(tagList.map(async tag => {
      try {
        const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10}/${taxonomy}/${tag}.json`;
        const data = await secFetch(url);
        if (data && data.units) found.push({ tag, units: data.units });
      } catch (e) {
        if (e.status && e.status !== 404) throw e;
      }
    }));
    return found;
  }

  // Latest ANNUAL duration fact (10-K/20-F/40-F, ~a year long)
  function latestAnnual(units) {
    const usd = (units && units.USD) || [];
    let best = null;
    for (const f of usd) {
      if (!f.start || !f.end || f.val == null) continue;
      const days = (new Date(f.end) - new Date(f.start)) / 864e5;
      if (days < 300 || days > 400) continue;
      const annualForm = /^(10-K|20-F|40-F)/.test(f.form || '') || f.fp === 'FY';
      if (!annualForm) continue;
      if (!best || f.end > best.end || (f.end === best.end && (f.filed || '') > (best.filed || ''))) best = f;
    }
    return best; // {val, end, fy, form, ...} | null
  }

  // ── TTM engine ───────────────────────────────────────────────────────
  // Trailing-twelve-month value for a duration concept, ending at date E.
  // Preference order:
  //   1. An actual annual fact ending exactly at E (fiscal year just closed)
  //   2. FY + YTD(current) − YTD(same span, prior year)  — the standard
  //      method, and the only one that works for D&A, which 10-Qs report
  //      year-to-date on the cash flow statement rather than per-quarter
  //   3. Sum of 4 consecutive discrete quarters ending at E
  // Returns {val, end} or null. Tolerances absorb 52/53-week fiscal years.
  function daysBetween(a, b) { return (new Date(b) - new Date(a)) / 864e5; }

  function durationFacts(units) {
    return ((units && units.USD) || []).filter(f =>
      f.start && f.end && f.val != null && /^(10-K|10-Q|20-F|40-F|6-K)/.test(f.form || ''));
  }

  function latestPeriodEnd(units) {
    let max = '';
    for (const f of durationFacts(units)) if (f.end > max) max = f.end;
    return max || null;
  }

  function trailingTwelve(units, E) {
    if (!E) return null;
    const facts = durationFacts(units);
    const at = (end, minD, maxD) => facts
      .filter(f => Math.abs(daysBetween(f.end, end)) <= 6) // 52/53-week wobble
      .filter(f => { const d = daysBetween(f.start, f.end); return d >= minD && d <= maxD; })
      .sort((a, b) => (b.filed || '').localeCompare(a.filed || ''))[0] || null;

    // 1. annual ending at E
    const annualAtE = at(E, 300, 400);
    if (annualAtE) return { val: annualAtE.val, end: annualAtE.end };

    // 2. FY + YTD − prior YTD
    const ytdCur = at(E, 75, 290); // Q1 YTD (~90d) through 9-month YTD (~275d)
    if (ytdCur) {
      const ytdLen = daysBetween(ytdCur.start, ytdCur.end);
      const priorEndTarget = new Date(new Date(ytdCur.end).getTime() - 364 * 864e5).toISOString().slice(0, 10);
      const ytdPrior = facts
        .filter(f => Math.abs(daysBetween(f.end, priorEndTarget)) <= 10)
        .filter(f => Math.abs(daysBetween(f.start, f.end) - ytdLen) <= 12)
        .sort((a, b) => (b.filed || '').localeCompare(a.filed || ''))[0] || null;
      const fyEndTarget = new Date(new Date(ytdCur.start).getTime() - 864e5).toISOString().slice(0, 10);
      const fy = facts
        .filter(f => Math.abs(daysBetween(f.end, fyEndTarget)) <= 6)
        .filter(f => { const d = daysBetween(f.start, f.end); return d >= 300 && d <= 400; })
        .sort((a, b) => (b.filed || '').localeCompare(a.filed || ''))[0] || null;
      if (fy && ytdPrior) return { val: fy.val + ytdCur.val - ytdPrior.val, end: ytdCur.end };
    }

    // 3. chain of 4 discrete quarters
    let cursor = E, sum = 0;
    for (let i = 0; i < 4; i++) {
      const q = at(cursor, 75, 100);
      if (!q) return null;
      sum += q.val;
      cursor = new Date(new Date(q.start).getTime() - 864e5).toISOString().slice(0, 10);
    }
    return { val: sum, end: E };
  }

  // Latest INSTANT (point-in-time) fact — balance-sheet items
  function latestInstant(units, unitKey) {
    const arr = (units && units[unitKey]) || [];
    let best = null;
    for (const f of arr) {
      if (!f.end || f.val == null || f.start) continue;
      if (!best || f.end > best.end || (f.end === best.end && (f.filed || '') > (best.filed || ''))) best = f;
    }
    return best;
  }

  // Shares outstanding: dei tag, latest cover-page report. Multi-class
  // filers report one row per class inside the same accession — sum the
  // rows of the single most recent accession at the latest date.
  function latestShares(units) {
    const arr = (units && units.shares) || [];
    if (!arr.length) return null;
    // Pick by most recent FILING first, then the latest as-of date within
    // that filing. Picking the max as-of date across all history (the old
    // way) can resurrect a stale fact from an old or amended filing —
    // that's exactly how a years-old 13.7M share count once masqueraded
    // as LEU's current count while the real figure was ~17.8M.
    let bestFiled = '', bestAccn = '';
    for (const f of arr) {
      if (f.val != null && f.end && (f.filed || '') > bestFiled) { bestFiled = f.filed || ''; bestAccn = f.accn || ''; }
    }
    const inAccn = arr.filter(f => (f.accn || '') === bestAccn && f.val != null && f.end);
    if (!inAccn.length) return null;
    let maxEnd = '';
    for (const f of inAccn) if (f.end > maxEnd) maxEnd = f.end;
    const chosen = inAccn.filter(f => f.end === maxEnd);
    const seen = new Set();
    let total = 0;
    for (const f of chosen) {
      const sig = f.val + '|' + (f.fy || '') + '|' + (f.fp || '');
      if (seen.has(sig)) continue; // identical duplicate row, not a second class
      seen.add(sig);
      total += f.val;
    }
    return total > 0 ? { val: total, end: maxEnd, filed: bestFiled } : null;
  }

  // ── core: assemble SEC-derived facts for one ticker (cached 24h) ─────
  async function getFacts(ticker) {
    const t = String(ticker || '').toUpperCase().trim();
    if (!t || !proxyConfigured()) return null;
    if (inflight[t]) return inflight[t];

    inflight[t] = (async () => {
      const cacheAll = lsGet(CACHE_KEY) || {};
      const hit = cacheAll[t];
      if (hit && (Date.now() - hit.at) < FACTS_TTL_MS) return hit.facts;

      await gate();
      try {
        const cik = await resolveCik(t);
        if (!cik) return saveFacts(t, { noCik: true });
        const cik10 = String(cik).padStart(10, '0');

        const [opInc, dna, revenue, cash, ltNc, ltCur] = await Promise.all([
          fetchConcept(cik10, 'us-gaap', TAGS.opInc),
          fetchConcept(cik10, 'us-gaap', TAGS.dna),
          fetchConcept(cik10, 'us-gaap', TAGS.revenue),
          fetchConcept(cik10, 'us-gaap', TAGS.cash),
          fetchConcept(cik10, 'us-gaap', TAGS.ltDebtNoncurrent),
          fetchConcept(cik10, 'us-gaap', TAGS.ltDebtCurrent),
        ]);
        // combined-debt fallback only if the split tags are absent
        const ltTot = (!ltNc && !ltCur) ? await fetchConcept(cik10, 'us-gaap', TAGS.ltDebtTotal) : null;
        const sharesConcept = await fetchConcept(cik10, 'dei', ['EntityCommonStockSharesOutstanding']);

        // ── Freshest window first: TTM through the latest reported quarter.
        // All three duration concepts must cover the SAME trailing window,
        // otherwise mixing periods fabricates a number — so fall back to the
        // matched-annual method whenever any leg is missing.
        const E = opInc ? latestPeriodEnd(opInc.units) : null;
        const opTTM = opInc ? trailingTwelve(opInc.units, E) : null;
        const dnaTTM = (dna && opTTM) ? trailingTwelve(dna.units, opTTM.end) : null;
        const revTTM = (revenue && opTTM) ? trailingTwelve(revenue.units, opTTM.end) : null;
        const useTTM = !!(opTTM && dnaTTM);

        const opA = opInc && latestAnnual(opInc.units);
        // D&A must belong to the SAME fiscal period as operating income —
        // mixing years silently fabricates a number, so require a match.
        let dnaA = null;
        if (dna && opA) {
          const usd = (dna.units && dna.units.USD) || [];
          dnaA = usd.filter(f => f.end === opA.end && f.start && f.val != null)
                    .sort((a, b) => (b.filed || '').localeCompare(a.filed || ''))[0] || null;
        }
        const revA = revenue && latestAnnual(revenue.units);
        const cashI = cash && latestInstant(cash.units, 'USD');
        const debtNcI = ltNc && latestInstant(ltNc.units, 'USD');
        const debtCurI = ltCur && latestInstant(ltCur.units, 'USD');
        const debtTotI = ltTot && latestInstant(ltTot.units, 'USD');
        const sharesI = sharesConcept && latestShares(sharesConcept.units);

        const ebitda = useTTM ? opTTM.val + dnaTTM.val
                     : (opA && dnaA) ? opA.val + dnaA.val : null;
        const rev = useTTM ? (revTTM ? revTTM.val : null)
                  : (revA ? revA.val : null);
        const revSamePeriod = useTTM ? !!revTTM
                            : !!(revA && opA && revA.end === opA.end);
        let debt = null;
        if (debtNcI || debtCurI) debt = (debtNcI ? debtNcI.val : 0) + (debtCurI ? debtCurI.val : 0);
        else if (debtTotI) debt = debtTotI.val;
        // Prefer the combined tag when it's LARGER than the split sum —
        // some filers put only a residual sliver under the split tags.
        if (debtTotI && debt != null && debtTotI.val > debt) debt = debtTotI.val;

        // ── Debt sanity: interest coverage + nonstandard-notes rescue ──
        // If TTM interest expense implies far more debt than the standard
        // tags disclose (e.g. > ~12% effective rate, an impossibility for
        // an ongoing filer), scan the instrument-specific note/convertible
        // concepts and take the larger answer. Flags stay on the facts so
        // the UI can mark the figure as approximate instead of confident.
        let debtApprox = false, debtSuspect = false;
        let intTTM = null;
        try {
          const interest = await fetchConcept(cik10, 'us-gaap', TAGS.interest);
          if (interest) {
            const iE = latestPeriodEnd(interest.units);
            const iT = iE ? trailingTwelve(interest.units, iE) : null;
            if (iT && iT.val > 0) intTTM = iT.val;
          }
        } catch (e) { /* interest unavailable — sanity check simply skipped */ }
        const debtLooksLight = intTTM != null && intTTM > 1e6 && (debt == null || debt < 8 * intTTM);
        if (debtLooksLight) {
          try {
            let rescueSum = 0;
            for (const family of DEBT_RESCUE_FAMILIES) {
              const hits = await fetchConceptsAll(cik10, 'us-gaap', family);
              let familyMax = 0;
              for (const h of hits) {
                const inst = latestInstant(h.units, 'USD');
                if (inst && inst.val > familyMax) familyMax = inst.val;
              }
              rescueSum += familyMax;
            }
            if (rescueSum > (debt || 0)) { debt = rescueSum; debtApprox = true; }
          } catch (e) { /* rescue is best-effort */ }
          // still light after the rescue → surface the doubt rather than a
          // confidently wrong number
          debtSuspect = intTTM != null && intTTM > 1e6 && (debt == null || debt < 8 * intTTM);
        }

        const fyStr = opA ? (opA.fy || (opA.end || '').slice(0, 4)) : null;
        const facts = {
          fy: fyStr,
          fyEnd: useTTM ? opTTM.end : (opA ? opA.end : null),
          periodLabel: useTTM ? 'TTM' : (fyStr ? 'FY' + fyStr : null),
          isTTM: useTTM,
          opInc: useTTM ? opTTM.val : (opA ? opA.val : null),
          dna: useTTM ? dnaTTM.val : (dnaA ? dnaA.val : null),
          ebitda,
          revenue: rev,
          revenueSamePeriod: revSamePeriod,
          cash: cashI ? cashI.val : null,
          cashAsOf: cashI ? cashI.end : null,
          debt,
          debtAsOf: debtNcI ? debtNcI.end : (debtTotI ? debtTotI.end : null),
          debtApprox,
          debtSuspect,
          interestTTM: intTTM,
          shares: sharesI ? sharesI.val : null,
          sharesAsOf: sharesI ? sharesI.end : null,
          sharesFiled: sharesI ? (sharesI.filed || null) : null,
        };
        // Warnings the UI should surface instead of silently trusting a tile
        facts.warnings = [];
        if (debtSuspect) facts.warnings.push(
          `TTM interest expense (${fmtBig(intTTM)}) implies more debt than XBRL discloses — total debt and EV are likely understated.`);
        else if (debtApprox) facts.warnings.push(
          'Total debt recovered from instrument-specific note tags (standard tags were incomplete) — treat as approximate.');
        if (facts.sharesAsOf && (Date.now() - new Date(facts.sharesAsOf).getTime()) > 400 * 864e5) facts.warnings.push(
          `Share count is from a cover page dated ${facts.sharesAsOf} — over a year old; market cap may be stale.`);
        return saveFacts(t, facts);
      } catch (e) {
        // transient failure (rate limit, network) — don't cache, just degrade
        return null;
      } finally {
        release();
        delete inflight[t];
      }
    })();
    return inflight[t];
  }

  function saveFacts(ticker, facts) {
    const cacheAll = lsGet(CACHE_KEY) || {};
    cacheAll[ticker] = { at: Date.now(), facts };
    // keep the cache from growing without bound
    const keys = Object.keys(cacheAll);
    if (keys.length > 400) {
      keys.sort((a, b) => cacheAll[a].at - cacheAll[b].at)
          .slice(0, keys.length - 400)
          .forEach(k => delete cacheAll[k]);
    }
    lsSet(CACHE_KEY, cacheAll);
    return facts;
  }

  // ── derived metrics: needs a current price for market cap / EV ───────
  function deriveMetrics(facts, price) {
    if (!facts || facts.noCik) return null;
    const out = { ...facts, marketCap: null, ev: null, evEbitda: null, evApprox: false, ebitdaMargin: null };
    if (facts.ebitda != null && facts.revenue != null && facts.revenue !== 0 && facts.revenueSamePeriod) {
      out.ebitdaMargin = (facts.ebitda / facts.revenue) * 100;
    }
    if (price != null && price > 0 && facts.shares) {
      out.marketCap = price * facts.shares;
      if (facts.ebitda != null && facts.ebitda > 0) {
        out.ev = out.marketCap + (facts.debt || 0) - (facts.cash || 0);
        out.evApprox = (facts.debt == null || facts.cash == null || !!facts.debtApprox || !!facts.debtSuspect);
        out.evEbitda = out.ev / facts.ebitda;
      }
    }
    return out;
  }

  async function getMetrics(ticker, price) {
    const facts = await getFacts(ticker);
    return deriveMetrics(facts, price);
  }

  // Fetch a recent close from the existing /bars route (for pages that
  // don't already have one in hand).
  async function fetchLatestClose(ticker) {
    if (!proxyConfigured()) return null;
    try {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 12);
      const iso = d => d.toISOString().slice(0, 10);
      const res = await fetch(`${proxyUrl()}/bars?symbol=${encodeURIComponent(ticker)}&start=${iso(start)}&end=${iso(end)}`);
      if (!res.ok) return null;
      const data = await res.json();
      const bars = data.bars || [];
      return bars.length ? bars[bars.length - 1].c : null;
    } catch (e) { return null; }
  }

  // ── drop-in cell renderer for table rows (fund.html) ─────────────────
  function fillEvCell(el, ticker, price) {
    if (!el) return;
    if (!ticker) { el.textContent = '—'; return; }
    el.textContent = '…';
    getMetrics(ticker, price).then(m => {
      if (!m || m.evEbitda == null) {
        el.textContent = '—';
        el.title = !m ? 'No SEC XBRL fundamentals found for this ticker'
          : (m.ebitda != null && m.ebitda <= 0) ? `EBITDA is negative or zero (${m.periodLabel || 'latest period'}) — multiple not meaningful`
          : 'Not computable from available SEC filings (common for banks, insurers, REITs, funds)';
        el.style.color = 'var(--text-muted)';
        return;
      }
      el.textContent = m.evEbitda.toFixed(1) + '×' + (m.evApprox ? '*' : '');
      const per = m.isTTM ? `TTM through ${m.fyEnd || '?'}` : `FY${m.fy || '?'}`;
      el.title = `EV/EBITDA vs ${per} EBITDA of ${fmtBig(m.ebitda)}`
        + (m.warnings && m.warnings.length ? ' — ⚠ ' + m.warnings.join(' ') : (m.evApprox ? ' (debt or cash incomplete under standard tags — EV approximate)' : ''))
        + ' — source: SEC XBRL company facts';
      if (m.evEbitda < 10) el.style.color = 'var(--teal)';
      else if (m.evEbitda > 25) el.style.color = 'var(--rose)';
    }).catch(() => { el.textContent = '—'; });
  }

  function fmtBig(n) {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (a >= 1e12) return sign + '$' + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M';
    return sign + '$' + Math.round(a).toLocaleString('en-US');
  }

  return { getFacts, getMetrics, deriveMetrics, fetchLatestClose, fillEvCell, fmtBig, resolveCik };
})();
