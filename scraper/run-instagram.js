const { InstagramScraper, CONFIG } = require('./src/platforms/instagram');
const readline = require('readline');

const args = process.argv.slice(2);
const manual = args.includes('--manual') || args.includes('-m');

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
  console.log('\n=== ScraperUltra - Instagram ===');
  console.log('Campaign: CrossCheck AI');
  console.log('Mode: Continuous (Ctrl+C to stop)');
  console.log('Device: ' + config.deviceName + '\n');

  const scraper = new InstagramScraper(config);
  await scraper.init();

  const hasSession = await scraper.loadCookies('./session-instagram.json');

  if (!hasSession || manual) {
    await scraper.page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle' });
    console.log('\n>>> Log in manually in the browser <<<');
    await prompt('Press ENTER after login...');
    await scraper.saveCookies('./session-instagram.json');
  }

  await scraper.run();
}

main().catch(console.error);
