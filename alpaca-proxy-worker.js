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
 * - Exposes three read-only operations: historical daily bars for a single
 *   symbol (/bars), today's top gainers/losers (/movers), and today's most
 *   active symbols by volume (/actives).
 * - Does NOT expose Alpaca's Trading API (no orders, no account access) —
 *   this only talks to data.alpaca.markets, not the trading endpoints.
 * - Validates and allowlists inputs so it can't be turned into an open
 *   proxy for arbitrary Alpaca calls.
 * - Locks feed to 'iex' for bars (included on all Alpaca accounts, no
 *   market data subscription required) so this can't accidentally rack up
 *   SIP feed charges. The screener endpoints (/movers, /actives) are SIP-based
 *   on Alpaca's side regardless — that's how Alpaca serves them, no feed
 *   parameter to set.
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
 * 5. Edit ALLOWED_ORIGIN below to match your actual site origin
 *    (e.g. "https://yourusername.github.io"), then redeploy.
 * 6. Copy the workers.dev URL wrangler prints out and paste it into
 *    ALPACA_PROXY_URL near the top of index.html's <script>.
 *
 * Get Alpaca API keys (free, paper or live account both work for market
 * data) at https://app.alpaca.markets/ under "API Keys".
 */

// ── EDIT THIS to your deployed site's origin. "*" works for testing but
// means ANY website could call your proxy (they'd still be rate-limited
// by your Alpaca account, but it's safer to lock this down once you know
// your real domain).
const ALLOWED_ORIGIN = 'https://yourusername.github.io';

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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);

    if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) {
      return json({ error: 'Proxy is not configured with Alpaca credentials yet' }, 500);
    }

    if (url.pathname === '/bars') return handleBars(url, env);
    if (url.pathname === '/movers') return handleMovers(url, env);
    if (url.pathname === '/actives') return handleActives(url, env);

    return json({ error: 'Not found. Only /bars, /movers, and /actives are exposed by this proxy.' }, 404);
  },
};

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
