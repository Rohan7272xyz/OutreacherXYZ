const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = process.env.SHEET_ID || 'YOUR_SHEET_ID';
const CREDS_PATH = path.join(__dirname, 'credentials.json');

const COMPANIES = [
  {
    name: 'CoinFluence',
    leadsTab: 'CoinFluence',
    sentTab: 'Sent- CoinFluence',
  },
  {
    name: 'CreatorPredict',
    leadsTab: 'CreatorPredict',
    sentTab: 'Sent - CreatorPredict',
  },
];

class PipelineFilter {
  constructor() {
    this.sheets = null;
  }

  async init() {
    const auth = new google.auth.GoogleAuth({
      keyFile: CREDS_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });
    console.log('[Filter] Connected to Google Sheets');
  }

  async getSentEmails(sentTab) {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: sentTab + '!A:A',
      });
      const emails = res.data.values ? res.data.values.flat() : [];
      return new Set(emails.map(e => (e || '').toLowerCase()).filter(e => e && e !== 'email'));
    } catch (err) {
      return new Set();
    }
  }

  async getLeadsData(leadsTab) {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: leadsTab + '!A:G',
      });
      return res.data.values || [];
    } catch (err) {
      return [];
    }
  }

  async clearAndWriteLeads(leadsTab, rows) {
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: leadsTab + '!A:Z',
    });

    if (rows.length > 0) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: leadsTab + '!A1',
        valueInputOption: 'RAW',
        resource: { values: rows },
      });
    }
  }

  async filterCompany(company) {
    console.log('\n=== Filtering ' + company.name + ' ===');

    const sentEmails = await this.getSentEmails(company.sentTab);
    console.log('[' + company.name + '] Found ' + sentEmails.size + ' previously sent emails');

    const rows = await this.getLeadsData(company.leadsTab);
    console.log('[' + company.name + '] Found ' + rows.length + ' rows in ' + company.leadsTab);

    if (rows.length === 0) {
      console.log('[' + company.name + '] Nothing to filter');
      return;
    }

    const header = rows[0];
    const dataRows = rows.slice(1);

    const seenEmails = new Set();
    const filteredRows = [header];

    let duplicatesRemoved = 0;
    let alreadySentRemoved = 0;

    for (const row of dataRows) {
      const email = (row[0] || '').toLowerCase().trim();

      if (!email) continue;

      if (seenEmails.has(email)) {
        duplicatesRemoved++;
        continue;
      }

      if (sentEmails.has(email)) {
        alreadySentRemoved++;
        continue;
      }

      seenEmails.add(email);
      filteredRows.push(row);
    }

    console.log('[' + company.name + '] Results:');
    console.log('  - Duplicates removed: ' + duplicatesRemoved);
    console.log('  - Already sent removed: ' + alreadySentRemoved);
    console.log('  - Clean rows remaining: ' + (filteredRows.length - 1));

    await this.clearAndWriteLeads(company.leadsTab, filteredRows);
    console.log('[' + company.name + '] ' + company.leadsTab + ' tab updated');
  }

  async run() {
    console.log('[Filter] Starting filter process...');

    for (const company of COMPANIES) {
      await this.filterCompany(company);
    }

    console.log('\n[Filter] All companies filtered');
  }
}

(async () => {
  const filter = new PipelineFilter();
  await filter.init();
  await filter.run();
})();
