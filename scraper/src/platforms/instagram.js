const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SheetsSync } = require('../sheets');

const CONFIG = {
  minFollowers: 5000,
  maxFollowers: 250000,
  outputDir: './output',
  headless: false,
  deviceName: os.hostname(),
};

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;

class InstagramScraper {
  constructor(config = CONFIG) {
    this.config = config;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.emails = new Set();
    this.visited = new Set();
    this.sheets = new SheetsSync(config.deviceName);
    this.notFoundCount = 0;
    this.lastUsername = null;
    this.sameUsernameCount = 0;
    this.cooldownTimestamps = [];
    this.consecutiveFailures = 0;

    if (!fs.existsSync(config.outputDir)) {
      fs.mkdirSync(config.outputDir, { recursive: true });
    }
  }

  getRandomDevice() {
    const devices = [
      { width: 390, height: 844, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
      { width: 393, height: 852, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1' },
      { width: 430, height: 932, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' },
      { width: 428, height: 926, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1' },
      { width: 375, height: 812, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.7 Mobile/15E148 Safari/604.1' },
      { width: 414, height: 896, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
      { width: 360, height: 780, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
      { width: 384, height: 854, ua: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36' },
    ];
    const device = devices[Math.floor(Math.random() * devices.length)];
    device.width += Math.floor(Math.random() * 11) - 5;
    device.height += Math.floor(Math.random() * 11) - 5;
    return device;
  }

  log(msg) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${time}] [IG] ${msg}`);
  }

  async delay(minSec, maxSec, jitter = true) {
    let ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
    if (jitter) {
      if (Math.random() < 0.2) {
        const extra = (3 + Math.random() * 7) * 1000;
        this.log(`  (human pause ${(extra/1000).toFixed(1)}s)`);
        ms += extra;
      }
      ms *= 0.85 + Math.random() * 0.3;
    }
    await new Promise(r => setTimeout(r, ms));
  }

  async init() {
    this.log('Initializing browser...');
    const device = this.getRandomDevice();
    this.log(`Using device: ${device.width}x${device.height}`);

    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-sandbox',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: device.width, height: device.height },
      userAgent: device.ua,
      isMobile: true,
      hasTouch: true,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      deviceScaleFactor: 2 + Math.random() * 0.5,
    });

    this.page = await this.context.newPage();
    this.log('Browser ready');
    await this.sheets.init();
    await this.sheets.updateStatus('scraping');
  }

  async loadCookies(f) {
    if (fs.existsSync(f)) {
      await this.context.addCookies(JSON.parse(fs.readFileSync(f)));
      this.log('Session loaded');
      return true;
    }
    return false;
  }

  async saveCookies(f) {
    fs.writeFileSync(f, JSON.stringify(await this.context.cookies(), null, 2));
    this.log('Session saved');
  }

  async rotateSession() {
    this.log('Rotating session...');

    const cookies = await this.context.cookies();

    await this.page.close();
    await this.context.close();

    const device = this.getRandomDevice();
    this.log(`New device: ${device.width}x${device.height}`);

    this.context = await this.browser.newContext({
      viewport: { width: device.width, height: device.height },
      userAgent: device.ua,
      isMobile: true,
      hasTouch: true,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      deviceScaleFactor: 2 + Math.random() * 0.5,
    });

    await this.context.addCookies(cookies);

    this.page = await this.context.newPage();
    this.log('Session rotated');
  }

  parseFollowers(text) {
    if (!text) return 0;
    text = text.toLowerCase().replace(/,/g, '').trim();
    if (text.includes('m')) return Math.floor(parseFloat(text.replace('m', '')) * 1000000);
    if (text.includes('k')) return Math.floor(parseFloat(text.replace('k', '')) * 1000);
    return parseInt(text) || 0;
  }

  extractEmails(text) {
    if (!text) return [];
    const m = text.match(EMAIL_REGEX);
    return m ? [...new Set(m.map(e => e.toLowerCase()))] : [];
  }

  // Helper to reliably click video element with fallbacks
  async clickVideo() {
    return await this.page.evaluate(() => {
      const selectors = ['video', 'article video', '[role="presentation"] video'];
      for (const sel of selectors) {
        const video = document.querySelector(sel);
        if (video) {
          video.click();
          return true;
        }
      }
      // Fallback: click center of page
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      if (el) { el.click(); return true; }
      return false;
    });
  }

  async swipeToNextReel(count = 1) {
    for (let i = 0; i < count; i++) {
      const beforeUsername = await this.getCreatorUsername();

      await this.page.mouse.click(150, 300);
      await new Promise(r => setTimeout(r, 100 + Math.random() * 150));

      await this.page.keyboard.press('ArrowDown');

      await new Promise(r => setTimeout(r, 800 + Math.random() * 400));

      let attempts = 0;
      let afterUsername = await this.getCreatorUsername();

      while (afterUsername && afterUsername === beforeUsername && attempts < 3) {
        this.log('  (stuck on same creator, retrying swipe)');
        await this.page.keyboard.press('ArrowDown');
        await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
        afterUsername = await this.getCreatorUsername();
        attempts++;
      }

      if (count > 1 && i < count - 1) {
        await new Promise(r => setTimeout(r, 300 + Math.random() * 300));
      }
    }
  }

  async simulateProfileEngagement() {
    if (Math.random() > 0.4) return;

    const actions = [];

    if (Math.random() < 0.6) {
      actions.push(async () => {
        const scrollAmount = 200 + Math.random() * 400;
        await this.page.mouse.wheel(0, scrollAmount);
        await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
      });
    }

    if (Math.random() < 0.3) {
      actions.push(async () => {
        const scrollAmount = 100 + Math.random() * 200;
        await this.page.mouse.wheel(0, -scrollAmount);
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      });
    }

    if (Math.random() < 0.2) {
      actions.push(async () => {
        const x = 100 + Math.random() * 230;
        const y = 400 + Math.random() * 300;
        await this.page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 5) });
        await new Promise(r => setTimeout(r, 300 + Math.random() * 700));
      });
    }

    for (const action of actions) {
      await action();
    }

    if (actions.length > 0) {
      this.log(`  (browsed profile: ${actions.length} actions)`);
    }
  }

  async navigationDetour() {
    if (Math.random() > 0.08) return false;

    const detours = [
      { name: 'explore', url: 'https://www.instagram.com/explore/', weight: 3 },
      { name: 'home', url: 'https://www.instagram.com/', weight: 2 },
      { name: 'search', url: 'https://www.instagram.com/explore/search/', weight: 1 },
    ];

    const totalWeight = detours.reduce((sum, d) => sum + d.weight, 0);
    let random = Math.random() * totalWeight;
    let selected = detours[0];
    for (const detour of detours) {
      random -= detour.weight;
      if (random <= 0) { selected = detour; break; }
    }

    this.log(`  (detour: ${selected.name})`);
    await this.page.goto(selected.url, { waitUntil: 'load', timeout: 15000 });

    await this.delay(2, 5);

    if (Math.random() < 0.6) {
      await this.page.mouse.wheel(0, 200 + Math.random() * 300);
      await this.delay(1, 3);
    }

    if (Math.random() < 0.3) {
      await this.page.mouse.wheel(0, 150 + Math.random() * 250);
      await this.delay(1, 2);
    }

    return true;
  }

  async getCreatorUsername() {
    const username = await this.page.evaluate(() => {
      const links = document.querySelectorAll('a[href$="/reels/"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/^\/([a-zA-Z0-9._]+)\/reels\/$/);
        if (match) {
          const name = match[1];
          const rect = link.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.top > 0 && rect.top < 900) {
            return name;
          }
        }
      }
      return null;
    });
    return username;
  }

  async returnToReels() {
    this.log('  -> Returning to reels...');

    try {
      await this.page.goto('https://www.instagram.com/reels/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      await this.delay(1, 2.5);

      // FIX: Properly verify video click with retry logic
      let videoClicked = false;
      for (let attempt = 0; attempt < 3 && !videoClicked; attempt++) {
        videoClicked = await this.clickVideo();
        if (!videoClicked) {
          this.log(`  -> Video click attempt ${attempt + 1} failed, waiting...`);
          await this.delay(1, 2);
        }
      }

      if (!videoClicked) {
        this.log('  -> WARNING: Could not click video after 3 attempts');
      }

      await this.delay(0.8, 2);

      // FIX #5: Increase swipe count for better escape (was 5-9, now 15-25)
      const swipes = 15 + Math.floor(Math.random() * 10);
      this.log(`  (advancing ${swipes} reels to fresh content)`);

      for (let i = 0; i < swipes; i++) {
        await this.page.keyboard.press('ArrowDown');
        await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
      }

      const username = await this.getCreatorUsername();
      if (username) {
        this.log(`  -> Landed on @${username}`);
        return true;
      } else {
        this.log('  -> Warning: Could not detect creator after return');
        return false;
      }
    } catch (err) {
      this.log(`  -> Error returning to reels: ${err.message}`);
      return false;
    }
  }

  async cooldown() {
    const now = Date.now();
    this.cooldownTimestamps.push(now);
    this.cooldownTimestamps = this.cooldownTimestamps.filter(t => now - t < 2 * 60 * 60 * 1000);

    const isStuckLoop = this.cooldownTimestamps.length >= 4;
    const cooldownEnd = new Date(now + 15 * 60 * 1000);

    if (isStuckLoop) {
      this.log('\n  !! STUCK LOOP DETECTED - 4+ cooldowns in 2 hours\n');
      await this.sheets.updateStatus('stuck-loop', cooldownEnd);
    } else {
      this.log('\n  !! COOLDOWN - 15 minutes\n');
      await this.sheets.updateStatus('cooldown', cooldownEnd);
    }

    try {
      this.log('  -> Resetting to reels page...');
      await this.page.goto('https://www.instagram.com/reels/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await this.delay(2, 4);

      await this.clickVideo();
      await this.delay(1, 2);

      this.log('  -> Advancing to fresh content...');
      for (let i = 0; i < 10; i++) {
        await this.page.keyboard.press('ArrowDown');
        await new Promise(r => setTimeout(r, 500 + Math.random() * 300));
      }
    } catch (err) {
      this.log(`  -> Reset error: ${err.message}`);
    }

    this.notFoundCount = 0;
    this.sameUsernameCount = 0;
    this.consecutiveFailures = 0;
    this.lastUsername = null;

    // CRITICAL FIX: Clear visited set to prevent feed saturation
    const visitedSize = this.visited.size;
    this.visited.clear();
    this.log(`  -> Cleared visited set (was ${visitedSize} entries)`);

    for (let i = 15; i > 0; i--) {
      this.log(`  ** Cooldown: ${i} min remaining **`);
      await this.delay(60, 61);
    }

    this.log('\n  ** Cooldown complete **\n');
    await this.sheets.updateStatus('scraping');
  }

  // Periodic visited set maintenance to prevent memory bloat
  pruneVisitedSet() {
    const MAX_VISITED_SIZE = 1000;
    if (this.visited.size > MAX_VISITED_SIZE) {
      // Clear the oldest half by converting to array, slicing, and recreating
      const entries = Array.from(this.visited);
      const toKeep = entries.slice(entries.length - MAX_VISITED_SIZE / 2);
      this.visited = new Set(toKeep);
      this.log(`  -> Pruned visited set: ${entries.length} -> ${this.visited.size}`);
    }
  }

  // FIX #6: Force page refresh when DOM becomes stale
  async refreshStaleDOM() {
    this.log('  -> FIX #6: DOM appears stale, forcing hard page refresh...');

    try {
      // First try a simple reload
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.delay(2, 4);

      // Navigate back to reels and get fresh content
      await this.page.goto('https://www.instagram.com/reels/', {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      await this.delay(1.5, 3);

      // Click first video
      await this.clickVideo();
      await this.delay(1, 2);

      // Scroll past many videos to get completely fresh content
      const scrolls = 20 + Math.floor(Math.random() * 10);
      this.log(`  -> Scrolling past ${scrolls} videos for fresh content...`);
      for (let i = 0; i < scrolls; i++) {
        await this.page.keyboard.press('ArrowDown');
        await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
      }

      // Reset stale tracking
      this.lastUsername = null;
      this.sameUsernameCount = 0;

      const newUsername = await this.getCreatorUsername();
      if (newUsername) {
        this.log(`  -> Refresh successful, now on @${newUsername}`);
        return true;
      } else {
        this.log(`  -> Refresh completed but no username detected`);
        return false;
      }
    } catch (err) {
      this.log(`  -> Refresh error: ${err.message}`);
      return false;
    }
  }

  async skipVisitedCreators() {
    let skippedCount = 0;
    let username = await this.getCreatorUsername();

    // FIX #5: Increase skip limit from 30 to 50
    while (username && this.visited.has(username) && skippedCount < 50) {
      skippedCount++;

      await this.page.keyboard.press('ArrowDown');
      await new Promise(r => setTimeout(r, 150 + Math.random() * 100));

      username = await this.getCreatorUsername();

      if (skippedCount % 10 === 0) {
        this.log(`  -> Skipped ${skippedCount} visited creators...`);
      }
    }

    if (skippedCount > 0) {
      this.log(`  -> Skipped ${skippedCount} already-visited creators`);
    }

    // FIX #5: If we hit the limit and still stuck, trigger a page refresh
    if (skippedCount >= 50 && username && this.visited.has(username)) {
      this.log('  -> Hit skip limit, will trigger page refresh');
    }

    return { skipped: skippedCount, currentUsername: username };
  }

  isInBlackoutWindow() {
    const now = new Date();
    const estOffset = -5;
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const est = new Date(utc + 3600000 * estOffset);
    const hours = est.getHours();
    const minutes = est.getMinutes();
    const timeInMinutes = hours * 60 + minutes;
    return timeInMinutes >= 75 && timeInMinutes < 255;
  }

  getMinutesUntilBlackoutEnd() {
    const now = new Date();
    const estOffset = -5;
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const est = new Date(utc + 3600000 * estOffset);
    const hours = est.getHours();
    const minutes = est.getMinutes();
    const timeInMinutes = hours * 60 + minutes;
    return 255 - timeInMinutes;
  }

  async handleBlackoutPause() {
    const minutesRemaining = this.getMinutesUntilBlackoutEnd();
    this.log('\n  ** WIFI BLACKOUT WINDOW (1:15-4:15 AM EST) **');
    this.log('  -> Navigating to Instagram home to idle...');

    try {
      await this.page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      this.log('  -> Navigation failed, staying on current page');
    }

    await this.sheets.updateStatus('blackout');
    this.log('  -> Sleeping for ' + minutesRemaining + ' minutes until 4:15 AM EST...');

    const chunks = Math.ceil(minutesRemaining / 5);
    for (let i = 0; i < chunks; i++) {
      const remaining = minutesRemaining - (i * 5);
      if (remaining <= 0) break;
      const sleepTime = Math.min(5, remaining);
      this.log('  ** Blackout: ' + remaining + ' min remaining **');
      await new Promise(r => setTimeout(r, sleepTime * 60 * 1000));
    }

    this.log('\n  ** BLACKOUT ENDED - Resuming scraping **\n');
    await this.sheets.updateStatus('scraping');

    await this.returnToReels();
  }

  async run() {
    this.log('Going to reels...');
    await this.page.goto('https://www.instagram.com/reels/', { waitUntil: 'load', timeout: 30000 });
    await this.delay(1.5, 5);

    this.log('Clicking first video...');
    await this.clickVideo();
    await this.delay(1.5, 4.5);

    this.log('Starting scrape loop...\n');
    await this.sheets.updateStatus('scraping');

    let reelCount = 0;
    let skippedTotal = 0;

    while (true) {
      if (this.isInBlackoutWindow()) {
        await this.handleBlackoutPause();
        continue;
      }

      try {
        if (Math.random() < 0.05) {
          const distractTime = 15 + Math.random() * 30;
          this.log(`  (distracted for ${distractTime.toFixed(0)}s...)`);
          await this.delay(distractTime, distractTime + 1, false);
        }

        reelCount++;

        const username = await this.getCreatorUsername();

        if (!username) {
          this.notFoundCount++;
          this.consecutiveFailures++;
          this.log(`Reel ${reelCount}: @(not found) - failure ${this.consecutiveFailures}/10`);

          if (this.consecutiveFailures >= 10) {
            this.log(`  -> ${this.consecutiveFailures} consecutive failures, entering cooldown`);
            await this.cooldown();
            this.consecutiveFailures = 0;
          } else if (this.consecutiveFailures >= 5) {
            await this.returnToReels();
            this.consecutiveFailures = 0;
          } else {
            await this.swipeToNextReel();
          }
          continue;
        }

        if (this.visited.has(username)) {
          this.log(`Reel ${reelCount}: @${username} - already checked, skipping...`);

          const { skipped, currentUsername } = await this.skipVisitedCreators();
          skippedTotal += skipped;

          if (!currentUsername || this.visited.has(currentUsername)) {
            this.log(`  -> Too many visited creators, returning to reels`);
            await this.returnToReels();
          }

          continue;
        }

        this.consecutiveFailures = 0;
        this.notFoundCount = 0;

        this.log(`Reel ${reelCount}: @${username} - NEW creator, watching...`);
        await this.delay(1.5, 5);

        if (username === this.lastUsername) {
          this.sameUsernameCount++;

          if (this.sameUsernameCount >= 10) {
            this.log(`  -> Stuck on same creator for ${this.sameUsernameCount} reels, entering cooldown`);
            await this.cooldown();
            this.sameUsernameCount = 0;
          } else if (this.sameUsernameCount >= 6) {
            // FIX #6: Try DOM refresh before resorting to cooldown
            this.log(`  -> Same creator ${this.sameUsernameCount}/10, DOM may be stale...`);
            await this.refreshStaleDOM();
          } else {
            this.log(`  -> Same creator ${this.sameUsernameCount}/10, swiping harder...`);
            await this.swipeToNextReel(3);
          }
          continue;
        } else {
          this.sameUsernameCount = 0;
          this.lastUsername = username;
        }

        this.visited.add(username);

        this.log(`  -> Visiting profile...`);
        await this.page.goto(`https://www.instagram.com/${username}/`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        });
        await this.delay(1.5, 4.5);
        await this.simulateProfileEngagement();

        const data = await this.page.evaluate(() => {
          let followers = '';
          let bio = '';
          const meta = document.querySelector('meta[name="description"]');
          if (meta) {
            const content = meta.getAttribute('content') || '';
            const m = content.match(/([\d,.]+[KkMm]?)\s*[Ff]ollowers/);
            if (m) followers = m[1];
          }
          const header = document.querySelector('header');
          if (header) bio = header.innerText || '';
          const main = document.querySelector('main');
          if (main) bio += ' ' + main.innerText.substring(0, 2000);
          const bodyText = document.body.innerText.substring(0, 3000);
          return { followers, bio, bodyText };
        });

        const followers = this.parseFollowers(data.followers);
        this.log(`  -> ${followers.toLocaleString()} followers`);

        if (followers >= this.config.minFollowers) {
          this.log(`  -> IDENTIFIED for CrossCheck AI`);
          let emails = this.extractEmails(data.bio);
          if (emails.length === 0) emails = this.extractEmails(data.bodyText);

          if (emails.length > 0) {
            for (const email of emails) {
              this.emails.add(email);
              await this.sheets.addEmail(email, username, followers);
            }
            console.log(`\n  *** FOUND: @${username} (${followers.toLocaleString()}) -> ${emails.join(', ')} ***\n`);
          } else {
            this.log(`  -> No email`);
          }
        } else {
          this.log(`  -> Outside range`);
        }

        await this.delay(0.8, 2);

        const tookDetour = await this.navigationDetour();

        if (!tookDetour) {
          await this.returnToReels();
        } else {
          await this.returnToReels();
        }

        if (reelCount % 10 === 0) {
          console.log(`\n=== ${reelCount} reels | ${this.visited.size} profiles | ${this.emails.size} emails | ${skippedTotal} skipped ===\n`);
        }

        if (reelCount % 100 === 0) {
          this.log(`\n  ** 90s break **\n`);
          await this.sheets.updateStatus('break');
          await this.delay(90, 91);
          await this.sheets.updateStatus('scraping');
          this.pruneVisitedSet();
        }

        if (!this.nextRotation) this.nextRotation = 200 + Math.floor(Math.random() * 150);
        if (reelCount >= this.nextRotation) {
          this.log(`\n  ** Rotating session at reel ${reelCount} **\n`);
          await this.rotateSession();
          await this.page.goto('https://www.instagram.com/reels/', { waitUntil: 'load', timeout: 30000 });
          await this.delay(1.5, 4.5);
          await this.clickVideo();
          this.nextRotation = reelCount + 200 + Math.floor(Math.random() * 150);
        }
      } catch (err) {
        this.log(`  !! Error: ${err.message}`);
        this.consecutiveFailures++;

        if (this.consecutiveFailures >= 5) {
          this.log('  -> Too many errors, doing full reset');
          try {
            await this.returnToReels();
            this.consecutiveFailures = 0;
          } catch (e) {
            this.log(`  -> Reset failed: ${e.message}`);
            await this.delay(5, 10);
          }
        } else {
          await this.delay(2, 7);
          try {
            await this.page.goto('https://www.instagram.com/reels/', { waitUntil: 'load', timeout: 30000 });
            await this.delay(1.5, 4.5);
            await this.clickVideo();
          } catch (e) {
            this.log(`  -> Recovery failed: ${e.message}`);
          }
        }
      }
    }
  }
}

module.exports = { InstagramScraper, CONFIG };
