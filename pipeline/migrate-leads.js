const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = process.env.SHEET_ID || 'YOUR_SHEET_ID';
const CREDS_PATH = path.join(__dirname, 'credentials.json');

async function migrate() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('=== Migration: CoinFluence -> CreatorPredict ===\n');

  // Get CoinFluence data
  const cfRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'CoinFluence!A:G',
  });
  const cfRows = cfRes.data.values || [];
  console.log('[CoinFluence] Found ' + cfRows.length + ' rows');

  // Get existing CreatorPredict emails to avoid duplicates
  const cpRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'CreatorPredict!A:A',
  });
  const cpEmails = new Set((cpRes.data.values || []).flat().map(e => (e || '').toLowerCase()));
  console.log('[CreatorPredict] Found ' + cpEmails.size + ' existing emails');

  const header = cfRows[0];
  const dataRows = cfRows.slice(1);

  const keepInCF = [header];
  const moveToCP = [];
  let skippedDupes = 0;

  for (const row of dataRows) {
    const email = (row[0] || '').toLowerCase();
    const followers = parseInt(row[2]) || 0;

    if (followers >= 250000) {
      // Keep in CoinFluence
      keepInCF.push(row);
    } else {
      // Move to CreatorPredict (if not duplicate)
      if (cpEmails.has(email)) {
        skippedDupes++;
      } else {
        moveToCP.push(row);
        cpEmails.add(email); // prevent dupes within migration
      }
    }
  }

  console.log('\n=== Results ===');
  console.log('Keep in CoinFluence (250k+): ' + (keepInCF.length - 1));
  console.log('Move to CreatorPredict (<250k): ' + moveToCP.length);
  console.log('Skipped (already in CreatorPredict): ' + skippedDupes);

  if (moveToCP.length === 0) {
    console.log('\nNothing to migrate!');
    return;
  }

  // Confirm before proceeding
  console.log('\nProceeding with migration...\n');

  // Clear and rewrite CoinFluence with only 250k+ leads
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'CoinFluence!A:Z',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'CoinFluence!A1',
    valueInputOption: 'RAW',
    resource: { values: keepInCF },
  });
  console.log('[CoinFluence] Updated with ' + (keepInCF.length - 1) + ' rows');

  // Append moved rows to CreatorPredict
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'CreatorPredict!A:G',
    valueInputOption: 'RAW',
    resource: { values: moveToCP },
  });
  console.log('[CreatorPredict] Added ' + moveToCP.length + ' rows');

  console.log('\n=== Migration Complete ===');
}

migrate().catch(console.error);
