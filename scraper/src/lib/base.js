// Shared engine for the platform scrapers: browser lifecycle, pacing, the
// nightly pause, the visited store, and shutdown. Platform subclasses supply
// the selectors and the feed navigation.
const fs = require('fs');
const { chromium } = require('playwright');
const { SheetsSync } = require('../sheets');
const { VisitedStore } = require('./visited');
const {
  extractEmails, parseFollowers, inFollowerRange, randomDelayMs, sleep,
  minutesOfDayInZone, isInWindow, minutesUntil,
} = require('./util');

class BaseScraper {
  constructor(platform, tag, config) {
    this.platform = platform;
    this.tag = tag;
    this.config = config;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.emails = new Set();
    this.visited = new VisitedStore(platform);
    this.sheets = new SheetsSync(config.deviceName);
    this.stopping = false;
    this.stats = { checked: 0, profiles: 0, found: 0, skipped: 0 };

    if (!fs.existsSync(config.outputDir)) {
      fs.mkdirSync(config.outputDir, { recursive: true });
    }
  }

  log(msg) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${time}] [${this.tag}] ${msg}`);
  }

  async delay(minSec, maxSec, jitter = true) {
    let ms = randomDelayMs(minSec, maxSec, jitter);
    if (jitter && Math.random() < 0.2) {
      const extra = (3 + Math.random() * 7) * 1000;
      this.log(`  (pause ${(extra / 1000).toFixed(1)}s)`);
      ms += extra;
    }
    await this.interruptibleSleep(ms);
  }

  // Sleeping in slices means a stop request is honoured within a second even
  // during a 15-minute cooldown.
  async interruptibleSleep(ms) {
    const step = 1000;
    let left = ms;
    while (left > 0 && !this.stopping) {
      await sleep(Math.min(step, left));
      left -= step;
    }
  }

  contextOptions() {
    const device = this.getRandomDevice();
    this.currentDevice = device;
    return {
      viewport: { width: device.width, height: device.height },
      userAgent: device.ua,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      ...(device.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    };
  }

  // Subclass hook: runs against every new context, before its first page is
  // opened, so per-context setup survives a session rotation.
  async onContextCreated() {}

  async init() {
    this.log('Starting browser...');
    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    this.context = await this.browser.newContext(this.contextOptions());
    await this.onContextCreated();
    this.page = await this.context.newPage();
    this.log(`Browser ready (${this.currentDevice.width}x${this.currentDevice.height})`);
    await this.sheets.init();
    await this.sheets.updateStatus('scraping');
  }

  async rotateSession() {
    this.log('Rotating session...');
    const cookies = await this.context.cookies();
    await this.context.close();
    this.context = await this.browser.newContext(this.contextOptions());
    await this.onContextCreated();
    await this.context.addCookies(cookies);
    this.page = await this.context.newPage();
    this.log(`Session rotated (${this.currentDevice.width}x${this.currentDevice.height})`);
  }

  async loadCookies(file) {
    if (!fs.existsSync(file)) return false;
    try {
      await this.context.addCookies(JSON.parse(fs.readFileSync(file, 'utf8')));
      this.log('Session loaded');
      return true;
    } catch (err) {
      this.log('Could not load saved session: ' + err.message);
      return false;
    }
  }

  async saveCookies(file) {
    try {
      fs.writeFileSync(file, JSON.stringify(await this.context.cookies(), null, 2));
      this.log('Session saved');
    } catch (err) {
      this.log('Could not save session: ' + err.message);
    }
  }

  // Open a profile in its own tab so the feed tab keeps its scroll position.
  // This is what removes the old "reload the feed and skip 20 posts" penalty.
  async withProfileTab(url, fn) {
    let tab = null;
    try {
      tab = await this.context.newPage();
      await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.delay(1.2, 3);
      return await fn(tab);
    } finally {
      if (tab) await tab.close().catch(() => {});
      await this.page.bringToFront().catch(() => {});
    }
  }

  // Shared lead handling: gate on followers, pull emails, record them.
  async recordLead(username, followersText, textBlobs) {
    const followers = parseFollowers(followersText);
    this.log(`  -> ${followers === null ? 'unknown' : followers.toLocaleString()} followers`);

    if (!inFollowerRange(followers, this.config)) {
      this.log('  -> outside follower range, skipping');
      return 0;
    }

    let emails = [];
    for (const blob of textBlobs) {
      emails = extractEmails(blob);
      if (emails.length) break;
    }

    if (!emails.length) {
      this.log('  -> no email listed');
      return 0;
    }

    let added = 0;
    for (const email of emails) {
      this.emails.add(email);
      if (await this.sheets.addEmail(email, username, followers)) added++;
    }
    this.stats.found += added;
    console.log(`\n  *** FOUND: @${username}`
      + `${followers === null ? '' : ' (' + followers.toLocaleString() + ')'}`
      + ` -> ${emails.join(', ')} ***\n`);
    return added;
  }

  /* ---------- optional nightly pause ---------- */

  isInBlackoutWindow() {
    const b = this.config.blackout;
    if (!b || !b.enabled) return false;
    return isInWindow(minutesOfDayInZone(new Date(), b.timeZone), b.startMinutes, b.endMinutes);
  }

  async handleBlackoutPause() {
    const b = this.config.blackout;
    const remaining = minutesUntil(minutesOfDayInZone(new Date(), b.timeZone), b.endMinutes);
    this.log(`\n  ** Scheduled pause — sleeping ${remaining} minutes **`);
    await this.sheets.updateStatus('blackout');
    for (let left = remaining; left > 0 && !this.stopping; left -= 5) {
      this.log(`  ** Paused: ${left} min remaining **`);
      await this.interruptibleSleep(Math.min(5, left) * 60 * 1000);
    }
    if (this.stopping) return;
    this.log('\n  ** Pause over — resuming **\n');
    await this.sheets.updateStatus('scraping');
    await this.resetToFeed();
  }

  /* ---------- shutdown ---------- */

  async shutdown(reason = 'stop requested') {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopping = true;
    this.log(`Shutting down (${reason})...`);
    this.visited.save();
    try { await this.sheets.close(); } catch (err) { /* nothing left to do */ }
    try { await this.sheets.updateStatus('stopped'); } catch (err) { /* offline */ }
    try { if (this.browser) await this.browser.close(); } catch (err) { /* already gone */ }
    this.log(`Session totals: ${this.stats.profiles} profiles checked, ${this.stats.found} leads collected`);
  }

  // Wire Ctrl+C / the control panel's Stop button to a clean exit so the
  // browser never outlives the process.
  installSignalHandlers() {
    const bye = (signal) => {
      if (this.shuttingDown) process.exit(0);
      this.shutdown(signal).then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.on('SIGINT', () => bye('SIGINT'));
    process.on('SIGTERM', () => bye('SIGTERM'));
    process.on('unhandledRejection', (err) => {
      this.log('Unhandled error: ' + (err && err.message ? err.message : err));
    });
  }
}

module.exports = { BaseScraper };
