// End-to-end check of the scraping engine against the local fixture feed.
// Verifies the loop, the follower gate, email extraction and attribution, the
// de-duplication store, and that visiting a profile no longer disturbs the feed.
//   node test/e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { start } = require('./fixture-server');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outreacher-e2e-'));
process.env.OUTPUT_DIR = workDir;
process.env.SHEET_ID = '';               // exercise the local-backup path
process.env.HEADLESS = process.env.E2E_HEADLESS || '1';
process.env.MIN_FOLLOWERS = '10000';
process.env.MAX_FOLLOWERS = '250000';
process.env.PERSIST_VISITED = '1';
process.env.BLACKOUT_ENABLED = '0';

const { config } = require('../src/config');
const { InstagramScraper } = require('../src/platforms/instagram');

const checks = [];
function check(name, fn) {
  try { fn(); checks.push([true, name]); }
  catch (err) { checks.push([false, `${name} — ${err.message}`]); }
}

(async () => {
  const { server, port } = await start();
  config.baseUrl = `http://127.0.0.1:${port}`;
  config.headless = process.env.E2E_HEADLESS !== '0';

  const scraper = new InstagramScraper(config);
  // Keep the run brisk: the pacing delays exist for live sites, not fixtures.
  scraper.delay = async () => {};
  scraper.interruptibleSleep = async () => {};

  await scraper.init();
  const runPromise = scraper.run();

  // Let it work through the fixture's five creators.
  const backup = path.join(workDir, 'leads-backup.csv');
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (scraper.stats.profiles >= 5) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const feedUrlBeforeStop = scraper.page.url();
  scraper.stopping = true;
  await runPromise.catch(() => {});
  await scraper.shutdown('test complete');
  server.close();

  const csv = fs.existsSync(backup) ? fs.readFileSync(backup, 'utf8') : '';
  const emails = csv.split('\n').slice(1).filter(Boolean).map((l) => l.split(',')[0]);

  check('collected the in-range creator with an email', () =>
    assert.ok(emails.includes('alpha@alphastudio.com'), `got: ${emails.join(' ')}`));
  check('collected the second in-range creator', () =>
    assert.ok(emails.includes('gamma.films@gmail.com'), `got: ${emails.join(' ')}`));
  check('collected the third in-range creator', () =>
    assert.ok(emails.includes('hello@epsilon.co'), `got: ${emails.join(' ')}`));
  check('excluded the creator above the follower ceiling', () =>
    assert.ok(!emails.some((e) => e.includes('beta')), 'beta_makes should be over the max'));
  check('excluded the creator below the follower floor', () =>
    assert.ok(!emails.includes('delta@delta.com'), 'delta_tiny should be under the min'));
  check('did not attribute a suggested-account email to the creator', () =>
    assert.ok(!emails.some((e) => e.includes('shouldnotbescraped')), 'leaked an email from page furniture'));
  check('filtered platform noise out of the bio', () =>
    assert.ok(!emails.some((e) => e.includes('instagram.com')), 'kept a noreply@ address'));
  check('feed tab stayed on the feed while profiles were scraped', () =>
    assert.ok(/\/reels\/$/.test(feedUrlBeforeStop), `feed drifted to ${feedUrlBeforeStop}`));
  check('recorded every creator in the visited store', () =>
    assert.ok(scraper.visited.size >= 5, `visited ${scraper.visited.size}`));
  check('persisted the visited store to disk', () =>
    assert.ok(fs.existsSync(path.join(workDir, 'visited-instagram.json')), 'no visited file written'));
  check('closed the browser on shutdown', () =>
    assert.ok(!scraper.browser.isConnected(), 'browser still connected'));

  let failed = 0;
  for (const [ok, name] of checks) {
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}`);
    if (!ok) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('e2e harness error:', err);
  process.exit(1);
});
