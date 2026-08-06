const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SHEET_CREDS = path.join(__dirname, 'credentials.json');
const SHEET_ID = process.env.SHEET_ID || 'YOUR_SHEET_ID';

const COMPANIES = [
  {
    name: 'CoinFluence',
    oauthCreds: path.join(__dirname, 'oauth-creds.json'),
    tokenPath: path.join(__dirname, 'gmail-token.json'),
    sentTab: 'Sent- CoinFluence',
  },
  {
    name: 'CreatorPredict',
    oauthCreds: path.join(__dirname, 'oauth-creds-creatorpredict.json'),
    tokenPath: path.join(__dirname, 'gmail-token-creatorpredict.json'),
    sentTab: 'Sent - CreatorPredict',
  },
];

async function getGmailClient(oauthCreds, tokenPath) {
  const creds = JSON.parse(fs.readFileSync(oauthCreds));
  const tokens = JSON.parse(fs.readFileSync(tokenPath));
  const { client_id, client_secret } = creds.installed;

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
  oauth2Client.setCredentials(tokens);

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SHEET_CREDS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function extractRecipients(gmail, companyName) {
  const recipients = new Set();
  let pageToken = null;
  let totalMessages = 0;

  console.log('[' + companyName + '] Fetching sent emails...');

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['SENT'],
      maxResults: 500,
      pageToken,
    });

    const messages = res.data.messages || [];
    totalMessages += messages.length;
    console.log('[' + companyName + '] Processing batch... (' + totalMessages + ' messages so far)');

    for (const msg of messages) {
      try {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['To'],
        });

        const toHeader = detail.data.payload.headers.find(h => h.name === 'To');
        if (toHeader) {
          const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
          const emails = toHeader.value.match(emailRegex) || [];
          emails.forEach(e => recipients.add(e.toLowerCase()));
        }
      } catch (err) {
        // Skip failed messages
      }
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log('[' + companyName + '] Found ' + recipients.size + ' unique recipients from ' + totalMessages + ' sent emails');
  return Array.from(recipients);
}

async function writeToSentSheet(sheets, emails, sentTab, companyName) {
  let existing = new Set();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sentTab + '!A:A',
    });
    existing = new Set((res.data.values || []).flat().map(e => e.toLowerCase()));
  } catch (err) {
    // Tab might not exist or be empty
  }

  const newEmails = emails.filter(e => !existing.has(e));
  console.log('[' + companyName + '] ' + existing.size + ' already in ' + sentTab + ', adding ' + newEmails.length + ' new');

  if (newEmails.length === 0) {
    console.log('[' + companyName + '] Nothing new to add');
    return;
  }

  const rows = newEmails.map(email => [email, '', '', new Date().toISOString(), 'imported']);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: sentTab + '!A2:E',
    valueInputOption: 'RAW',
    resource: { values: rows },
  });

  console.log('[' + companyName + '] Added ' + newEmails.length + ' emails to ' + sentTab);
}

async function processCompany(sheets, company) {
  console.log('\n=== ' + company.name + ' ===');

  try {
    const gmail = await getGmailClient(company.oauthCreds, company.tokenPath);
    const recipients = await extractRecipients(gmail, company.name);
    await writeToSentSheet(sheets, recipients, company.sentTab, company.name);
  } catch (err) {
    console.error('[' + company.name + '] Error: ' + err.message);
  }
}

async function main() {
  console.log('=== Gmail Sent History Import (Both Companies) ===');

  const sheets = await getSheetsClient();

  for (const company of COMPANIES) {
    await processCompany(sheets, company);
  }

  console.log('\n[Done] Import complete for all companies');
}

main().catch(console.error);
