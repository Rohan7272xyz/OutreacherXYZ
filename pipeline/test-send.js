const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const OAUTH_CREDS = path.join(__dirname, 'oauth-creds.json');
const TOKEN_PATH = path.join(__dirname, 'gmail-token.json');

async function getGmailClient() {
  const creds = JSON.parse(fs.readFileSync(OAUTH_CREDS));
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH));
  const { client_id, client_secret } = creds.installed;
  
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
  oauth2Client.setCredentials(tokens);
  
  return google.gmail({ version: 'v1', auth: oauth2Client });
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
  console.log('[Test] Sending test email to you@example.com...');
  
  const gmail = await getGmailClient();
  const raw = createEmail('you@example.com', 'TestUser');
  
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });
  
  console.log('[Test] Email sent! Check your inbox.');
}

main().catch(console.error);
