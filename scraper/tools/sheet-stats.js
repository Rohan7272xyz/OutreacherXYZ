// Reads lead counts + device status from the sheet. Prints a single JSON line.
// Run with cwd = scraper/, SHEET_ID in env.
const path = require('path');
const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;
const CREDS_PATH = path.join(__dirname, '..', 'credentials.json');

async function countRows(sheets, range) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
    const rows = res.data.values || [];
    if (rows.length && String(rows[0][0]).toLowerCase() === 'email') return rows.length - 1;
    return rows.length;
  } catch (err) {
    return null;
  }
}

async function main() {
  if (!SHEET_ID || SHEET_ID === 'YOUR_SHEET_ID') throw new Error('No sheet connected yet');
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const [crosscheck, creatorPredict, coinFluence, sentCF, sentCP] = await Promise.all([
    countRows(sheets, 'crosscheck!A:A'),
    countRows(sheets, 'CreatorPredict!A:A'),
    countRows(sheets, 'CoinFluence!A:A'),
    countRows(sheets, "'Sent- CoinFluence'!A:A"),
    countRows(sheets, "'Sent - CreatorPredict'!A:A"),
  ]);

  let devices = [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Status!A2:E' });
    devices = (res.data.values || []).map((r) => ({
      device: r[0] || '',
      status: r[1] || '',
      lastHeartbeat: r[2] || '',
    }));
  } catch (err) {
    // Status tab may not exist yet
  }

  const sent = (sentCF || 0) + (sentCP || 0);
  console.log(JSON.stringify({ ok: true, leads: { crosscheck, creatorPredict, coinFluence, sent }, devices }));
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
