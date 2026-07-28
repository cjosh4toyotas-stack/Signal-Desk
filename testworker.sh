#!/usr/bin/env bash
# Signal Desk — Worker connectivity test
# ---------------------------------------
# Checks whether your deployed Cloudflare Worker (alpaca-proxy-worker.js)
# is reachable and correctly configured, by hitting all five routes it
# exposes and printing what comes back.
#
# HOW TO USE:
# 1. Edit WORKER_URL below — replace the placeholder with your real
#    deployed Worker URL (the one `wrangler deploy` printed when you ran
#    it, e.g. https://signal-desk-alpaca-proxy.yourname.workers.dev).
#    No trailing slash.
# 2. Run it:
#      bash test-worker.sh
#    (or: chmod +x test-worker.sh && ./test-worker.sh)
# 3. Read the output. Each section either shows real data (that route
#    works) or an error message that says exactly what's wrong.

WORKER_URL="https://YOUR-WORKER-SUBDOMAIN.workers.dev"   # <-- EDIT THIS

if [[ "$WORKER_URL" == *"YOUR-WORKER-SUBDOMAIN"* ]]; then
  echo "Edit WORKER_URL at the top of this script first — it's still the placeholder."
  exit 1
fi

check() {
  local label="$1"
  local url="$2"
  local body_file
  body_file=$(mktemp)

  echo ""
  echo "── ${label} ──"
  echo "GET ${url}"

  http_code=$(curl -s -o "$body_file" -w "%{http_code}" "$url")
  echo "HTTP ${http_code}"

  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool "$body_file" 2>/dev/null | head -20 || head -c 500 "$body_file"
  else
    head -c 500 "$body_file"
  fi
  echo ""
  rm -f "$body_file"
}

check "Historical bars (AAPL)" \
  "${WORKER_URL}/bars?symbol=AAPL&start=2026-07-01&end=2026-07-28"

check "Top movers" \
  "${WORKER_URL}/movers?top=5"

check "Most active" \
  "${WORKER_URL}/actives?top=5"

check "Insider filing feed (SEC Form 4)" \
  "${WORKER_URL}/insider-feed"

check "Congress trade feed" \
  "${WORKER_URL}/congress-feed"

echo ""
echo "Done. If any section above shows an error instead of data, paste that section back and I can tell you exactly what to fix."
