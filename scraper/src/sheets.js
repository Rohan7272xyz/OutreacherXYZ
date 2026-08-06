const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { config } = require('./config');
const { withRetry, sleep } = require('./lib/util');

const CREDS_PATH = path.join(__dirname, '..', 'credentials.json');

// Tabs scanned once at startup to seed the in-memory dedupe set.
const DEDUPE_TABS = [
  'crosscheck', 'CoinFluence', 'CreatorPredict',
  "'Sent- CoinFluence'", "'Sent - CreatorPredict'",
];

class SheetsSync {
  constructor(deviceName = 'default') {
    this.deviceName = deviceName;
    this.sheetId = config.sheetId;
    this.leadsTab = config.leadsTab;
    this.sheets = null;
    this.initialized = false;
    this.knownEmails = new Set();
    this.statusRow = null;         // cached row index; avoids a read per heartbeat
    this.lastStatusWrite = 0;
    this.pendingRows = [];         // buffered appends, flushed together
    this.flushTimer = null;
    this.backupPath = path.join(config.outputDir, 'leads-backup.csv');
  }

  log(msg) {
    console.log('[Sheets] ' + msg);
  }

  async init() {
    if (!this.sheetId) {
      this.log('No SHEET_ID configured — leads will be saved locally only');
      return false;
    }
    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: CREDS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });
      await this.ensureStatusSheet();
      await this.loadKnownEmails();
      this.initialized = true;
      this.log('Connected');
      return true;
    } catch (err) {
      this.log('Failed: ' + err.message + ' — leads will be saved locally only');
      return false;
    }
  }

  // One batched read covering every tab, instead of one read per tab per email.
  async loadKnownEmails() {
    try {
      const res = await withRetry(() => this.sheets.spreadsheets.values.batchGet({
        spreadsheetId: this.sheetId,
        ranges: DEDUPE_TABS.map((t) => `${t}!A:A`),
      }));
      for (const range of res.data.valueRanges || []) {
        for (const row of range.values || []) {
          const email = (row[0] || '').toLowerCase().trim();
          if (email && email !== 'email') this.knownEmails.add(email);
        }
      }
      this.log(`Loaded ${this.knownEmails.size} known emails for de-duplication`);
    } catch (err) {
      this.log('Could not preload existing emails: ' + err.message);
    }
  }

  async ensureStatusSheet() {
    try {
      await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: 'Status!A1',
      });
    } catch (err) {
      try {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.sheetId,
          resource: { requests: [{ addSheet: { properties: { title: 'Status' } } }] },
        });
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range: 'Status!A1:E1',
          valueInputOption: 'RAW',
          resource: { values: [['device', 'status', 'last_heartbeat', 'cooldown_end', 'expected_next']] },
        });
        this.log('Created Status tab');
      } catch (e) {
        // Another device created it concurrently; nothing to do.
      }
    }
  }

  // In-memory: no API call. The set is seeded at startup and kept current as we add.
  isDuplicate(email) {
    return this.knownEmails.has(String(email).toLowerCase().trim());
  }

  async addEmail(email, username, followers) {
    const clean = String(email).toLowerCase().trim();
    if (this.isDuplicate(clean)) {
      this.log('Skipping duplicate: ' + clean);
      return false;
    }
    this.knownEmails.add(clean);
    this.appendBackup(clean, username, followers);

    // The lead is captured either way; the sheet write is the optional half.
    if (!this.initialized) return true;
    this.pendingRows.push([clean, username]);
    this.scheduleFlush();
    this.log('Queued: ' + clean + ' (@' + username + ')');
    return true;
  }

  // Leads are written to disk the moment they're found, so a crash or an API
  // outage can never lose one.
  appendBackup(email, username, followers) {
    try {
      fs.mkdirSync(path.dirname(this.backupPath), { recursive: true });
      if (!fs.existsSync(this.backupPath)) {
        fs.writeFileSync(this.backupPath, 'email,username,followers,found_at\n');
      }
      fs.appendFileSync(
        this.backupPath,
        `${email},${username},${followers === null ? '' : followers},${new Date().toISOString()}\n`
      );
    } catch (err) {
      this.log('Local backup failed: ' + err.message);
    }
  }

  scheduleFlush() {
    if (this.pendingRows.length >= 10) return this.flush();
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 20000);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.initialized || this.pendingRows.length === 0) return;
    const rows = this.pendingRows.splice(0, this.pendingRows.length);
    try {
      await withRetry(() => this.sheets.spreadsheets.values.append({
        spreadsheetId: this.sheetId,
        range: `${this.leadsTab}!A:B`,
        valueInputOption: 'RAW',
        resource: { values: rows },
      }), { onRetry: (e, n) => this.log(`Append retry ${n}: ${e.message}`) });
      this.log(`Wrote ${rows.length} lead${rows.length === 1 ? '' : 's'} to ${this.leadsTab}`);
    } catch (err) {
      this.log('Append failed after retries: ' + err.message + ' (kept in local backup)');
    }
  }

  async updateStatus(status, cooldownEnd = null) {
    if (!this.initialized) return false;
    // Heartbeats more than once a minute tell us nothing new.
    const now = Date.now();
    const isTransition = status !== this.lastStatus;
    if (!isTransition && now - this.lastStatusWrite < 60000) return true;

    try {
      const nowDate = new Date();
      let expectedNext;
      if (status === 'cooldown' || status === 'stuck-loop') {
        expectedNext = cooldownEnd ? new Date(cooldownEnd.getTime() + 5 * 60 * 1000) : null;
      } else if (status === 'break') {
        expectedNext = new Date(now + 35 * 60 * 1000);
      } else {
        expectedNext = new Date(now + 10 * 60 * 1000);
      }

      const rowData = [
        this.deviceName,
        status,
        nowDate.toISOString(),
        cooldownEnd ? cooldownEnd.toISOString() : '',
        expectedNext ? expectedNext.toISOString() : '',
      ];

      // Resolve our row once, then write straight to it on later heartbeats.
      if (this.statusRow === null) {
        const res = await withRetry(() => this.sheets.spreadsheets.values.get({
          spreadsheetId: this.sheetId,
          range: 'Status!A:A',
        }));
        const rows = res.data.values || [];
        const idx = rows.findIndex((r) => r[0] === this.deviceName);
        this.statusRow = idx >= 0 ? idx + 1 : 0;
      }

      if (this.statusRow > 0) {
        await withRetry(() => this.sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range: `Status!A${this.statusRow}:E${this.statusRow}`,
          valueInputOption: 'RAW',
          resource: { values: [rowData] },
        }));
      } else {
        const res = await withRetry(() => this.sheets.spreadsheets.values.append({
          spreadsheetId: this.sheetId,
          range: 'Status!A:E',
          valueInputOption: 'RAW',
          resource: { values: [rowData] },
        }));
        const updated = res.data.updates && res.data.updates.updatedRange;
        const m = updated && updated.match(/!A(\d+)/);
        this.statusRow = m ? Number(m[1]) : null;
      }

      this.lastStatus = status;
      this.lastStatusWrite = now;
      return true;
    } catch (err) {
      this.log('Status failed: ' + err.message);
      this.statusRow = null; // re-resolve next time
      return false;
    }
  }

  async close() {
    await this.flush();
    await sleep(0);
  }
}

module.exports = { SheetsSync };
