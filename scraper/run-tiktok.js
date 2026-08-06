const path = require('path');
const readline = require('readline');
const { TikTokScraper } = require('./src/platforms/tiktok');
const { config } = require('./src/config');

const args = process.argv.slice(2);

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--min' && args[i + 1]) config.minFollowers = parseInt(args[i + 1], 10);
  if (args[i] === '--max' && args[i + 1]) config.maxFollowers = parseInt(args[i + 1], 10);
  if (args[i] === '--device' && args[i + 1]) config.deviceName = args[i + 1];
}

const SESSION_FILE = path.join(__dirname, 'session-tiktok.json');

function prompt(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(msg, () => { rl.close(); r(); }));
}

async function main() {
  console.log('\n=== OutreacherXYZ — TikTok ===');
  console.log('Device: ' + config.deviceName);
  console.log('Followers: ' + (config.minFollowers || 0) + ' to '
    + (config.maxFollowers === Infinity ? 'no limit' : config.maxFollowers) + '\n');

  const scraper = new TikTokScraper(config);
  scraper.installSignalHandlers();
  await scraper.init();

  await scraper.loadCookies(SESSION_FILE);
  await scraper.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await scraper.delay(2, 4);

  const isLoggedIn = await scraper.page.evaluate(
    () => !!document.querySelector('[data-e2e="profile-icon"]')
  );

  if (!isLoggedIn) {
    console.log('\n>>> Log in to TikTok in the browser window (QR code or password) <<<');
    await prompt('Press ENTER after login...');
    await scraper.saveCookies(SESSION_FILE);
  }

  try {
    await scraper.run();
  } finally {
    await scraper.shutdown('run ended');
  }
}

main().catch((err) => {
  console.error('Fatal: ' + err.message);
  process.exit(1);
});
