const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SHEET_CREDS = path.join(__dirname, 'credentials.json');
const SHEET_ID = process.env.SHEET_ID || 'YOUR_SHEET_ID';
const DELAY_MS = 2000;

const COMPANIES = [
  {
    name: 'CoinFluence',
    oauthCreds: path.join(__dirname, 'oauth-creds.json'),
    tokenPath: path.join(__dirname, 'gmail-token.json'),
    leadsTab: 'CoinFluence',
    sentTab: 'Sent- CoinFluence',
    fromEmail: 'admin@trycoinfluence.com',
    subject: 'Invitation For CoinFluence',
    signature: 'Rohan',
    body: function(username) {
      return 'Hi ' + username + ',\n\n' +
        'I\'m reaching out because you\'re clearly building real momentum as a creator.\n\n' +
        'I\'m working on CoinFluence, a testnet-only market simulation that lets users make public calls on creator momentum using test capital meaning no real money, no ownership, no obligations.\n\n' +
        'Creators who opt in get a live market around their growth that shows how early supporters perceive them, producing public signal and engagement without requiring content, promotion, or financial involvement.\n\n' +
        'If you\'re open, I can walk you through it in ~10 minutes as it\'s much clearer live than over email.\n\n' +
        'Best,\n' +
        'Rohan';
    },
  },
  {
    name: 'CreatorPredict',
    oauthCreds: path.join(__dirname, 'oauth-creds-creatorpredict.json'),
    tokenPath: path.join(__dirname, 'gmail-token-creatorpredict.json'),
    leadsTab: 'CreatorPredict',
    sentTab: 'Sent - CreatorPredict',
    fromEmail: 'outreach@creatorpredict.com',
    subject: 'Invitation to join CreatorPredict',
    signature: 'Sam',
    body: function(username) {
      return 'Hi ' + username + ',\n\n' +
        'I\'m reaching out because I can tell you\'re intentional about growing your audience and thinking long term about where your content is headed.\n\n' +
        'We\'re building a platform called CreatorPredict where fans can predict which creators are about to grow. We turn those predictions into projections that creators can use to plan their content and understand how their audience expects their trajectory to move.\n\n' +
        'If it seems like a fit, the next step would be reviewing our partnership proposal.\n\n' +
        'I\'d be happy to answer any questions or share more details if you\'re interested.\n\n' +
        'Best,\n' +
        'Sam';
    },
  },
];

async function getGmailClient(company) {
  const creds = JSON.parse(fs.readFileSync(company.oauthCreds));
  const tokens = JSON.parse(fs.readFileSync(company.tokenPath));
  const { client_id, client_secret } = creds.installed;

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', function(newTokens) {
    const updated = Object.assign({}, tokens, newTokens);
    fs.writeFileSync(company.tokenPath, JSON.stringify(updated, null, 2));
    console.log('[' + company.name + '] Token refreshed');
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SHEET_CREDS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

function createEmail(to, username, company) {
  var message = [
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    'To: ' + to,
    'From: ' + company.fromEmail,
    'Subject: ' + company.subject,
    '',
    company.body(username)
  ].join('\n');

  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail(gmail, to, username, company) {
  var raw = createEmail(to, username, company);
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: raw }
  });
}

async function getLeadsToEmail(sheets, company) {
  var res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: company.leadsTab + '!A:G',
  });

  var rows = res.data.values || [];
  var leads = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var email = row[0];
    var username = row[1];
    var followers = row[2];
    var sent = row[6];

    if (!email || email === 'email' || sent) continue;

    leads.push({
      email: email,
      username: username || 'there',
      followers: followers || '',
      rowIndex: i
    });
  }

  return leads;
}

async function markAsSent(sheets, company, rowIndex) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: company.leadsTab + '!G' + (rowIndex + 1),
    valueInputOption: 'RAW',
    resource: { values: [[new Date().toISOString()]] }
  });
}

async function addToSentTab(sheets, company, email, username, followers) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: company.sentTab + '!A:E',
    valueInputOption: 'RAW',
    resource: {
      values: [[email, username, followers, new Date().toISOString(), 'sent']]
    }
  });
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function processCompany(sheets, company) {
  console.log('\n=== ' + company.name + ' ===');

  var gmail;
  try {
    gmail = await getGmailClient(company);
  } catch (err) {
    console.error('[' + company.name + '] Gmail auth failed: ' + err.message);
    return;
  }

  var leads = await getLeadsToEmail(sheets, company);
  console.log('[' + company.name + '] Found ' + leads.length + ' leads to email');

  if (leads.length === 0) {
    console.log('[' + company.name + '] No new leads');
    return;
  }

  var sent = 0;
  var failed = 0;

  for (var i = 0; i < leads.length; i++) {
    var lead = leads[i];
    try {
      console.log('[' + company.name + '] Sending to ' + lead.email + ' (@' + lead.username + ')');
      await sendEmail(gmail, lead.email, lead.username, company);
      await markAsSent(sheets, company, lead.rowIndex);
      await addToSentTab(sheets, company, lead.email, lead.username, lead.followers);
      sent++;
      console.log('[' + company.name + '] Sent ' + sent + '/' + leads.length);

      if (i < leads.length - 1) {
        await sleep(DELAY_MS);
      }
    } catch (err) {
      console.error('[' + company.name + '] Failed ' + lead.email + ': ' + err.message);
      failed++;
    }
  }

  console.log('[' + company.name + '] Done - Sent: ' + sent + ', Failed: ' + failed);
}

async function main() {
  console.log('=== Email Sender (Both Companies) ===');

  var sheets = await getSheetsClient();

  for (var i = 0; i < COMPANIES.length; i++) {
    await processCompany(sheets, COMPANIES[i]);
  }

  console.log('\n=== All companies processed ===');
}

main().catch(console.error);
