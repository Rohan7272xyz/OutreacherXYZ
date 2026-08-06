const { TikTokScraper, CONFIG } = require('./src/scraper');
const readline = require('readline');

const args = process.argv.slice(2);
const config = { ...CONFIG };

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--min' && args[i + 1]) config.minFollowers = parseInt(args[i + 1]);
  if (args[i] === '--max' && args[i + 1]) config.maxFollowers = parseInt(args[i + 1]);
  if (args[i] === '--device' && args[i + 1]) config.deviceName = args[i + 1];
}

async function prompt(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(msg, () => { rl.close(); r(); }));
}

async function main() {
  console.log('\n=== TikTok Email Scraper ===');
  console.log('Routing: 10k-250k -> CreatorPredict | 250k+ -> CoinFluence');
  console.log('Mode: Continuous (Ctrl+C to stop)');
  console.log('Device: ' + config.deviceName + '\n');

  const scraper = new TikTokScraper(config);
  await scraper.init();

  await scraper.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const isLoggedIn = await scraper.page.evaluate(() => {
    return !!document.querySelector('[data-e2e="profile-icon"]');
  });

  if (!isLoggedIn) {
    console.log('\n>>> Please log in to TikTok in the browser <<<');
    console.log('>>> Use your phone to scan QR code or enter credentials <<<\n');
    await prompt('Press ENTER after login...');
  }

  await scraper.run();
}

main().catch(console.error);
