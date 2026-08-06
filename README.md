# OutreacherXYZ

Creator-outreach automation: scrape Instagram + TikTok creator profiles, collect the emails into a Google Sheet, then (optionally) run a templated outreach pipeline from that sheet via the Gmail API.

## Layout

| Folder | What it is |
|---|---|
| `scraper/` | The unified IG + TikTok scraper ("ScraperUltra"). Playwright-driven browser that walks profiles, extracts public emails, routes them by follower count, and syncs rows into a Google Sheet. Includes a status dashboard (`index.html`) and an email watchdog (`alerts/`). |
| `pipeline/` | Outreach sender. Reads leads from the sheet, sends templated emails through the Gmail API per "company" profile, moves sent rows to a Sent tab. `daily-pipeline.js` chains filter → validate → send. |
| `legacy/tiktokscraperv1/` | The original standalone TikTok scraper the unified one grew out of. Kept for reference; you probably want `scraper/` instead. |

## Setup

1. **Google Cloud project**
   - Create a service account, enable the **Sheets API**, download its JSON key to `scraper/credentials.json` (copy `scraper/credentials.example.json` for the shape). Share your Google Sheet with the service account's email.
   - For the sender: create an OAuth "Desktop app" client with the **Gmail API** enabled, save it as `pipeline/oauth-creds.json` (see `pipeline/oauth-creds.example.json`), then run `node pipeline/gmail-auth.js` once to mint `pipeline/gmail-token.json`.

2. **Sheet ID** — every script reads `SHEET_ID` from the environment (falls back to the `YOUR_SHEET_ID` placeholder):
   ```bash
   export SHEET_ID=<the long id from your sheet's URL>
   ```
   The dashboard is static, so also replace `YOUR_SHEET_ID` inside `scraper/index.html`.

3. **Install deps**
   ```bash
   cd scraper && npm install && npx playwright install chromium
   cd ../pipeline && npm install
   ```

## Running the scraper

```bash
cd scraper
npm run ig            # Instagram
npm run tt            # TikTok
npm run ig:parental   # resilient runner: auto-pauses during a 1–4 AM wifi blackout window
npm run validate      # re-verify collected emails
```

Follower-count routing (which tab a lead lands in) lives in the platform files under `scraper/src/platforms/`.

## Running the outreach pipeline

Edit the `COMPANIES` array in `pipeline/send.js` first — it holds the from-address, sheet tabs, subject and email body templates. Then:

```bash
node pipeline/test-send.js    # one test email to yourself
node pipeline/daily-pipeline.js
```

## Alerts watchdog (optional)

`scraper/alerts/email-alerts.js` polls the sheet's device-status tab and emails you if a scraper box goes quiet. Configure via env:

```bash
export ALERT_GMAIL=you@gmail.com
export ALERT_APP_PASSWORD='xxxx xxxx xxxx xxxx'   # a Gmail app password, not your real one
```

## Notes

- Nothing in this repo ships with credentials; all `credentials.json` / `oauth-creds*.json` / `gmail-token*.json` files are gitignored — keep it that way.
- Scraping and cold outreach are subject to each platform's ToS and applicable email law (CAN-SPAM etc.). Use judgment and your own accounts.
