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
const ALLOWED_ORIGIN = 'https://cjosh4toyotas-stack.github.io';

// SEC's fair-access policy requires every request to identify a real
// contact — browsers block JS from setting User-Agent, which is exactly
// why /insider-feed and /congress-feed have to be proxied server-side here
// rather than fetched directly from the page. EDIT THIS to something real.
const SEC_USER_AGENT = 'Signal Desk contact@example.com';

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
  async fetch(request, env) {
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
    if (url.pathname === '/form4-batch') return handleForm4Batch(url);
    if (url.pathname === '/sec-proxy') return handleSecProxy(url);
    if (url.pathname === '/fundamentals') return handleFundamentals(url, env);
    if (url.pathname === '/alerts-status') return handleAlertsStatus(env);

    if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) {
      return json({ error: 'Proxy is not configured with Alpaca credentials yet' }, 500);
    }

    if (url.pathname === '/bars') return handleBars(url, env);
    if (url.pathname === '/movers') return handleMovers(url, env);
    if (url.pathname === '/actives') return handleActives(url, env);
    if (url.pathname === '/stream') return handleStream(request, env);

    return json({ error: 'Not found. Only /bars, /movers, /actives, /insider-feed, /form4-batch, /sec-proxy, /fundamentals, /alerts-status, and /stream are exposed by this proxy.' }, 404);
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
  },
};

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
      upstream = await fetch(feedUrl, {
        headers: {
          'User-Agent': SEC_USER_AGENT,
          'Accept': 'application/atom+xml',
        },
      });
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

async function handleForm4Batch(url) {
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
        const res = await fetch(txtUrl, { headers: { 'User-Agent': SEC_USER_AGENT } });
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

async function handleSecProxy(url) {
    const target = url.searchParams.get('url') || '';
    if (!SEC_PROXY_ALLOWED.some(prefix => target.startsWith(prefix))) {
      return json({ error: 'Only SEC EDGAR URLs (www.sec.gov/Archives, browse-edgar, data.sec.gov) can be proxied' }, 400);
    }

    let upstream;
    try {
      upstream = await fetch(target, { headers: { 'User-Agent': SEC_USER_AGENT } });
    } catch (err) {
      return json({ error: 'Upstream fetch failed: ' + err.message }, 502);
    }

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
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

async function runAlertScan(env) {
  const status = { ran: new Date().toISOString(), scanned: 0, alerted: 0, errors: [] };
  try {
    const feedUrl = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SCHEDULE+13D&company=&dateb=&owner=include&count=100&output=atom';
    const res = await fetch(feedUrl, { headers: { 'User-Agent': SEC_USER_AGENT, 'Accept': 'application/atom+xml' } });
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
    status.scanned = byAcc.size;

    for (const rec of byAcc.values()) {
      const filerNames = rec.filers.join(' | ').toLowerCase();
      const activist = ALERT_ACTIVIST_ROSTER.find(a => filerNames.includes(a)) || null;
      const isNewD = rec.form === 'SCHEDULE 13D';
      const isD = rec.form.startsWith('SCHEDULE 13D');
      const tier = (isNewD && activist) ? 3 : (isNewD || (isD && activist)) ? 2 : isD ? 1 : 0;
      if (tier < 2) continue;

      // Dedupe: alert each accession exactly once.
      if (env.SIGNAL_KV) {
        const seen = await env.SIGNAL_KV.get('alerted:' + rec.acc);
        if (seen) continue;
        await env.SIGNAL_KV.put('alerted:' + rec.acc, '1', { expirationTtl: 14 * 86400 });
      }

      status.alerted++;
      if (env.NTFY_TOPIC) {
        const title = tier >= 3
          ? `★ ACTIVIST 13D: ${rec.subject || 'unknown target'}`
          : `13D ${isNewD ? 'filed' : 'amended'}: ${rec.subject || 'unknown target'}`;
        const body = `${rec.form} — filed by ${rec.filers.join(', ') || 'unknown'}${activist ? ` (roster match: ${activist})` : ''}\n${rec.link}`;
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
