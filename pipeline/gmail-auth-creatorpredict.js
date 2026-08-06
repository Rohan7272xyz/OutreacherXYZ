const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

// CreatorPredict OAuth credentials
const CREDS_PATH = path.join(__dirname, 'oauth-creds-creatorpredict.json');
const TOKEN_PATH = path.join(__dirname, 'gmail-token-creatorpredict.json');

async function authenticate() {
  if (!fs.existsSync(CREDS_PATH)) {
    console.error(`\nError: OAuth credentials not found at ${CREDS_PATH}`);
    console.error('\nTo set up CreatorPredict Gmail authentication:');
    console.error('1. Go to Google Cloud Console -> APIs & Services -> Credentials');
    console.error('2. Download the OAuth 2.0 Client ID JSON for "CreatorPredict Sender"');
    console.error('3. Save it as: oauth-creds-creatorpredict.json in the pipeline folder');
    console.error('4. Run this script again\n');
    process.exit(1);
  }
  
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH));
  const { client_id, client_secret } = creds.installed;
  
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001/callback');
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send'
    ],
  });
  
  console.log('\n===========================================');
  console.log('CreatorPredict Gmail Authorization');
  console.log('===========================================');
  console.log('\nIMPORTANT: Make sure you are logged into');
  console.log('outreach@creatorpredict.com in your browser!\n');
  console.log('Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n===========================================');
  console.log('\nWaiting for authorization on port 3001...\n');
  
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const query = url.parse(req.url, true).query;
      if (query.code) {
        res.end('CreatorPredict authorization successful! You can close this tab.');
        server.close();
        
        try {
          const { tokens } = await oauth2Client.getToken(query.code);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          console.log('[Auth] CreatorPredict token saved to gmail-token-creatorpredict.json');
          console.log('[Auth] You can now run the pipeline!\n');
          resolve(tokens);
        } catch (err) {
          console.error('[Auth] Error getting token:', err.message);
          reject(err);
        }
      }
    }).listen(3001, () => {
      console.log('[Auth] Listening on http://localhost:3001');
    });
    
    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authorization timeout'));
    }, 300000);
  });
}

authenticate().then(() => process.exit(0)).catch(err => {
  console.error('Authorization failed:', err.message);
  process.exit(1);
});
