// Ensures the target Google Sheet has every tab the scraper + pipeline expect.
// Run with cwd = scraper/, SHEET_ID in env. Prints a single JSON result line.
const path = require('path');
const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;
const CREDS_PATH = path.join(__dirname, '..', 'credentials.json');

const TABS = [
  { title: 'crosscheck', headers: ['email', 'username'] },
  { title: 'CreatorPredict', headers: ['email', 'username'] },
  { title: 'CoinFluence', headers: ['email', 'username'] },
  { title: 'Sent- CoinFluence', headers: ['email', 'username', 'sent_at'] },
  { title: 'Sent - CreatorPredict', headers: ['email', 'username', 'sent_at'] },
  { title: 'Status', headers: ['device', 'status', 'last_heartbeat', 'cooldown_end', 'expected_next'] },
];

async function main() {
  if (!SHEET_ID || SHEET_ID === 'YOUR_SHEET_ID') throw new Error('No sheet connected yet');
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = meta.data.sheets.map((s) => s.properties.title);
  const created = [];
  for (const tab of TABS) {
    if (existing.includes(tab.title)) continue;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { requests: [{ addSheet: { properties: { title: tab.title } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${tab.title}'!A1`,
      valueInputOption: 'RAW',
      resource: { values: [tab.headers] },
    });
    created.push(tab.title);
  }
  console.log(JSON.stringify({ ok: true, title: meta.data.properties.title, created }));
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
