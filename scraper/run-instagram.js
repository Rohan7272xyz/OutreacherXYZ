const path = require('path');
const readline = require('readline');
const { InstagramScraper } = require('./src/platforms/instagram');
const { config } = require('./src/config');

const args = process.argv.slice(2);
const manual = args.includes('--manual') || args.includes('-m');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--min' && args[i + 1]) config.minFollowers = parseInt(args[i + 1], 10);
  if (args[i] === '--max' && args[i + 1]) config.maxFollowers = parseInt(args[i + 1], 10);
  if (args[i] === '--device' && args[i + 1]) config.deviceName = args[i + 1];
}

const SESSION_FILE = path.join(__dirname, 'session-instagram.json');

function prompt(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(msg, () => { rl.close(); r(); }));
}

async function main() {
  console.log('\n=== OutreacherXYZ — Instagram ===');
  console.log('Device: ' + config.deviceName);
  console.log('Followers: ' + (config.minFollowers || 0) + ' to '
    + (config.maxFollowers === Infinity ? 'no limit' : config.maxFollowers) + '\n');

  const scraper = new InstagramScraper(config);
  scraper.installSignalHandlers();
  await scraper.init();

  const hasSession = await scraper.loadCookies(SESSION_FILE);
  if (!hasSession || manual) {
    await scraper.page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
    console.log('\n>>> Log in to Instagram in the browser window <<<');
    await prompt('Press ENTER after login...');
    await scraper.saveCookies(SESSION_FILE);
  }

  try {
    await scraper.run();
  } finally {
    await scraper.shutdown('run ended');
  }
}

main().catch(async (err) => {
  console.error('Fatal: ' + err.message);
  process.exit(1);
});
