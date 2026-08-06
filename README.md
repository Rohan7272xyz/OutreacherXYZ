# OutreacherXYZ

Creator-outreach automation: scrape Instagram + TikTok creator profiles, collect the emails into a Google Sheet, then (optionally) run a templated outreach pipeline from that sheet via the Gmail API.

## 🚀 Quick start (no terminal needed)

1. **Install Node.js** — grab the LTS version from [nodejs.org](https://nodejs.org/en/download) and run the installer.
2. **Double-click the launcher** — `Start OutreacherXYZ.command` on Mac, `Start OutreacherXYZ.bat` on Windows.
   *(Mac: if it's blocked the first time, right-click the file → Open → Open.)*
3. Your browser opens **http://localhost:4242** with a setup wizard that installs everything, walks you through Google access, and connects your sheet. After that it's a dashboard: press Start, log in when the browser window pops up, and watch leads flow into your sheet.

Everything below this line is for people who want to poke at the internals.

---

## Layout

| Folder | What it is |
|---|---|
| `app/` | The local control panel: a zero-dependency Node web server (`app/server.js`, port 4242) serving the setup wizard + dashboard GUI. It installs the scraper's dependencies, stores your sheet config, launches/stops the scrapers, and streams their logs live. |
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
   (`scraper/index.html` is the older standalone status page kept from the original project. The control panel in `app/` replaces it; if you still want the standalone one, replace `YOUR_SHEET_ID` inside it too.)

3. **Install deps**
   ```bash
   cd scraper && npm install && npx playwright install chromium
   cd ../pipeline && npm install
   ```

## Running the scraper

```bash
cd scraper
npm run ig                          # Instagram
npm run tt                          # TikTok
npm run tt -- --min 10000 --max 250000
npm run validate                    # re-verify collected emails
npm test                            # unit tests
npm run test:e2e                    # drives the engine against a local fake feed
node run-resilient.js instagram     # supervisor: auto-restarts on crash
```

### Settings

Everything is an environment variable, so the control panel can set it without editing code.

| Variable | Default | What it does |
|---|---|---|
| `SHEET_ID` | — | Target spreadsheet. Unset = leads go to `output/leads-backup.csv` only. |
| `LEADS_TAB` | `crosscheck` | Tab new leads are appended to. |
| `MIN_FOLLOWERS` / `MAX_FOLLOWERS` | `0` / none | Follower gate. Both bounds are enforced. |
| `HEADLESS` | `false` | Headed by default — you need to see the browser to log in. |
| `PERSIST_VISITED` | `true` | Remember checked creators across restarts (`output/visited-*.json`). |
| `BLACKOUT_ENABLED` | `false` | Optional nightly pause, for a machine whose network is cut on a schedule. |
| `BLACKOUT_START` / `BLACKOUT_END` / `BLACKOUT_TZ` | `01:15` / `04:15` / `America/New_York` | When that pause runs. |

### How the engine works

Each run keeps **two tabs**: one parked on the feed, one opened per profile and closed after. The feed tab never navigates, so after checking a creator the scraper advances with a single keypress instead of reloading the feed and skipping past everything it already saw. Leads are appended to `output/leads-backup.csv` the instant they're found — the Sheets write is a batched, retried background step, so an API hiccup can't lose a lead. De-duplication happens in memory against a set loaded once at startup rather than re-reading the sheet for every address.

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
