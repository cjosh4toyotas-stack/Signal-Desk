[README.md](https://github.com/user-attachments/files/31068648/README.md)
# Signal Desk — daily refresh on your Claude subscription (no API bill)

Runs the Signal Desk board refresh outside the Claude app with **no pay-per-token cost**: GitHub Actions (free tier) runs Claude Code headless, authenticated with your existing Claude subscription via a long-lived OAuth token. Claude Code's built-in WebSearch/WebFetch handles the research, and it writes to the D1 database with `curl` against Cloudflare's REST API.

What it costs: nothing new. It draws from your Claude plan's usage allowance (the same pool your app sessions use) and GitHub's free Actions minutes (~5-15 min/run, well within the 2,000/month free tier for private repos).

## Setup (~10 minutes)

1. On any machine with Claude Code installed, run:

   ```bash
   claude setup-token
   ```

   Approve in the browser; copy the token it prints. This token authenticates with your Pro/Max subscription, lasts one year, and can only make model requests. (Renew it annually the same way.)

2. Create a **private** GitHub repo and push these files.

3. In the repo: Settings → Secrets and variables → Actions → add three secrets:
   - `CLAUDE_CODE_OAUTH_TOKEN` — the token from step 1
   - `CLOUDFLARE_API_TOKEN` — Cloudflare dashboard → My Profile → API Tokens → create token with **Account → D1 → Edit**
   - `CLOUDFLARE_ACCOUNT_ID` — shown in the Cloudflare dashboard sidebar

4. Done. Runs weekdays 11:00 UTC; trigger manually anytime from the Actions tab. The run log ends with the refresh summary.

## Reliability notes

- GitHub emails you automatically if a run fails.
- The OAuth token expires after one year — calendar a reminder to rerun `claude setup-token`.
- If a run lands while you're heavily using Claude elsewhere, it shares your plan's rate limits; the workflow's cron hour is easy to move to a quiet time.
- Once this is live, **pause the Cowork scheduled task** so two writers don't touch the board at once.

## Alternative: run it on your own computer instead

If you'd rather not use GitHub at all, the same thing works as a local cron/Task Scheduler job on any machine that's on at refresh time — same `claude -p "$(cat PROMPT.md)"` command, same env vars. GitHub Actions is just more reliable because it doesn't depend on your machine being awake.
