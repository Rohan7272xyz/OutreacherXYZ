const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = process.env.SHEET_ID || 'YOUR_SHEET_ID';
const CREDS = path.join(__dirname, '..', 'credentials.json');

async function clearLeadTabs() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const tabs = ['CoinFluence', 'CreatorPredict'];

  for (const tab of tabs) {
    // Get current data to check row count
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: tab + '!A:A',
    });

    const rowCount = res.data.values ? res.data.values.length : 1;

    if (rowCount > 1) {
      // Clear all rows except header
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: tab + '!A2:G' + rowCount,
      });
      console.log('[Clear] ' + tab + ': Cleared ' + (rowCount - 1) + ' rows');
    } else {
      console.log('[Clear] ' + tab + ': Already empty');
    }
  }

  console.log('[Clear] Lead tabs ready for fresh scraping');
}

clearLeadTabs().catch(err => {
  console.error('[Clear] Error:', err.message);
  process.exit(1);
});
