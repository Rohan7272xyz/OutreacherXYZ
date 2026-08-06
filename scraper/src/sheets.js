const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = process.env.SHEET_ID || 'YOUR_SHEET_ID';
const CREDS_PATH = path.join(__dirname, '..', 'credentials.json');

class SheetsSync {
  constructor(deviceName = 'default') {
    this.deviceName = deviceName;
    this.sheets = null;
    this.initialized = false;
  }

  async init() {
    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: CREDS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });
      this.initialized = true;
      await this.ensureStatusSheet();
      console.log('[Sheets] Connected');
      return true;
    } catch (err) {
      console.error('[Sheets] Failed:', err.message);
      return false;
    }
  }

  async ensureStatusSheet() {
    try {
      await this.sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Status!A1',
      });
    } catch (err) {
      // Create Status tab if it doesn't exist
      try {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          resource: {
            requests: [{
              addSheet: { properties: { title: 'Status' } }
            }]
          }
        });
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: 'Status!A1:E1',
          valueInputOption: 'RAW',
          resource: { values: [['device', 'status', 'last_heartbeat', 'cooldown_end', 'expected_next']] },
        });
        console.log('[Sheets] Created Status tab');
      } catch (e) {
        // Tab might already exist
      }
    }
  }

  async updateStatus(status, cooldownEnd = null) {
    if (!this.initialized) return false;
    try {
      const now = new Date();
      
      // Calculate expected_next based on status
      let expectedNext;
      if (status === 'cooldown' || status === 'stuck-loop') {
        // Should resume within 5 min after cooldown ends
        expectedNext = cooldownEnd ? new Date(cooldownEnd.getTime() + 5 * 60 * 1000) : null;
      } else if (status === 'break') {
        // Breaks are up to 30 min
        expectedNext = new Date(now.getTime() + 35 * 60 * 1000);
      } else {
        // Scraping - should heartbeat within 10 min
        expectedNext = new Date(now.getTime() + 10 * 60 * 1000);
      }

      // Check if device row exists
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'Status!A:A',
      });
      
      const rows = res.data.values || [];
      let rowIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][0] === this.deviceName) {
          rowIndex = i + 1; // 1-indexed for Sheets
          break;
        }
      }

      const rowData = [
        this.deviceName,
        status,
        now.toISOString(),
        cooldownEnd ? cooldownEnd.toISOString() : '',
        expectedNext ? expectedNext.toISOString() : ''
      ];

      if (rowIndex > 0) {
        // Update existing row
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: 'Status!A' + rowIndex + ':E' + rowIndex,
          valueInputOption: 'RAW',
          resource: { values: [rowData] },
        });
      } else {
        // Append new row
        await this.sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: 'Status!A:E',
          valueInputOption: 'RAW',
          resource: { values: [rowData] },
        });
      }
      
      console.log('[Sheets] Status: ' + status + (rowIndex > 0 ? ' (updated)' : ' (new)'));
      return true;
    } catch (err) {
      console.error('[Sheets] Status failed:', err.message);
      return false;
    }
  }

  async isDuplicate(email) {
    if (!this.initialized) return false;
    try {
      // Check all tabs for duplicates: crosscheck, CoinFluence, CreatorPredict, and sent tabs
      const [res1, res2, res3, res4, res5] = await Promise.all([
        this.sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: 'crosscheck!A:A',
        }),
        this.sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: 'CoinFluence!A:A',
        }),
        this.sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: 'CreatorPredict!A:A',
        }),
        this.sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: "'Sent- CoinFluence'!A:A",
        }),
        this.sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: "'Sent - CreatorPredict'!A:A",
        }),
      ]);
      const emails1 = res1.data.values ? res1.data.values.flat() : [];
      const emails2 = res2.data.values ? res2.data.values.flat() : [];
      const emails3 = res3.data.values ? res3.data.values.flat() : [];
      const emails4 = res4.data.values ? res4.data.values.flat() : [];
      const emails5 = res5.data.values ? res5.data.values.flat() : [];
      const allEmails = [...emails1, ...emails2, ...emails3, ...emails4, ...emails5].map(e => e?.toLowerCase());
      return allEmails.includes(email.toLowerCase());
    } catch (err) {
      return false;
    }
  }

  async addEmail(email, username, followers) {
    if (!this.initialized) return false;
    if (await this.isDuplicate(email)) {
      console.log('[Sheets] Skipping duplicate: ' + email);
      return false;
    }

    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'crosscheck!A:B',
        valueInputOption: 'RAW',
        resource: {
          values: [[email.toLowerCase(), username]],
        },
      });
      console.log('[Sheets] Added to crosscheck: ' + email + ' (@' + username + ')');
      return true;
    } catch (err) {
      console.error('[Sheets] Failed to add:', err.message);
      return false;
    }
  }
}

module.exports = { SheetsSync };
