/**
 * Signal Desk — Alpaca Market Data proxy (Cloudflare Worker)
 * ------------------------------------------------------------
 * WHY THIS EXISTS:
 * Alpaca's Market Data API requires two secret headers on every request
 * (APCA-API-KEY-ID / APCA-API-SECRET-KEY). Signal Desk's frontend is a
 * static site with no server, so those secrets can never live in its
 * JavaScript — anyone viewing page source would see them. This Worker
 * holds the secrets instead. The static site calls THIS Worker; this
 * Worker calls Alpaca.
 *
 * WHAT IT DOES (and doesn't):
 * - Exposes: historical daily bars for a single symbol (/bars), today's
 *   top gainers/losers (/movers), today's most active symbols by volume
 *   (/actives), the live SEC Form 4 insider filing feed (/insider-feed),
 *   batched Form 4 XML extraction (/form4-batch), a strict SEC-only proxy
 *   (/sec-proxy), company fundamentals (/fundamentals), the scheduled
 *   13D alert scan's status (/alerts-status), and a live trade/quote
 *   WebSocket relay (/stream). A cron trigger (wrangler.toml) also runs a
 *   13D alert scan every 30 minutes and pushes tier-2+ filings via ntfy.
 *   (The old /congress-feed route was removed — its upstream dataset died.)
 * - /fundamentals proxies Finnhub's free-tier `stock/metric` endpoint
 *   (EBITDA, market cap, P/E, revenue per share, margins, 52-week range).
 *   Alpaca's Market Data API doesn't carry fundamentals at all, so this is
 *   the one route here that isn't Alpaca and isn't SEC/S3 either — it needs
 *   its own free API key (see FINNHUB_API_KEY below). If that secret isn't
 *   set, the route returns a clear "not configured" error instead of
 *   silently failing, same as the Alpaca credential gate.
 * - /stream is backed by a Durable Object (AlpacaStreamRelay, below). Most
 *   Alpaca plans — including free — allow exactly ONE concurrent WebSocket
 *   connection per account. The Durable Object exists so every browser tab
 *   shares that one connection instead of each tab trying to open its own
 *   and getting rejected. It reconnects to Alpaca with backoff if dropped,
 *   and closes itself down (no reconnect attempts) once no tabs are
 *   listening, so it doesn't run — or bill — when nobody's watching.
 * - The insider-feed/congress-feed routes aren't Alpaca calls at all — this
 *   file has grown from "Alpaca proxy" into "Signal Desk's one server-side
 *   proxy." They're here because www.sec.gov's legacy endpoints and the
 *   public S3 dataset don't reliably send CORS headers for direct browser
 *   fetches, and SEC's fair access policy requires a real User-Agent that
 *   browser JS can never set. Routing through here sidesteps both problems
 *   at once, no API key needed for either.
 * - Does NOT expose Alpaca's Trading API (no orders, no account access) —
 *   this only talks to data.alpaca.markets, not the trading endpoints.
 * - Validates and allowlists inputs so it can't be turned into an open
 *   proxy for arbitrary Alpaca calls.
 * - Locks feed to 'iex' for bars and the stream (included on all Alpaca
 *   accounts, no market data subscription required) so this can't
 *   accidentally rack up SIP feed charges. The screener endpoints
 *   (/movers, /actives) are SIP-based on Alpaca's side regardless — that's
 *   how Alpaca serves them, no feed parameter to set.
 *
 * DEPLOY STEPS:
 * 1. npm install -g wrangler
 * 2. wrangler login
 * 3. In this directory: wrangler deploy alpaca-proxy-worker.js
 *    (or `wrangler init` and paste this in as src/index.js — either works)
 * 4. Set your real Alpaca keys as encrypted secrets (never paste them
 *    into this file):
 *      wrangler secret put APCA_API_KEY_ID
 *      wrangler secret put APCA_API_SECRET_KEY
 * 4b. Optional — enables the fundamentals strip on the stock deep-dive
 *    page. Get a free key at https://finnhub.io/register (no card needed,
 *    free tier is plenty for personal use), then:
 *      wrangler secret put FINNHUB_API_KEY
 *    Skip this and /fundamentals just returns a "not configured" error —
 *    nothing else on the site depends on it.
 * 5. Edit ALLOWED_ORIGIN below to match your actual site origin
 *    (e.g. "https://yourusername.github.io"), then redeploy.
 * 6. Copy the workers.dev URL wrangler prints out and paste it into
 *    ALPACA_PROXY_URL near the top of index.html's, fund.html's, and
 *    stock.html's <script>.
 *
 * NOTE ON /stream: this needs the durable_objects binding and migration
 * already added to wrangler.toml alongside this file. If you're deploying
 * fresh, make sure wrangler.toml and this file are in the same directory —
 * `wrangler deploy` reads wrangler.toml automatically, no extra flags.
 *
 * Get Alpaca API keys (free, paper or live account both work for market
 * data) at https://app.alpaca.markets/ under "API Keys".
 */

// ── EDIT THIS to your deployed site's origin. "*" works for testing but
// means ANY website could call your proxy (they'd still be rate-limited
// by your Alpaca account, but it's safer to lock this down once you know
// your real domain).
const ALLOWED_ORIGIN = '*'; // '*' so the dashboard works both locally (file://) and on GitHub Pages — the worker is read-only data, no account access

// SEC's fair-access policy requires every request to identify a real
// contact — browsers block JS from setting User-Agent, which is exactly
// why /insider-feed and /congress-feed have to be proxied server-side here
// rather than fetched directly from the page. EDIT THIS to something real.
const SEC_USER_AGENT = 'Signal Desk jahloverules@gmail.com';

// ── SEC FETCH DISCIPLINE ──────────────────────────────────────
// EDGAR allows 10 requests/second per IP and answers a burst above that
// with HTTP 429 + a 10-minute block that EXTENDS if you keep knocking. Every
// dashboard tab funnels its EDGAR traffic through this one Worker (one
// egress IP), and /form4-batch used to fire up to 20 fetches at once — so
// the whole desk would go dark ("Insiders · unreachable", 13D spinner)
// whenever a page load coincided with a scan. All EDGAR traffic now goes
// through secFetch():
//   • at most SEC_MAX_CONCURRENCY in flight, ≥ SEC_MIN_GAP_MS apart (≈ 6/s)
//   • immutable /Archives/ documents cached in memory + KV (never re-read)
//   • live feeds cached in memory for a short TTL (a reload is free)
//   • on a 429 the Worker stops calling EDGAR for SEC_BACKOFF_MS and
//     answers 429 itself, so the block lifts instead of extending
const SEC_MAX_CONCURRENCY = 3;
const SEC_MIN_GAP_MS = 160;
const SEC_BACKOFF_MS = 65_000;
const SEC_MEM_MAX = 80;             // in-memory entries (per isolate)
const SEC_KV_MAX_BYTES = 2_000_000; // archive docs above this stay memory-only
let secInFlight = 0;
let secLastStart = 0;
let secBlockedUntil = 0;
const secMem = new Map();           // url -> { exp, status, ct, body:string }

function secCacheTtl(url) {
  if (/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//.test(url)) return 30 * 86400e3; // filings never change
  if (/\/files\/company_tickers\.json/.test(url)) return 86400e3;
  if (/data\.sec\.gov\/submissions\//.test(url)) return 10 * 60e3;
  if (/efts\.sec\.gov\//.test(url)) return 120e3;
  if (/browse-edgar\?action=getcurrent/.test(url)) return 45e3;
  return 60e3;
}

function secMemPut(url, entry) {
  secMem.set(url, entry);
  if (secMem.size > SEC_MEM_MAX) {
    const oldest = [...secMem.entries()].sort((a, b) => a[1].exp - b[1].exp)[0];
    if (oldest) secMem.delete(oldest[0]);
  }
}

function secResponse(entry) {
  return new Response(entry.body, { status: entry.status, headers: { 'Content-Type': entry.ct } });
}

// Slot acquisition is serialized through a promise chain so a burst of
// parallel callers can't all pass the checks at once (which is exactly the
// race that produced 20-at-a-time bursts before).
let secChain = Promise.resolve();
function secSlot() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mine = secChain.then(async () => {
    while (secInFlight >= SEC_MAX_CONCURRENCY) await sleep(40);
    const wait = secLastStart + SEC_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    secLastStart = Date.now();
    secInFlight++;
  });
  secChain = mine.catch(() => {});
  return mine;
}

// Drop-in for fetch(url, { headers }) against sec.gov. Returns a Response.
// `env` is optional; with SIGNAL_KV bound, archive documents persist across
// isolates so a filing is read from EDGAR at most once, ever.
async function secFetch(url, opts = {}, env = null) {
  const now = Date.now();
  const hit = secMem.get(url);
  if (hit && hit.exp > now) return secResponse(hit);
  const ttl = secCacheTtl(url);
  const archival = ttl >= 86400e3;
  const kvKey = 'sec:' + url;
  if (archival && env && env.SIGNAL_KV) {
    try {
      const kv = await env.SIGNAL_KV.get(kvKey, 'json');
      if (kv && kv.body != null) { secMemPut(url, { ...kv, exp: now + ttl }); return secResponse(kv); }
    } catch { /* fall through to network */ }
  }
  if (secBlockedUntil > now) {
    return new Response('EDGAR rate limit back-off in effect (worker-side)', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': String(Math.ceil((secBlockedUntil - now) / 1000)) } });
  }
  await secSlot();
  let res;
  try {
    res = await fetch(url, { ...opts, headers: { 'User-Agent': SEC_USER_AGENT, ...(opts.headers || {}) } });
  } finally {
    secInFlight--;
  }
  if (res.status === 429 || res.status === 403) {
    secBlockedUntil = Date.now() + SEC_BACKOFF_MS;
    return res;
  }
  // Mocked responses in the unit tests are plain objects — pass them through.
  if (!res.ok || typeof res.text !== 'function' || !res.headers || typeof res.headers.get !== 'function') return res;
  const body = await res.text();
  const entry = { exp: Date.now() + ttl, status: res.status, ct: res.headers.get('Content-Type') || 'application/octet-stream', body };
  secMemPut(url, entry);
  if (archival && env && env.SIGNAL_KV && body.length <= SEC_KV_MAX_BYTES) {
    try { await env.SIGNAL_KV.put(kvKey, JSON.stringify({ status: entry.status, ct: entry.ct, body }), { expirationTtl: 30 * 86400 }); } catch { /* non-fatal */ }
  }
  return secResponse(entry);
}


const ALPACA_BASE = 'https://data.alpaca.markets';
const TICKER_RE = /^[A-Z.]{1,10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function xml(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/atom+xml; charset=utf-8', ...corsHeaders() },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);

    // These three are public data or use their own separate credential —
    // check them before the Alpaca credential gate below, so none of them
    // depend on Alpaca keys being configured.
    if (url.pathname === '/insider-feed') return handleInsiderFeed(url);
    if (url.pathname === '/form4-batch') return handleForm4Batch(url, env);
    if (url.pathname === '/cusip-batch') return handleCusipBatch(url, env, ctx);
    if (url.pathname === '/sched13-history') return handleSched13History(env);
    if (url.pathname === '/sec-proxy') return handleSecProxy(url, env);
    if (url.pathname === '/fundamentals') return handleFundamentals(url, env);
    if (url.pathname === '/alerts-status') return handleAlertsStatus(env);
    if (url.pathname === '/board-data') return handleBoardData(env);

    if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) {
      return json({ error: 'Proxy is not configured with Alpaca credentials yet' }, 500);
    }

    if (url.pathname === '/bars') return handleBars(url, env);
    if (url.pathname === '/movers') return handleMovers(url, env);
    if (url.pathname === '/actives') return handleActives(url, env);
    if (url.pathname === '/stream') return handleStream(request, env);

    return json({ error: 'Not found. Only /bars, /movers, /actives, /insider-feed, /form4-batch, /cusip-batch, /sec-proxy, /fundamentals, /alerts-status, /board-data, and /stream are exposed by this proxy.' }, 404);
  },

  // ── SCHEDULED ALERT SCAN ─────────────────────────────────────
  // A dashboard only works while someone is staring at it; 13Ds move stocks
  // within minutes of hitting EDGAR. This cron (see [triggers] in
  // wrangler.toml) polls the 13D feed every 30 minutes, tiers each filing
  // exactly like the frontend does, and pushes anything tier-2+ that hasn't
  // been alerted before. Dedupe lives in the SIGNAL_KV namespace.
  //
  // Push channel is ntfy.sh — zero-signup push notifications. Pick a hard-
  // to-guess topic name (it's effectively a password), subscribe to it in
  // the ntfy mobile/desktop app, then:
  //   wrangler secret put NTFY_TOPIC       (e.g. signal-desk-jh-8k2p1x)
  // No NTFY_TOPIC set → the scan still runs and records status (visible at
  // /alerts-status), it just doesn't push anywhere.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlertScan(env));
    ctx.waitUntil(runDealStatusScan(env));
  },
};

// ── GET /board-data
// M&A deal board + IPO Radar, served from the D1 database "signal-desk-board"
// (BOARD_DB binding in wrangler.toml). The daily Claude scheduled task writes
// the research; runDealStatusScan below re-checks pending deals against EDGAR
// every 30 minutes and auto-closes/prunes. The dashboard renders exactly what
// this returns — no deal data lives in index.html beyond the day-one seed.
async function handleBoardData(env) {
  if (!env.BOARD_DB) {
    return json({ error: 'BOARD_DB binding missing — add the d1_databases block to wrangler.toml and redeploy' }, 501);
  }
  try {
    const [deals, ipos, meta] = await Promise.all([
      env.BOARD_DB.prepare(
        "SELECT * FROM deals ORDER BY CASE status WHEN 'closed' THEN 2 WHEN 'terminated' THEN 2 WHEN 'rumored' THEN 1 ELSE 0 END, COALESCE(ann_date,'') DESC"
      ).all(),
      env.BOARD_DB.prepare('SELECT * FROM ipos ORDER BY rank ASC').all(),
      env.BOARD_DB.prepare('SELECT key, value FROM meta').all(),
    ]);
    const metaObj = {};
    for (const row of meta.results || []) metaObj[row.key] = row.value;
    return new Response(JSON.stringify({
      deals: deals.results || [],
      ipos: ipos.results || [],
      meta: metaObj,
      served_at: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...corsHeaders() },
    });
  } catch (err) {
    return json({ error: 'D1 query failed: ' + err.message }, 500);
  }
}

// ── DEAL STATUS SCAN (cron, every 30 min alongside the 13D scan)
// For up to DEAL_SCAN_BATCH pending deals (least-recently-checked first),
// read the target's EDGAR submissions index and look for completion
// evidence filed after the announcement: a Form 25 / 25-NSE delisting, or
// an 8-K with Item 2.01 (completion of acquisition) or 3.01 (delisting
// notice). Found → status='closed' + optional ntfy push. Closed/terminated
// rows older than 21 days are pruned so the board stays current.
const DEAL_SCAN_BATCH = 8;

async function runDealStatusScan(env) {
  if (!env.BOARD_DB) return;
  const status = { ran: new Date().toISOString(), checked: 0, closedDetected: 0, pruned: 0, errors: [] };
  try {
    const { results: deals } = await env.BOARD_DB.prepare(
      "SELECT id, ticker, cik, ann_date FROM deals WHERE status LIKE 'pending%' AND cik IS NOT NULL ORDER BY COALESCE(last_check,'') ASC LIMIT ?"
    ).bind(DEAL_SCAN_BATCH).all();
    const now = new Date().toISOString();
    for (const deal of deals || []) {
      status.checked++;
      try {
        const cik10 = String(parseInt(deal.cik, 10)).padStart(10, '0');
        const res = await secFetch(`https://data.sec.gov/submissions/CIK${cik10}.json`, {
          headers: { 'Accept': 'application/json' },
        }, env);
        if (!res.ok) throw new Error('EDGAR HTTP ' + res.status);
        const sub = await res.json();
        const recent = sub.filings && sub.filings.recent;
        let closedEvidence = null;
        if (recent && Array.isArray(recent.form)) {
          const annTime = deal.ann_date ? new Date(deal.ann_date).getTime() : 0;
          for (let i = 0; i < recent.form.length && i < 60; i++) {
            const form = String(recent.form[i] || '').toUpperCase();
            const filed = recent.filingDate ? recent.filingDate[i] : '';
            if (filed && new Date(filed).getTime() < annTime) continue;
            if (form === '25' || form === '25-NSE') { closedEvidence = `Form ${form} (delisting) filed ${filed}`; break; }
            if (form === '8-K' || form === '8-K/A') {
              const items = String((recent.items && recent.items[i]) || '');
              if (items.includes('2.01') || items.includes('3.01')) {
                closedEvidence = `8-K Item ${items.includes('2.01') ? '2.01 (completion)' : '3.01 (delisting notice)'} filed ${filed}`;
                break;
              }
            }
          }
        }
        if (closedEvidence) {
          status.closedDetected++;
          await env.BOARD_DB.prepare(
            "UPDATE deals SET status='closed', close_date=?, stage_detail=?, updated_at=?, last_check=? WHERE id=?"
          ).bind(now.slice(0, 10), 'Auto-detected as completed: ' + closedEvidence, now, now, deal.id).run();
          if (env.NTFY_TOPIC) {
            try {
              await fetch('https://ntfy.sh/' + encodeURIComponent(env.NTFY_TOPIC), {
                method: 'POST',
                headers: { 'Title': `Deal closed: ${deal.ticker || deal.id}`, 'Tags': 'handshake' },
                body: closedEvidence,
              });
            } catch { /* push is best-effort */ }
          }
        } else {
          await env.BOARD_DB.prepare('UPDATE deals SET last_check=? WHERE id=?').bind(now, deal.id).run();
        }
      } catch (err) {
        status.errors.push(`${deal.id}: ${err.message}`);
      }
    }
    const cutoff = new Date(Date.now() - 21 * 86400e3).toISOString().slice(0, 10);
    const del = await env.BOARD_DB.prepare(
      "DELETE FROM deals WHERE status IN ('closed','terminated') AND COALESCE(close_date, substr(updated_at,1,10)) < ?"
    ).bind(cutoff).run();
    status.pruned = (del.meta && del.meta.changes) || 0;
  } catch (err) {
    status.errors.push(err.message);
  }
  if (env.SIGNAL_KV) {
    try { await env.SIGNAL_KV.put('deal-scan:last', JSON.stringify(status)); } catch { /* non-fatal */ }
  }
  return status;
}

// ── GET /stream (WebSocket upgrade)
// Live trade/quote relay. Browsers connect with wss://, send
// {"action":"subscribe","symbols":["AAPL",...]}, and receive Alpaca's raw
// messages relayed straight through. Backed by a single Durable Object
// (below) since most Alpaca plans allow only one concurrent connection —
// every tab shares it rather than each opening its own.
async function handleStream(request, env) {
    // WebSocket upgrades skip normal CORS preflight entirely, so this has
    // to be checked by hand — otherwise any site could open a connection
    // here and ride along on your one Alpaca connection.
    const origin = request.headers.get('Origin') || '';
    if (ALLOWED_ORIGIN !== '*' && origin !== ALLOWED_ORIGIN) {
      return json({ error: 'Origin not allowed' }, 403);
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return json({ error: 'Expected a WebSocket upgrade — connect with wss://, not https://' }, 426);
    }

    // Fixed name so every request lands on the same Durable Object instance,
    // sharing the same upstream Alpaca connection across all connected tabs.
    const id = env.ALPACA_STREAM.idFromName('singleton');
    const stub = env.ALPACA_STREAM.get(id);
    return stub.fetch(request);
}

// ── GET /bars?symbol=AAPL&start=YYYY-MM-DD&end=YYYY-MM-DD
// Historical daily bars for a single symbol, IEX feed, split-adjusted.
async function handleBars(url, env) {
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase().trim();
    const start = url.searchParams.get('start') || '';
    const end = url.searchParams.get('end') || '';

    if (!TICKER_RE.test(symbol)) {
      return json({ error: 'Invalid or missing symbol' }, 400);
    }
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      return json({ error: 'start and end must be YYYY-MM-DD' }, 400);
    }

    const alpacaUrl = new URL(`${ALPACA_BASE}/v2/stocks/${symbol}/bars`);
    alpacaUrl.searchParams.set('timeframe', '1Day');
    alpacaUrl.searchParams.set('start', start);
    alpacaUrl.searchParams.set('end', end);
    alpacaUrl.searchParams.set('adjustment', 'split'); // split-adjusted so long ranges aren't skewed by split events
    alpacaUrl.searchParams.set('feed', 'iex'); // no paid subscription required
    alpacaUrl.searchParams.set('limit', '1000');

    let upstream;
    try {
      upstream = await fetch(alpacaUrl.toString(), {
        headers: {
          'APCA-API-KEY-ID': env.APCA_API_KEY_ID,
          'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY,
        },
      });
    } catch (err) {
      return json({ error: 'Upstream fetch failed: ' + err.message }, 502);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return json({ error: `Alpaca returned HTTP ${upstream.status}`, detail: text.slice(0, 300) }, upstream.status);
    }

    const data = await upstream.json();
    return json({ symbol, bars: data.bars || [] });
}

// ── GET /movers?top=10
// Today's top gainers and losers, market-wide (stocks only). `top` is
// clamped to Alpaca's documented range of 1–50.
async function handleMovers(url, env) {
    let top = parseInt(url.searchParams.get('top') || '10', 10);
    if (!Number.isFinite(top)) top = 10;
    top = Math.max(1, Math.min(50, top));

    const alpacaUrl = new URL(`${ALPACA_BASE}/v1beta1/screener/stocks/movers`);
    alpacaUrl.searchParams.set('top', String(top));

    let upstream;
    try {
      upstream = await fetch(alpacaUrl.toString(), {
        headers: {
          'APCA-API-KEY-ID': env.APCA_API_KEY_ID,
          'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY,
        },
      });
    } catch (err) {
      return json({ error: 'Upstream fetch failed: ' + err.message }, 502);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return json({ error: `Alpaca returned HTTP ${upstream.status}`, detail: text.slice(0, 300) }, upstream.status);
    }

    const data = await upstream.json();
    return json({ gainers: data.gainers || [], losers: data.losers || [] });
}

// ── GET /actives?by=volume&top=10
// Today's most active symbols market-wide (stocks only), ranked by volume
// or trade count. `top` is clamped to Alpaca's documented range of 1–100.
async function handleActives(url, env) {
    const by = url.searchParams.get('by') === 'trades' ? 'trades' : 'volume';
    let top = parseInt(url.searchParams.get('top') || '10', 10);
    if (!Number.isFinite(top)) top = 10;
    top = Math.max(1, Math.min(100, top));

    const alpacaUrl = new URL(`${ALPACA_BASE}/v1beta1/screener/stocks/most-actives`);
    alpacaUrl.searchParams.set('by', by);
    alpacaUrl.searchParams.set('top', String(top));

    let upstream;
    try {
      upstream = await fetch(alpacaUrl.toString(), {
        headers: {
          'APCA-API-KEY-ID': env.APCA_API_KEY_ID,
          'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY,
        },
      });
    } catch (err) {
      return json({ error: 'Upstream fetch failed: ' + err.message }, 502);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return json({ error: `Alpaca returned HTTP ${upstream.status}`, detail: text.slice(0, 300) }, upstream.status);
    }

    const data = await upstream.json();
    return json({ most_actives: data.most_actives || [] });
}

// ── GET /insider-feed?start=0
// The live SEC Form 4 atom feed, market-wide. Passed through as raw XML —
// the frontend already knows how to parse this exact atom format, only the
// URL changes. Proxied because www.sec.gov's legacy endpoints don't
// reliably send CORS headers, and because SEC requires a real User-Agent
// that browser JS is never allowed to set.
// `start` lets the frontend page BACKWARD through the feed (100 entries per
// page) so it can cover a full 24-hour window instead of just the newest
// 100 filings.
async function handleInsiderFeed(url) {
    let start = parseInt(url.searchParams.get('start') || '0', 10);
    if (!Number.isFinite(start) || start < 0) start = 0;
    start = Math.min(2000, start);
    const feedUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=100&start=${start}&output=atom`;

    let upstream;
    try {
      upstream = await secFetch(feedUrl, { headers: { 'Accept': 'application/atom+xml' } });
    } catch (err) {
      return json({ error: 'Upstream fetch failed: ' + err.message }, 502);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return json({ error: `SEC returned HTTP ${upstream.status}`, detail: text.slice(0, 300) }, upstream.status);
    }

    const text = await upstream.text();
    return xml(text);
}

// ── GET /form4-batch?ids=CIK-ACCESSION,CIK-ACCESSION,...
// The atom feed only says "a Form 4 was filed" — the actual transaction
// (buy or sell, how many shares, at what price) lives inside each filing's
// ownershipDocument XML. This route fetches a batch of filings' complete
// submission text files from EDGAR and returns just the extracted XML for
// each, so the frontend can parse real transactions without making hundreds
// of cross-origin SEC requests itself.
// Each id is `cik-accession` where accession is the 18-digit accession
// number with dashes removed (both are parsed out of the atom feed's entry
// links by the frontend). Batches are capped so one call stays comfortably
// inside Workers' subrequest limit.
const FORM4_ID_RE = /^\d{1,10}-\d{18}$/;

async function handleForm4Batch(url, env) {
    const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return json({ error: 'ids required: comma-separated cik-accession pairs (accession as 18 digits, no dashes)' }, 400);
    if (ids.length > 20) return json({ error: 'Max 20 ids per batch' }, 400);
    for (const id of ids) {
      if (!FORM4_ID_RE.test(id)) return json({ error: 'Bad id: ' + id }, 400);
    }

    const results = await Promise.all(ids.map(async id => {
      const dash = id.indexOf('-');
      const cik = id.slice(0, dash);
      const acc = id.slice(dash + 1);
      const accDashed = `${acc.slice(0, 10)}-${acc.slice(10, 12)}-${acc.slice(12)}`;
      // The full-submission .txt contains every document in the filing,
      // including the ownershipDocument XML — one fetch per filing, no
      // directory listing needed.
      const txtUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc}/${accDashed}.txt`;
      try {
        const res = await secFetch(txtUrl, {}, env);
        if (!res.ok) return { id, error: 'HTTP ' + res.status };
        const text = await res.text();
        const startIdx = text.indexOf('<ownershipDocument');
        const endIdx = text.indexOf('</ownershipDocument>');
        if (startIdx === -1 || endIdx === -1) return { id, error: 'No ownershipDocument in filing' };
        return { id, xml: text.slice(startIdx, endIdx + '</ownershipDocument>'.length) };
      } catch (err) {
        return { id, error: err.message };
      }
    }));

    return json({ results });
}

// ── GET /cusip-batch?items=CUSIP~ISSUER NAME,CUSIP~ISSUER NAME,...
// Server-side CUSIP → ticker resolution with three layers, in order:
//   1. KV cache — every answer ever resolved is stored permanently
//      (CUSIPs don't change), so over time this route answers almost
//      everything instantly with zero upstream calls.
//   2. OpenFIGI (anonymous batch mapping) for cache misses.
//   3. Issuer-name matching against SEC's own company_tickers.json for
//      whatever OpenFIGI couldn't answer (or when it rate-limits, which
//      the anonymous tier does constantly — the exact reason the ticker
//      column used to render "—" everywhere when resolution ran in the
//      browser). company_tickers.json is ~10k names, refreshed daily
//      into KV, entirely SEC-side and never rate-limited in practice.
// Response: { tickers: { CUSIP: "AAPL" | null, ... } }  (null = tried
// everything and genuinely no match — safe for the client to cache).
const CUSIP_RE = /^[0-9A-Z]{8,9}$/;

// Normalize an issuer name for fuzzy matching: uppercase, strip punctuation
// and the corporate boilerplate 13F filers and SEC titles disagree on.
function cusipNormName(s) {
  return String(s || '').toUpperCase()
    .replace(/[.,'&\/()-]/g, ' ')
    .replace(/\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LP|L P|LLP|LLC|L L C|LTD|PLC|LIMITED|HOLDINGS|HLDGS|GROUP|GRP|TRUST|COM|CL A|CL B|CLASS A|CLASS B|NEW|DEL|ADR|ADS|SPONSORED|COMMON|STOCK|SHS|ORD)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function getSecNameIndex(env) {
  // Daily-cached map of normalized company title -> ticker.
  const cached = await env.SIGNAL_KV.get('sec-name-index', 'json');
  if (cached) return cached;
  const res = await secFetch('https://www.sec.gov/files/company_tickers.json', {}, env);
  if (!res.ok) return null;
  const data = await res.json();
  const index = {};
  for (const entry of Object.values(data)) {
    const norm = cusipNormName(entry.title);
    // First writer wins — company_tickers.json is ordered by market cap,
    // so ambiguous normalized names resolve to the larger company.
    if (norm && !index[norm]) index[norm] = entry.ticker;
  }
  await env.SIGNAL_KV.put('sec-name-index', JSON.stringify(index), { expirationTtl: 86400 });
  return index;
}

async function handleCusipBatch(url, env) {
    if (!env.SIGNAL_KV) return json({ error: 'SIGNAL_KV binding missing — redeploy with wrangler.toml present' }, 500);
    // Capped at 20 per call: each item can cost a KV read + a KV write, and
    // the free Workers plan allows 50 subrequests per invocation total.
    const items = (url.searchParams.get('items') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20)
      .map(raw => {
        const sep = raw.indexOf('~');
        const cusip = (sep === -1 ? raw : raw.slice(0, sep)).toUpperCase().trim();
        const name = sep === -1 ? '' : decodeURIComponent(raw.slice(sep + 1));
        return { cusip, name };
      })
      .filter(it => CUSIP_RE.test(it.cusip));
    if (!items.length) return json({ error: 'items required: comma-separated CUSIP~ISSUER NAME pairs' }, 400);

    const tickers = {};
    const misses = [];

    // Layer 1 — KV cache.
    await Promise.all(items.map(async it => {
      const hit = await env.SIGNAL_KV.get('cusip:' + it.cusip);
      if (hit !== null) tickers[it.cusip] = hit === '' ? null : hit;
      else misses.push(it);
    }));

    // Layer 2 — OpenFIGI for the misses (10 per request, its batch cap).
    const figiUnresolved = [];
    for (let i = 0; i < misses.length; i += 10) {
      const batch = misses.slice(i, i + 10);
      try {
        const res = await fetch('https://api.openfigi.com/v3/mapping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch.map(it => ({ idType: 'ID_CUSIP', idValue: it.cusip }))),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const results = await res.json();
        batch.forEach((it, j) => {
          const entry = results[j];
          let ticker = null;
          if (entry && Array.isArray(entry.data) && entry.data.length) {
            const match = entry.data.find(d => d.exchCode === 'US') || entry.data[0];
            ticker = match.ticker || null;
          }
          if (ticker) tickers[it.cusip] = ticker;
          else figiUnresolved.push(it); // let the name-match layer try before caching a null
        });
      } catch {
        // Rate-limited or down — push the whole batch to the name-match layer.
        figiUnresolved.push(...batch);
      }
    }

    // Layer 3 — SEC company-name matching for whatever's left.
    if (figiUnresolved.length) {
      const nameIndex = await getSecNameIndex(env).catch(() => null);
      for (const it of figiUnresolved) {
        let ticker = null;
        if (nameIndex && it.name) {
          const norm = cusipNormName(it.name);
          ticker = nameIndex[norm] || null;
          if (!ticker && norm.includes(' ')) {
            // Last resort: first two words — catches "APPLE COMPUTER" vs "APPLE".
            const short = norm.split(' ').slice(0, 2).join(' ');
            ticker = nameIndex[short] || null;
          }
        }
        tickers[it.cusip] = ticker;
      }
    }

    // Persist every fresh answer — including nulls (stored as '') so a
    // genuinely unlisted CUSIP (bonds, foreign, private) isn't re-tried on
    // every page load. CUSIPs are immutable; no TTL needed.
    await Promise.all(misses.map(it =>
      env.SIGNAL_KV.put('cusip:' + it.cusip, tickers[it.cusip] || '').catch(() => {})
    ));

    return json({ tickers });
}

// ── GET /sec-proxy?url=https://www.sec.gov/Archives/...
// General-purpose proxy for SEC EDGAR fetches (13F submission histories,
// filing directories, information-table XML). The frontend previously
// leaned on free public CORS proxies (allorigins, corsproxy.io, codetabs)
// for these because sec.gov/Archives sends no CORS headers — those free
// services are rate-limited and flaky, which is exactly why fund cards
// randomly failed to load. Routing through here is reliable, sends SEC the
// proper User-Agent, and keeps the public proxies as a fallback only.
// Strictly allowlisted to SEC hosts so this can't be used as an open proxy.
const SEC_PROXY_ALLOWED = [
  'https://www.sec.gov/Archives/',
  'https://www.sec.gov/cgi-bin/browse-edgar',
  'https://data.sec.gov/',
  'https://efts.sec.gov/', // EDGAR full-text search API (JSON)
];

async function handleSecProxy(url, env) {
    const target = url.searchParams.get('url') || '';
    if (!SEC_PROXY_ALLOWED.some(prefix => target.startsWith(prefix))) {
      return json({ error: 'Only SEC EDGAR URLs (www.sec.gov/Archives, browse-edgar, data.sec.gov) can be proxied' }, 400);
    }

    let upstream;
    try {
      upstream = await secFetch(target, {}, env);
    } catch (err) {
      return json({ error: 'Upstream fetch failed: ' + err.message }, 502);
    }

    const body = await upstream.arrayBuffer();
    const retryAfter = upstream.headers.get('Retry-After');
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
        ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
        ...corsHeaders(),
      },
    });
}

// ══════════════════════════════════════════════════════════════
// ALERT SCAN — cron-driven 13D watcher with KV dedupe + ntfy push
// ══════════════════════════════════════════════════════════════
// Mirrors the frontend's tiering: a brand-new 13D from a known activist is
// tier 3 (the classic setup), any new 13D or an activist's amendment is
// tier 2. Only tier-2+ filings alert, and each accession alerts exactly
// once (KV-deduped, 14-day TTL — far longer than the feed window).
// Workers have no DOMParser, so the atom feed is parsed with regexes; the
// format is stable enough that this is safe.
const ALERT_ACTIVIST_ROSTER = [
  'elliott', 'starboard', 'icahn', 'trian', 'valueact', 'pershing square',
  'third point', 'jana partners', 'ancora', 'engaged capital', 'sarissa',
  'sachem head', 'corvex', 'land & buildings', 'legion partners', 'politan',
  'browning west', 'engine capital', 'barington', 'irenic', 'impactive',
  'blackwells', 'soros', 'appaloosa', 'baupost', 'duquesne', 'berkshire'
];

// ══════════════════════════════════════════════════════════════
// 13D HISTORY — the fix for "Opportunities never shows anything"
// ══════════════════════════════════════════════════════════════
// Known-activist 13Ds happen a few times a week across the whole market;
// EDGAR's live feed only shows the last day or two. So a page that reads
// the live feed alone shows an empty ★ view on most days and forgets last
// week's Elliott filing entirely. Two mechanisms fix that:
//   1. The 30-minute alert cron already parses the 13D feed — it now also
//      appends everything it sees to a rolling KV history (12 months).
//   2. /sched13-history additionally backfills ~12 months of each roster
//      activist's 13D filings from EDGAR full-text search (efts.sec.gov),
//      a few activists per request until done. efts results include the
//      subject company's TICKER, which the atom feed never provides.
const SCHED13_HISTORY_KEY = 'sched13-history';
const SCHED13_BACKFILL_KEY = 'sched13-backfill-state';
const SCHED13_HISTORY_CAP = 900;
const SCHED13_MAX_AGE_DAYS = 365;
const BACKFILL_PER_CALL = 10; // efts queries per invocation, well under the 50-subrequest cap

// Search phrases for the backfill — full names, so a text search hits the
// filer block of their filings without drowning in incidental mentions.
const BACKFILL_QUERIES = [
  'Elliott Investment Management', 'Starboard Value', 'Icahn Carl C',
  'Trian Fund Management', 'ValueAct', 'Pershing Square', 'Third Point',
  'JANA Partners', 'Ancora', 'Engaged Capital', 'Sarissa Capital',
  'Sachem Head', 'Corvex Management', 'Land & Buildings', 'Legion Partners',
  'Politan Capital', 'Browning West', 'Engine Capital', 'Barington Capital',
  'Irenic Capital', 'Impactive Capital', 'Blackwells Capital',
  'Appaloosa', 'Baupost', 'Berkshire Hathaway', 'Duquesne Family Office',
  'Soros Fund Management',
];

// "ACME CORP (ACME) (CIK 0001234567)" -> { name, tickers[], cik }
function parseDisplayName(dn) {
  const m = String(dn || '').match(/^(.*?)(?:\s+\(([A-Z][A-Z0-9.,\s-]{0,40})\))?\s+\(CIK\s+(\d+)\)\s*$/);
  if (!m) return { name: String(dn || '').trim(), tickers: [], cik: null };
  const tickers = m[2] ? m[2].split(',').map(t => t.trim()).filter(t => /^[A-Z][A-Z0-9.-]{0,9}$/.test(t)) : [];
  return { name: m[1].trim(), tickers, cik: m[3] };
}

function eftsHitToRecord(src) {
  const names = (src.display_names || []).map(parseDisplayName);
  // The subject company is the entry that carries a ticker; if none does
  // (private/foreign subjects), fall back to the first entry.
  const subject = names.find(n => n.tickers.length) || names[0] || { name: '', tickers: [], cik: null };
  const filers = names.filter(n => n !== subject).map(n => n.name);
  const acc = String(src.adsh || '').replace(/-/g, '');
  if (!acc || !subject.cik) return null;
  return {
    acc,
    form: String(src.file_type || src.form || '').toUpperCase(),
    filed: src.file_date || '',
    link: `https://www.sec.gov/Archives/edgar/data/${parseInt(subject.cik, 10)}/${acc}/`,
    subject: subject.name,
    tickers: subject.tickers,
    filers,
  };
}

async function mergeSched13History(env, records) {
  if (!env.SIGNAL_KV || !records.length) return;
  const existing = (await env.SIGNAL_KV.get(SCHED13_HISTORY_KEY, 'json')) || [];
  const byAcc = new Map(existing.map(r => [r.acc, r]));
  for (const rec of records) {
    if (!rec || !rec.acc) continue;
    const prev = byAcc.get(rec.acc);
    if (!prev) byAcc.set(rec.acc, rec);
    else {
      if (rec.tickers && rec.tickers.length && !(prev.tickers || []).length) prev.tickers = rec.tickers;
      if (rec.kind && !prev.kind) { prev.kind = rec.kind; prev.flags = rec.flags; prev.pct = rec.pct; }
    }
  }
  const cutoff = Date.now() - SCHED13_MAX_AGE_DAYS * 86400e3;
  const merged = [...byAcc.values()]
    .filter(r => r.filed && new Date(r.filed).getTime() >= cutoff)
    .sort((a, b) => new Date(b.filed) - new Date(a.filed))
    .slice(0, SCHED13_HISTORY_CAP);
  await env.SIGNAL_KV.put(SCHED13_HISTORY_KEY, JSON.stringify(merged));
}

async function handleSched13History(env) {
  if (!env.SIGNAL_KV) {
    return json({ error: 'SIGNAL_KV binding missing — redeploy with wrangler.toml present' }, 501);
  }
  const state = (await env.SIGNAL_KV.get(SCHED13_BACKFILL_KEY, 'json')) || { idx: 0, done: false };

  // Advance the backfill a few activists per call until complete. Each
  // efts query returns that filer's most recent ~10 Schedule 13D filings —
  // for funds that file a handful of times a year, that IS their year.
  if (!state.done) {
    const batch = BACKFILL_QUERIES.slice(state.idx, state.idx + BACKFILL_PER_CALL);
    const collected = [];
    for (const q of batch) {
      try {
        const u = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"' + q + '"')}&forms=${encodeURIComponent('SCHEDULE 13D')}`;
        const res = await secFetch(u, { headers: { 'Accept': 'application/json' } }, env);
        if (!res.ok) continue; // skip this activist this round; a later full re-run can be forced by deleting the state key
        const data = await res.json();
        for (const hit of (data.hits?.hits || [])) {
          const rec = eftsHitToRecord(hit._source || {});
          if (rec) collected.push(rec);
        }
      } catch { /* one bad query shouldn't stall the whole backfill */ }
    }
    if (collected.length) await mergeSched13History(env, collected);
    state.idx = Math.min(state.idx + BACKFILL_PER_CALL, BACKFILL_QUERIES.length);
    state.done = state.idx >= BACKFILL_QUERIES.length;
    await env.SIGNAL_KV.put(SCHED13_BACKFILL_KEY, JSON.stringify(state));
  }

  const records = (await env.SIGNAL_KV.get(SCHED13_HISTORY_KEY, 'json')) || [];
  return json({
    records,
    backfill: { done: state.done, idx: state.idx, total: BACKFILL_QUERIES.length },
  });
}

// ── WHAT KIND OF 13D — mirrors classify13D() in index.html ────
// A 13D whose shares came from a securities purchase agreement /
// convertible / warrant package (typically with a 9.99% ownership blocker)
// is the COMPANY selling paper to the filer — dilution, not accumulation.
// Those never push an alert and are stored with kind='financing' so the
// dashboard demotes them without re-reading EDGAR. Keep this function
// byte-for-byte in sync with the frontend copy.
function classify13D(text) {
  const t = String(text || '');
  const count = re => (t.match(re) || []).length;
  const flags = [];
  const financingHits =
    count(/securities purchase agreement/gi) + count(/subscription agreement/gi) + count(/private placement/gi) +
    count(/\bPIPE\b/g) + count(/convertible (?:note|notes|debenture|debentures|preferred)/gi) + count(/\bdebentures?\b/gi) +
    count(/purchase warrants?\b/gi) + count(/registration rights agreement/gi) + count(/additional investment right/gi) +
    count(/conversion price/gi) + count(/stated value/gi) + count(/exercise price/gi);
  const blocker = /beneficial ownership (?:limitation|restriction|cap|blocker)/i.test(t) || /\b[49]\.99\s*%/.test(t) || /ownership (?:limitation|restriction) of [49]\.99/i.test(t);
  if (blocker) flags.push('9.99%-style ownership blocker');
  if (/securities purchase agreement|subscription agreement|private placement/i.test(t)) flags.push('shares issued by the company (SPA / private placement)');
  if (/convertible|debenture/i.test(t)) flags.push('convertible security');
  if (/\bwarrants?\b/i.test(t) && financingHits >= 2) flags.push('warrants');
  if (/additional investment right/i.test(t)) flags.push('further-investment right');
  const dealHits = count(/voting agreement/gi) + count(/support agreement/gi) + count(/agreement and plan of merger/gi) + count(/merger agreement/gi) + count(/tender offer/gi);
  const intentHits = count(/nominat(?:e|ion|ing|ed)/gi) + count(/proxy (?:contest|solicitation|fight|statement)/gi) +
    count(/strategic (?:alternatives|review)/gi) + count(/sale of the (?:issuer|company)/gi) + count(/board (?:composition|representation|refresh|seats?)/gi) +
    count(/letter to the (?:board|issuer|company)/gi) + count(/maximiz(?:e|ing) (?:shareholder|stockholder) value/gi) + count(/undervalued/gi) +
    count(/unsolicited/gi) + count(/proposal to acquire/gi) + count(/going.private/gi) + count(/special meeting/gi);
  const openMarketHits = count(/open[- ]market/gi);
  const affiliate = /(?:director|officer|chairman|chief executive officer|founder|president) of the (?:issuer|company)/i.test(t) ||
    /serves? as (?:a |the )?(?:director|chairman|chief executive)/i.test(t) || /employment agreement/i.test(t);
  if (affiliate) flags.push('filer is a director/officer/founder of the issuer');
  if (dealHits) flags.push('voting/merger agreement');
  if (intentHits >= 2) flags.push('stated activist intent');
  if (openMarketHits) flags.push('open-market purchases');
  const strongFinancing = /securities purchase agreement|subscription agreement|private placement/i.test(t) && /convertible|debenture|warrant|preferred/i.test(t);
  let kind = 'plain';
  if (strongFinancing || financingHits >= 4 || (blocker && financingHits >= 1)) kind = 'financing';
  else if (dealHits >= 2) kind = 'deal';
  else if (intentHits >= 2) kind = 'activist';
  else if (openMarketHits >= 1 && !affiliate) kind = 'accumulation';
  else if (affiliate || blocker) kind = 'affiliate';
  return { kind, flags, blocker, affiliate, openMarket: openMarketHits > 0, intent: intentHits >= 2 };
}

function parse13DPercent(text) {
  const tagHits = [...text.matchAll(/<[^>/]*[Pp]ercent[^>]*>\s*([\d.]+)/g)]
    .map(x => parseFloat(x[1])).filter(v => v > 0 && v <= 100);
  if (tagHits.length) return Math.max(...tagHits);
  const pm = text.match(/[Pp]ercent of class[\s\S]{0,300}?([\d.]+)\s*%/);
  return pm ? parseFloat(pm[1]) : null;
}

// Read one 13D's full submission text and classify it. Cached in KV per
// accession so each filing is read at most once across scans.
async function readSched13(env, rec) {
  const m = (rec.link || '').match(/\/data\/(\d+)\/(\d{18})\//);
  if (!m) return null;
  const key = 'sched13-read:' + rec.acc;
  if (env.SIGNAL_KV) {
    try { const c = await env.SIGNAL_KV.get(key, 'json'); if (c) return c; } catch { /* fall through */ }
  }
  const dashed = `${m[2].slice(0, 10)}-${m[2].slice(10, 12)}-${m[2].slice(12)}`;
  const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(m[1], 10)}/${m[2]}/${dashed}.txt`;
  const res = await secFetch(url, {}, env);
  if (!res.ok) throw new Error('EDGAR ' + res.status + ' reading ' + rec.acc);
  const text = await res.text();
  const cls = classify13D(text);
  const out = { kind: cls.kind, flags: cls.flags, pct: parse13DPercent(text), at: new Date().toISOString() };
  if (env.SIGNAL_KV) {
    try { await env.SIGNAL_KV.put(key, JSON.stringify(out), { expirationTtl: 60 * 86400 }); } catch { /* non-fatal */ }
  }
  return out;
}

async function runAlertScan(env) {
  const status = { ran: new Date().toISOString(), scanned: 0, alerted: 0, suppressedFinancing: 0, errors: [] };
  try {
    const feedUrl = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SCHEDULE+13D&company=&dateb=&owner=include&count=100&output=atom';
    const res = await secFetch(feedUrl, { headers: { 'Accept': 'application/atom+xml' } }, env);
    if (!res.ok) throw new Error('SEC feed HTTP ' + res.status);
    const text = await res.text();

    // Merge the (Subject)/(Filed by) entry pairs by accession number.
    const byAcc = new Map();
    for (const entryMatch of text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const entry = entryMatch[1];
      const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const href = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
      const updated = (entry.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || '';
      const m = href.match(/\/data\/(\d+)\/(\d{18})\//);
      if (!m) continue;
      const acc = m[2];
      const decoded = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const tm = decoded.match(/^(.*?)\s+-\s+(.*?)\s+\((\d{5,10})\)\s+\((Subject|Filed by)\)/i);
      const form = (tm ? tm[1] : decoded.split(' - ')[0] || '').trim().toUpperCase();
      const name = tm ? tm[2].trim() : decoded.trim();
      const role = tm ? tm[4] : '';
      const rec = byAcc.get(acc) || { acc, form, filed: updated, link: href, subject: '', filers: [] };
      if (/subject/i.test(role)) rec.subject = name;
      else if (name && !rec.filers.includes(name)) rec.filers.push(name);
      if (form) rec.form = form;
      byAcc.set(acc, rec);
    }
    // EDGAR no longer honors the type= filter on getcurrent (verified
    // 2026-08-28: the "SCHEDULE 13D" feed is ~95% 424B2/497K junk). Keep
    // only real 13D/13G forms so junk never enters history or tiering.
    for (const [acc, r] of byAcc) if (!/^SCHEDULE 13[DG]/.test(r.form)) byAcc.delete(acc);
    status.scanned = byAcc.size;

    // Read every tier-2+ filing's text ONCE (KV-cached) and classify it
    // before it can alert or enter history — a financing 13D is stored as
    // such and never pushes. Capped per scan to respect the subrequest
    // budget; anything left is picked up next run.
    let reads = 0;
    const readings = {};
    for (const rec of byAcc.values()) {
      const filerNames = rec.filers.join(' | ').toLowerCase();
      const activist = ALERT_ACTIVIST_ROSTER.find(a => filerNames.includes(a)) || null;
      const isNewD = rec.form === 'SCHEDULE 13D';
      const isD = rec.form.startsWith('SCHEDULE 13D');
      rec.tier = (isNewD && activist) ? 3 : (isNewD || (isD && activist)) ? 2 : isD ? 1 : 0;
      rec.activist = activist;
      if (rec.tier < 2 || reads >= 15) continue;
      try {
        const cached = env.SIGNAL_KV ? await env.SIGNAL_KV.get('sched13-read:' + rec.acc, 'json') : null;
        if (!cached) reads++;
        readings[rec.acc] = cached || await readSched13(env, rec);
      } catch (err) { status.errors.push(err.message); }
    }

    // Persist everything this scan saw into the rolling 13D history — this
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

    for (const rec of byAcc.values()) {
      const { tier, activist } = rec;
      const isNewD = rec.form === 'SCHEDULE 13D';
      if (tier < 2) continue;
      const reading = readings[rec.acc];
      if (!reading) continue; // unread this scan (budget) — alert decision waits for the next run

      // Dedupe: alert each accession exactly once.
      if (env.SIGNAL_KV) {
        const seen = await env.SIGNAL_KV.get('alerted:' + rec.acc);
        if (seen) continue;
        await env.SIGNAL_KV.put('alerted:' + rec.acc, '1', { expirationTtl: 14 * 86400 });
      }

      // The metric fix: a financing 13D is not an accumulation signal. It
      // is recorded (history carries kind='financing') but never pushed.
      if (reading.kind === 'financing') { status.suppressedFinancing++; continue; }

      status.alerted++;
      if (env.NTFY_TOPIC) {
        const kindTag = reading.kind === 'activist' ? ' · stated activist intent'
          : reading.kind === 'accumulation' ? ' · open-market buying'
          : reading.kind === 'affiliate' ? ' · insider-affiliated filer'
          : reading.kind === 'deal' ? ' · deal-linked' : '';
        const title = tier >= 3
          ? `★ ACTIVIST 13D: ${rec.subject || 'unknown target'}`
          : `13D ${isNewD ? 'filed' : 'amended'}: ${rec.subject || 'unknown target'}`;
        const body = `${rec.form} — filed by ${rec.filers.join(', ') || 'unknown'}${activist ? ` (roster match: ${activist})` : ''}${reading.pct != null ? ` — ${reading.pct.toFixed(1)}% stake` : ''}${kindTag}\n${rec.link}`;
        try {
          await fetch('https://ntfy.sh/' + encodeURIComponent(env.NTFY_TOPIC), {
            method: 'POST',
            headers: { 'Title': title.slice(0, 200), 'Priority': tier >= 3 ? 'high' : 'default', 'Tags': tier >= 3 ? 'rotating_light' : 'page_facing_up' },
            body,
          });
        } catch (err) {
          status.errors.push('ntfy push failed: ' + err.message);
        }
      }
    }
  } catch (err) {
    status.errors.push(err.message);
  }
  if (env.SIGNAL_KV) {
    try { await env.SIGNAL_KV.put('alerts:last', JSON.stringify(status)); } catch { /* non-fatal */ }
  }
  return status;
}

// ── GET /alerts-status
// The last scheduled scan's summary — when it ran, how many filings it
// scanned, how many alerts fired, any errors. Sanity-check the cron here.
async function handleAlertsStatus(env) {
    if (!env.SIGNAL_KV) {
      return json({ error: 'SIGNAL_KV binding missing — add the kv_namespaces block in wrangler.toml and redeploy' }, 501);
    }
    const last = await env.SIGNAL_KV.get('alerts:last');
    return json({
      configured: { kv: true, ntfy: !!env.NTFY_TOPIC },
      lastRun: last ? JSON.parse(last) : null,
      note: last ? undefined : 'No scan recorded yet — the cron runs every 30 minutes after deploy; you can also confirm the [triggers] block exists in wrangler.toml.'
    });
}

// ── GET /fundamentals?symbol=AAPL
// Basic company fundamentals for the stock deep-dive page — EBITDA, market
// cap, P/E, revenue per share, margins, 52-week range — via Finnhub's free
// `stock/metric` endpoint (metric=all). Needs its own key because Alpaca's
// Market Data API has no fundamentals of any kind. Returns a plain "not
// configured" error (not a 5xx crash) when FINNHUB_API_KEY isn't set, so
// the frontend can show a clear explanation instead of a broken chart.
async function handleFundamentals(url, env) {
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase().trim();
    if (!TICKER_RE.test(symbol)) {
      return json({ error: 'Invalid or missing symbol' }, 400);
    }
    if (!env.FINNHUB_API_KEY) {
      return json({ error: 'not_configured', message: 'Fundamentals need a free Finnhub API key. Get one at finnhub.io/register, then run: wrangler secret put FINNHUB_API_KEY' }, 501);
    }

    const finnhubUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${env.FINNHUB_API_KEY}`;
    let upstream;
    try {
      upstream = await fetch(finnhubUrl);
    } catch (err) {
      return json({ error: 'Upstream fetch failed: ' + err.message }, 502);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return json({ error: `Finnhub returned HTTP ${upstream.status}`, detail: text.slice(0, 300) }, upstream.status);
    }

    const data = await upstream.json();
    const m = data.metric || {};
    // Trimmed down to what the deep-dive page actually shows — Finnhub's
    // full payload has ~150 fields, most of it noise for this use case.
    return json({
      symbol,
      marketCapM: m.marketCapitalization ?? null,          // millions USD
      ebitdaM: m.ebitda ?? null,                            // millions USD (may be null for some symbols/tiers)
      peTTM: m.peTTM ?? null,
      epsTTM: m.epsTTM ?? null,
      revenuePerShareTTM: m.revenuePerShareTTM ?? null,
      grossMarginTTM: m.grossMarginTTM ?? null,
      netProfitMarginTTM: m.netProfitMarginTTM ?? null,
      week52High: m['52WeekHigh'] ?? null,
      week52Low: m['52WeekLow'] ?? null,
      beta: m.beta ?? null,
    });
}

// ══════════════════════════════════════════════════════════════
// DURABLE OBJECT — AlpacaStreamRelay
// ══════════════════════════════════════════════════════════════
// Holds Alpaca's one allowed WebSocket connection and fans live
// trades/quotes out to however many browser tabs are connected. Always
// addressed by the same fixed name ("singleton" — see handleStream above)
// so every /stream request lands on this same instance and shares the one
// upstream connection, rather than each tab trying to open its own and
// getting a 406 "connection limit exceeded" from Alpaca.
//
// Uses the plain (non-hibernating) WebSocket API rather than the
// Hibernation API — simpler and more predictable, at the cost of the
// Durable Object staying active (and billed) the whole time at least one
// tab is connected. Since this only runs while someone's actually looking
// at the page, that's a reasonable trade for a personal dashboard; it's
// not something to leave streaming unattended 24/7.
export class AlpacaStreamRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
    this.alpacaSocket = null;
    this.alpacaAuthed = false;
    this.subscribedSymbols = new Set();
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.acceptClient(server);
    this.ensureAlpacaConnection();

    return new Response(null, { status: 101, webSocket: client });
  }

  acceptClient(ws) {
    ws.accept();
    this.clients.add(ws);

    // So a tab that joins an already-live relay doesn't sit there thinking
    // it's still connecting.
    try {
      ws.send(JSON.stringify({ T: 'relay_status', alpacaAuthed: this.alpacaAuthed }));
    } catch { /* ignore — client may already be gone */ }

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg && msg.action === 'subscribe' && Array.isArray(msg.symbols)) {
        this.addSubscriptions(msg.symbols);
      }
    });

    const cleanup = () => this.clients.delete(ws);
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  addSubscriptions(symbols) {
    let added = false;
    for (const raw of symbols) {
      const sym = String(raw).toUpperCase().trim();
      if (TICKER_RE.test(sym) && !this.subscribedSymbols.has(sym)) {
        this.subscribedSymbols.add(sym);
        added = true;
      }
    }
    if (!added) return;
    if (this.alpacaAuthed) {
      this.sendAlpacaSubscribe();
    } else {
      this.ensureAlpacaConnection();
    }
  }

  async ensureAlpacaConnection() {
    if (this.alpacaSocket) {
      const state = this.alpacaSocket.readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    }

    // Outbound WebSocket via fetch()+Upgrade header — the long-documented,
    // reliable way Workers make client WebSocket connections. Note: https://
    // here, not wss:// — the Upgrade header is what triggers the protocol
    // switch, fetch() itself only accepts http(s) schemes.
    let resp;
    try {
      resp = await fetch('https://stream.data.alpaca.markets/v2/iex', {
        headers: { Upgrade: 'websocket' },
      });
    } catch (err) {
      this.broadcastError('Could not reach Alpaca stream: ' + err.message);
      this.scheduleReconnect();
      return;
    }

    const ws = resp.webSocket;
    if (!ws) {
      this.broadcastError('Alpaca did not accept the WebSocket upgrade (HTTP ' + resp.status + ')');
      this.scheduleReconnect();
      return;
    }

    ws.accept();
    this.alpacaSocket = ws;
    this.alpacaAuthed = false;

    ws.addEventListener('message', (event) => this.handleAlpacaMessage(event));
    ws.addEventListener('close', () => {
      this.alpacaAuthed = false;
      this.alpacaSocket = null;
      this.broadcast(JSON.stringify({ T: 'relay_status', alpacaAuthed: false }));
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      this.alpacaAuthed = false;
    });

    ws.send(JSON.stringify({
      action: 'auth',
      key: this.env.APCA_API_KEY_ID,
      secret: this.env.APCA_API_SECRET_KEY,
    }));
  }

  handleAlpacaMessage(event) {
    let messages;
    try {
      messages = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!Array.isArray(messages)) messages = [messages];

    for (const msg of messages) {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        this.alpacaAuthed = true;
        this.reconnectAttempts = 0;
        this.broadcast(JSON.stringify({ T: 'relay_status', alpacaAuthed: true }));
        if (this.subscribedSymbols.size) this.sendAlpacaSubscribe();
      }
      if (msg.T === 'error') {
        this.broadcastError(`Alpaca stream error ${msg.code}: ${msg.msg}`);
      }
    }

    // Relay the raw message straight through — trades ("t"), quotes ("q"),
    // and anything else Alpaca sends, unmodified. The frontend picks out
    // what it cares about.
    this.broadcast(event.data);
  }

  sendAlpacaSubscribe() {
    if (!this.alpacaSocket || this.alpacaSocket.readyState !== WebSocket.OPEN) return;
    const symbols = [...this.subscribedSymbols];
    this.alpacaSocket.send(JSON.stringify({
      action: 'subscribe',
      trades: symbols,
      quotes: symbols,
    }));
  }

  scheduleReconnect() {
    // Don't bother reconnecting if nobody's listening — this is what keeps
    // the Durable Object from running (and billing) unattended.
    if (!this.clients.size || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.clients.size) this.ensureAlpacaConnection();
    }, delay);
  }

  broadcast(data) {
    for (const ws of this.clients) {
      try { ws.send(data); } catch { this.clients.delete(ws); }
    }
  }

  broadcastError(message) {
    this.broadcast(JSON.stringify({ T: 'relay_error', msg: message }));
  }
}
