# Signal Desk — universe gate patch (2026-09-16)

What changes:
- Hard universe gate on EVERY stream (13D, insider, 13F, proxy fights, deals): NYSE/Nasdaq listing, $2+ price,
  $250M+ market cap, $1M+/day traded. Unknown is not a pass. Fails never score, never alert, never get a card.
- New "Filtered" tab: everything held out, with the reason and the filing link.
- 13D reading: new "issuance" kind (dividends/PIK/debt/fees paid in stock), filer-at-issuer's-address insider test,
  open-market buying under $250K is token, sub-dollar price flag. financing / issuance / consideration / affiliate = 0, not a discount.
- Worker: /universe route (SEC company_tickers_exchange.json + XBRL frames shares × Alpaca close + 20-day $ volume,
  KV-cached), 13D alert scan resolves subject → ticker, runs the gate, and pushes only through it.
  History rows now carry ticker + gate verdict so the dashboard never has to guess.
- Worker and dashboard classifier are byte-identical again (test enforces it).

Apply (fresh pull, from the repo root):
    cd ~/Desktop/Signal-Desk && git pull
    python3 ~/Downloads/signal-desk-gate-patch/apply.py
    node signal-metrics-test.mjs && node worker-alert-test.mjs && node secfetch-test.mjs
    npx wrangler deploy
    git add -A && git commit -m "Universe gate: hard floor for every stream, Filtered tab, 13D issuance/insider/token rules" && git push

Or skip the scripts and upload the already-patched files from signal-desk-patched.zip via GitHub web
(index.html, alpaca-proxy-worker.js, signal-metrics-test.mjs, worker-alert-test.mjs, test/fixtures.mjs),
then git pull + npx wrangler deploy on the Mac.

Thresholds live in one place: `const UNIVERSE = {...}` near the top of the universe section in alpaca-proxy-worker.js.
Change them there and redeploy; the dashboard reads the rules off the route.
First /universe call after deploy is slow (~5 s: it pulls three SEC frames files once, then caches a day).
