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
 * - Exposes six operations: historical daily bars for a single symbol
 *   (/bars), today's top gainers/losers (/movers), today's most active
 *   symbols by volume (/actives), the live SEC Form 4 insider filing feed
 *   (/insider-feed), the House Stock Watcher congressional trade dataset
 *   (/congress-feed), and a live trade/quote WebSocket relay (/stream).
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
 * 5. Edit ALLOWED_ORIGIN below to match your actual site origin
 *    (e.g. "https://yourusername.github.io"), then redeploy.
 * 6. Copy the workers.dev URL wrangler prints out and paste it into
 *    ALPACA_PROXY_URL near the top of index.html's <script>.
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
const ALLOWED_ORIGIN = 'https://yourusername.github.io';

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

    // These two are public data, no Alpaca credentials involved — check them
    // before the credential gate below.
    if (url.pathname === '/insider-feed') return handleInsiderFeed();
    if (url.pathname === '/congress-feed') return handleCongressFeed();

    if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) {
      return json({ error: 'Proxy is not configured with Alpaca credentials yet' }, 500);
    }

    if (url.pathname === '/bars') return handleBars(url, env);
    if (url.pathname === '/movers') return handleMovers(url, env);
    if (url.pathname === '/actives') return handleActives(url, env);
    if (url.pathname === '/stream') return handleStream(request, env);

    return json({ error: 'Not found. Only /bars, /movers, /actives, /insider-feed, /congress-feed, and /stream are exposed by this proxy.' }, 404);
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

// ── GET /insider-feed
// The live SEC Form 4 atom feed, market-wide. Passed through as raw XML —
// the frontend already knows how to parse this exact atom format, only the
// URL changes. Proxied because www.sec.gov's legacy endpoints don't
// reliably send CORS headers, and because SEC requires a real User-Agent
// that browser JS is never allowed to set.
async function handleInsiderFeed() {
    const feedUrl = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=100&output=atom';

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

// ── GET /congress-feed
// The House Stock Watcher public dataset, passed through as-is (a raw JSON
// array) — the frontend's Array.isArray() check works unchanged, only the
// URL changes. Proxied so a missing/inconsistent CORS policy on the S3
// bucket can never block this in the browser.
async function handleCongressFeed() {
    const feedUrl = 'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json';

    let upstream;
    try {
      upstream = await fetch(feedUrl, { headers: { 'User-Agent': SEC_USER_AGENT } });
    } catch (err) {
      return json({ error: 'Upstream fetch failed: ' + err.message }, 502);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return json({ error: `House Stock Watcher returned HTTP ${upstream.status}`, detail: text.slice(0, 300) }, upstream.status);
    }

    const data = await upstream.json();
    return json(data);
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
