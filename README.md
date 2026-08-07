[README.md](https://github.com/user-attachments/files/30809614/README.md)
# Signal-Desk

Public Disclosure Tracker — surfaces what corporate insiders, hedge funds, and activists are legally required to disclose, stacks the streams that agree, and remembers what the rolling feeds forget.

## What's on the board

- **Confluence Board** (always visible, top of page) — names where multiple independent disclosure streams point at the same company: insider cluster + 13D + fund stake change beats any single signal. Multi-stream names get a score multiplier and a glowing card.
- **Top Signals** — largest disclosed transactions, ranked by dollar value × freshness decay × quality weights (insider role: CFO > CEO > director; cluster premium; first-buy bonus).
- **13D Watch** — live Schedule 13D/13G feed with activist-roster matching, opportunity tiers, parsed stake percentages, **13G→13D escalation flags** and **stake deltas vs the prior filing** (both from local memory).
- **Campaigns** — per-company activist campaign timelines: stake built → escalation → proxy fight (PREC14A/DEFC14A/DFAN14A and variants), with approximate activist track records for orientation. History accumulates in your browser.
- **Insider Trades** — open-market Form 4 purchases only (code P; grants/RSU/tax plumbing excluded), with **cluster detection** (2+ distinct insiders buying the same name) and price context (bought into weakness vs at highs).
- **Hedge Funds (13F)** — live-parsed 13F information tables for a curated fund list, diffed quarter-over-quarter; fund detail page ranks new positions by **% of book (conviction)** and flags concentrated managers.
- **Screener → ★ Activist Targets** — scores your watchlist + signal-surfaced names against the activist-target profile: 1Y underperformance vs SPY, drawdown, cheap P/E, gross-vs-net margin gap, influenceable size.
- **Alerts** — the Cloudflare Worker runs a cron every 30 minutes, tiers new 13Ds, dedupes via KV, and pushes tier-2+ filings to your phone via [ntfy.sh](https://ntfy.sh). Check `/alerts-status` on the Worker for the last scan.

The old Congress tab was removed — its upstream dataset (house-stock-watcher) stopped updating.

## Local memory

Feeds only show a rolling window. The app remembers what it has seen in `localStorage`: 13G→13D escalations, stake percentages across amendments, campaign timelines, and insider first-buy baselines. It gets smarter the longer you use it.

## Deploy

1. `npx wrangler deploy` in this directory (wrangler.toml already binds the Durable Object, the `signal-desk-memory` KV namespace, and the 30-minute alert cron).
2. Secrets (once): `wrangler secret put APCA_API_KEY_ID`, `wrangler secret put APCA_API_SECRET_KEY` (Alpaca, free), optionally `FINNHUB_API_KEY` (free — enables valuation/margins in the target screener) and `NTFY_TOPIC` (a hard-to-guess ntfy.sh topic — enables push alerts; subscribe to the same topic in the ntfy app).
3. Static pages (index.html / fund.html / stock.html) deploy anywhere (GitHub Pages). `ALPACA_PROXY_URL` in each file should point at the Worker.

Not investment advice. Everything shown is public, legally mandated disclosure.
