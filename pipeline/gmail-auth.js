const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(__dirname, 'oauth-creds.json');
const TOKEN_PATH = path.join(__dirname, 'gmail-token.json');

async function authenticate() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH));
  const { client_id, client_secret } = creds.installed;
  
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3000/callback');
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send'
    ],
  });
  
  console.log('\n===========================================');
  console.log('Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n===========================================');
  console.log('\nWaiting for authorization...\n');
  
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const query = url.parse(req.url, true).query;
      if (query.code) {
        res.end('Authorization successful! You can close this tab.');
        server.close();
        
        const { tokens } = await oauth2Client.getToken(query.code);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log('[Auth] Token saved to gmail-token.json');
        resolve(tokens);
      }
    }).listen(3000, () => {
      console.log('[Auth] Listening on http://localhost:3000');
    });
  });
}

authenticate().then(() => process.exit(0)).catch(console.error);
