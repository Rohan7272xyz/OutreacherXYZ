const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SHEET_CREDS = path.join(__dirname, 'credentials.json');
const SHEET_ID = process.env.SHEET_ID || 'YOUR_SHEET_ID';
const DELAY_MS = Number(process.env.SEND_DELAY_MS) || 2000;

// Gmail cuts off consumer accounts around 500 messages/day and Workspace around
// 2000. Blowing through that gets the account limited, so cap each run well
// under it. Raise with DAILY_SEND_LIMIT once you know your account's ceiling.
const DAILY_SEND_LIMIT = Number(process.env.DAILY_SEND_LIMIT) || 150;

// Cold outreach needs a working opt-out (CAN-SPAM). Set OPT_OUT_TEXT to change
// the wording; set it empty only if your own footer already covers it.
const OPT_OUT_TEXT = process.env.OPT_OUT_TEXT === ''
  ? ''
  : (process.env.OPT_OUT_TEXT || 'Not interested? Reply "unsubscribe" and I won\'t contact you again.');

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
  var body = company.body(username);
  if (OPT_OUT_TEXT) body += '\n\n' + OPT_OUT_TEXT;

  var message = [
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    'To: ' + to,
    'From: ' + company.fromEmail,
    'Subject: ' + company.subject,
    '',
    body
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

async function getAlreadySent(sheets, company) {
  try {
    var res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "'" + company.sentTab + "'!A:A",
    });
    var rows = res.data.values || [];
    return new Set(rows.map(function (r) {
      return (r[0] || '').toLowerCase().trim();
    }).filter(Boolean));
  } catch (err) {
    return new Set();
  }
}

async function getLeadsToEmail(sheets, company) {
  var res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: company.leadsTab + '!A:G',
  });

  // Cross-check the Sent tab as well as the row's own marker. If a previous run
  // sent a message but died before writing the marker back, this is what stops
  // a real person receiving the same pitch twice.
  var alreadySent = await getAlreadySent(sheets, company);

  var rows = res.data.values || [];
  var leads = [];
  var seen = {};

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var email = (row[0] || '').toLowerCase().trim();
    var username = row[1];
    var followers = row[2];
    var sent = row[6];

    if (!email || email === 'email' || sent) continue;
    if (alreadySent.has(email) || seen[email]) continue;
    seen[email] = true;

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

async function processCompany(sheets, company, budget) {
  console.log('\n=== ' + company.name + ' ===');

  var gmail;
  try {
    gmail = await getGmailClient(company);
  } catch (err) {
    console.error('[' + company.name + '] Gmail auth failed: ' + err.message);
    return 0;
  }

  var allLeads = await getLeadsToEmail(sheets, company);
  console.log('[' + company.name + '] Found ' + allLeads.length + ' leads to email');

  if (allLeads.length === 0) {
    console.log('[' + company.name + '] No new leads');
    return 0;
  }

  var leads = allLeads.slice(0, budget);
  if (leads.length < allLeads.length) {
    console.log('[' + company.name + '] Sending ' + leads.length + ' now; '
      + (allLeads.length - leads.length) + ' held back for the next run (daily cap)');
  }

  var sent = 0;
  var failed = 0;

  for (var i = 0; i < leads.length; i++) {
    var lead = leads[i];
    try {
      console.log('[' + company.name + '] Sending to ' + lead.email + ' (@' + lead.username + ')');
      await sendEmail(gmail, lead.email, lead.username, company);
      sent++;
      // Record the send even if the bookkeeping below fails, so a crash here
      // can be reconciled instead of silently re-sending tomorrow.
      try {
        await markAsSent(sheets, company, lead.rowIndex);
        await addToSentTab(sheets, company, lead.email, lead.username, lead.followers);
      } catch (bookErr) {
        console.error('[' + company.name + '] SENT but failed to record ' + lead.email
          + ': ' + bookErr.message);
        fs.appendFileSync(path.join(__dirname, 'unrecorded-sends.log'),
          new Date().toISOString() + ',' + company.name + ',' + lead.email + '\n');
      }
      console.log('[' + company.name + '] Sent ' + sent + '/' + leads.length);

      if (i < leads.length - 1) await sleep(DELAY_MS);
    } catch (err) {
      console.error('[' + company.name + '] Failed ' + lead.email + ': ' + err.message);
      failed++;
      // A quota rejection applies to the whole account; stop rather than
      // hammering it for every remaining lead.
      if (/quota|rate limit|limit exceeded/i.test(err.message)) {
        console.error('[' + company.name + '] Hit a sending limit — stopping this run.');
        break;
      }
    }
  }

  console.log('[' + company.name + '] Done - Sent: ' + sent + ', Failed: ' + failed);
  return sent;
}

async function main() {
  console.log('=== Email Sender ===');
  console.log('Daily cap: ' + DAILY_SEND_LIMIT + ' messages across all campaigns');

  var sheets = await getSheetsClient();
  var budget = DAILY_SEND_LIMIT;

  for (var i = 0; i < COMPANIES.length; i++) {
    if (budget <= 0) {
      console.log('\nDaily cap reached — remaining campaigns will go out next run.');
      break;
    }
    budget -= await processCompany(sheets, COMPANIES[i], budget);
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
