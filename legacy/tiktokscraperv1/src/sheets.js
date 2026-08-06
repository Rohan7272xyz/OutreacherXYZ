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
      const [res1, res2] = await Promise.all([
        this.sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: 'CoinFluence!A:A',
        }),
        this.sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: 'CreatorPredict!A:A',
        }),
      ]);
      const emails1 = res1.data.values ? res1.data.values.flat() : [];
      const emails2 = res2.data.values ? res2.data.values.flat() : [];
      const allEmails = [...emails1, ...emails2].map(e => e?.toLowerCase());
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

    // Route based on follower count: 250k+ -> CoinFluence, 10k-250k -> CreatorPredict
    const sheetName = followers >= 250000 ? 'CoinFluence' : 'CreatorPredict';

    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: sheetName + '!A:F',
        valueInputOption: 'RAW',
        resource: {
          values: [[email.toLowerCase(), username, followers, this.deviceName, new Date().toISOString(), 'tiktok']],
        },
      });
      console.log('[Sheets] Added to ' + sheetName + ': ' + email + ' (' + followers.toLocaleString() + ' followers)');
      return true;
    } catch (err) {
      console.error('[Sheets] Failed to add:', err.message);
      return false;
    }
  }
}

module.exports = { SheetsSync };
