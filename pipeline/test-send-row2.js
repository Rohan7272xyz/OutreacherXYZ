const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const OAUTH_CREDS = path.join(__dirname, 'oauth-creds.json');
const TOKEN_PATH = path.join(__dirname, 'gmail-token.json');
const SHEET_CREDS = path.join(__dirname, 'credentials.json');
const SHEET_ID = process.env.SHEET_ID || 'YOUR_SHEET_ID';

async function getGmailClient() {
  const creds = JSON.parse(fs.readFileSync(OAUTH_CREDS));
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH));
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

function createEmail(to, username) {
  const subject = 'Invitation For CoinFluence';
  const body = `Hi ${username},

I'm reaching out because I can tell that you're passionate about creating content and building something with long-term potential.

We're developing a platform called CoinFluence that lets influencers create their own stocks for supporters to trade.

There are no content requirements or upfront costs, and aside from reviewing our proposal and onboarding with us, we ask nothing else of our partners.

If you're open to it, I can walk you through how everything works and what the platform would look like for you. It usually takes around 15 minutes and makes everything much clearer than email.

Thank you for your time,

Best,
Rohan`;

  const message = [
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    `To: ${to}`,
    'From: admin@trycoinfluence.com',
    `Subject: ${subject}`,
    '',
    body
  ].join('\n');

  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function main() {
  const gmail = await getGmailClient();
  const sheets = await getSheetsClient();
  
  // Get row 2 (index 1, since row 1 is header)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A2:G2',
  });
  
  const row = res.data.values?.[0];
  if (!row) {
    console.log('[Test] No data in row 2');
    return;
  }
  
  const [email, username] = row;
  console.log(`[Test] Sending to row 2: ${email} (@${username})`);
  
  const raw = createEmail(email, username || 'there');
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });
  
  // Mark as sent in column G
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!G2',
    valueInputOption: 'RAW',
    resource: { values: [[new Date().toISOString()]] }
  });
  
  console.log(`[Test] Email sent to ${email} and marked in column G!`);
}

main().catch(console.error);
