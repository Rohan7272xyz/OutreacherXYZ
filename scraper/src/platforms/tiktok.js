const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SheetsSync } = require('../sheets');

const CONFIG = {
  minFollowers: 0,       // No minimum - accept all with email
  maxFollowers: Infinity,
  outputDir: './output',
  headless: false,
  deviceName: os.hostname(),
};

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;

class TikTokScraper {
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
    this.consecutiveAlreadyChecked = 0;

    if (!fs.existsSync(config.outputDir)) {
      fs.mkdirSync(config.outputDir, { recursive: true });
    }
  }

  log(msg) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${time}] [TT] ${msg}`);
  }

  async delay(minSec, maxSec, jitter = true) {
    let ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
    if (jitter && Math.random() < 0.2) {
      const extra = (3 + Math.random() * 7) * 1000;
      this.log(`  (human pause ${(extra/1000).toFixed(1)}s)`);
      ms += extra;
    }
    if (jitter) ms *= 0.85 + Math.random() * 0.3;
    await new Promise(r => setTimeout(r, ms));
  }

  // FIX #3: Add device rotation like Instagram
  getRandomDevice() {
    const devices = [
      { width: 1280, height: 800, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      { width: 1366, height: 768, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
      { width: 1440, height: 900, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      { width: 1536, height: 864, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' },
      { width: 1920, height: 1080, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' },
      { width: 1600, height: 900, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0' },
      { width: 1680, height: 1050, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
      { width: 1400, height: 1050, ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    ];
    const device = devices[Math.floor(Math.random() * devices.length)];
    // Add slight randomization
    device.width += Math.floor(Math.random() * 21) - 10;
    device.height += Math.floor(Math.random() * 21) - 10;
    return device;
  }

  async init() {
    this.log('Initializing browser...');

    this.currentDevice = this.getRandomDevice();
    this.log(`Using device: ${this.currentDevice.width}x${this.currentDevice.height}`);

    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: this.currentDevice.width, height: this.currentDevice.height },
      userAgent: this.currentDevice.ua,
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    this.page = await this.context.newPage();

    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this.log('Browser ready');
    await this.sheets.init();
    await this.sheets.updateStatus('scraping');
  }

  // FIX #3: Session rotation to change fingerprint
  async rotateSession() {
    this.log('Rotating session...');

    const cookies = await this.context.cookies();

    await this.page.close();
    await this.context.close();

    this.currentDevice = this.getRandomDevice();
    this.log(`New device: ${this.currentDevice.width}x${this.currentDevice.height}`);

    this.context = await this.browser.newContext({
      viewport: { width: this.currentDevice.width, height: this.currentDevice.height },
      userAgent: this.currentDevice.ua,
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    await this.context.addCookies(cookies);

    this.page = await this.context.newPage();

    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

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

  async getCreatorFromFeed() {
    const username = await this.page.evaluate(() => {
      const avatarLink = document.querySelector('a[data-e2e="video-author-avatar"]');
      if (avatarLink) {
        const href = avatarLink.getAttribute('href') || '';
        const match = href.match(/^\/@([a-zA-Z0-9._]+)/);
        if (match) return match[1];
      }
      const links = document.querySelectorAll('a[href^="/@"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/^\/@([a-zA-Z0-9._]+)/);
        if (match) {
          const rect = link.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.top > 0 && rect.top < 800) {
            return match[1];
          }
        }
      }
      return null;
    });
    return username;
  }

  async scrollToNextVideo(times = 1) {
    for (let i = 0; i < times; i++) {
      await this.page.keyboard.press('ArrowDown');
      await new Promise(r => setTimeout(r, 800 + Math.random() * 500));
    }
  }

  async escapeStuckVideo() {
    // FIX #5: Stronger escape - was 3-5 scrolls, now 10-15 with page refresh option
    this.log('  -> Escaping stuck video (aggressive scrolling)...');
    const scrollCount = 10 + Math.floor(Math.random() * 5);
    for (let i = 0; i < scrollCount; i++) {
      await this.page.keyboard.press('ArrowDown');
      await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
    }
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 500));

    // If still stuck, try a page refresh
    const username = await this.getCreatorFromFeed();
    if (!username || username === this.lastUsername) {
      this.log('  -> Still stuck, refreshing page...');
      await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 30000 });
      await this.delay(2, 4);
      // Scroll past the first few videos
      for (let i = 0; i < 5; i++) {
        await this.page.keyboard.press('ArrowDown');
        await new Promise(r => setTimeout(r, 800 + Math.random() * 400));
      }
    }
  }

  async getProfileData() {
    const data = await this.page.evaluate(() => {
      const result = {
        username: '',
        followers: '',
        bio: '',
      };

      const usernameEl = document.querySelector('h1[data-e2e="user-title"]');
      if (usernameEl) result.username = usernameEl.innerText.trim();

      const followersEl = document.querySelector('strong[data-e2e="followers-count"]');
      if (followersEl) result.followers = followersEl.innerText.trim();

      const bioEl = document.querySelector('h2[data-e2e="user-bio"]');
      if (bioEl) result.bio = bioEl.innerText.trim();

      const linkEl = document.querySelector('a[data-e2e="user-link"]');
      if (linkEl) result.bio += ' ' + linkEl.innerText.trim();

      const header = document.querySelector('[data-e2e="user-page"]');
      if (header) result.bio += ' ' + header.innerText.substring(0, 2000);

      return result;
    });
    return data;
  }

  async cooldown() {
    const now = Date.now();
    this.cooldownTimestamps.push(now);
    this.cooldownTimestamps = this.cooldownTimestamps.filter(t => now - t < 60 * 60 * 1000);

    const isStuckLoop = this.cooldownTimestamps.length >= 3;
    const cooldownEnd = new Date(now + 15 * 60 * 1000);

    if (isStuckLoop) {
      this.log('\n  !! STUCK LOOP DETECTED - 3+ cooldowns in 1 hour\n');
      await this.sheets.updateStatus('stuck-loop', cooldownEnd);
    } else {
      this.log('\n  !! COOLDOWN - 15 minutes\n');
      await this.sheets.updateStatus('cooldown', cooldownEnd);
    }

    this.notFoundCount = 0;
    this.sameUsernameCount = 0;
    this.lastUsername = null;
    this.consecutiveAlreadyChecked = 0;

    // CRITICAL FIX: Clear visited set to prevent feed saturation
    const visitedSize = this.visited.size;
    this.visited.clear();
    this.log(`  -> Cleared visited set (was ${visitedSize} entries)`);

    for (let i = 15; i > 0; i--) {
      this.log(`  ** Cooldown: ${i} min remaining **`);
      await this.delay(60, 61, false);
    }

    this.log('\n  ** Cooldown complete **\n');
    await this.sheets.updateStatus('scraping');

    await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 30000 });
    await this.delay(2, 4);
  }

  // Periodic visited set maintenance to prevent memory bloat
  pruneVisitedSet() {
    const MAX_VISITED_SIZE = 1000;
    if (this.visited.size > MAX_VISITED_SIZE) {
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
      await this.page.reload({ waitUntil: 'load', timeout: 30000 });
      await this.delay(2, 4);

      // Navigate to foryou and get fresh content
      await this.page.goto('https://www.tiktok.com/foryou', {
        waitUntil: 'load',
        timeout: 20000
      });
      await this.delay(2, 4);

      // Scroll past many videos to get completely fresh content
      const scrolls = 15 + Math.floor(Math.random() * 10);
      this.log(`  -> Scrolling past ${scrolls} videos for fresh content...`);
      for (let i = 0; i < scrolls; i++) {
        await this.page.keyboard.press('ArrowDown');
        await new Promise(r => setTimeout(r, 500 + Math.random() * 300));
      }

      // Reset stale tracking
      this.lastUsername = null;
      this.sameUsernameCount = 0;

      const newUsername = await this.getCreatorFromFeed();
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
    this.log('  -> Navigating to TikTok home to idle...');

    try {
      await this.page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
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

    await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 30000 });
    await this.delay(2, 4);
  }

  async run() {
    this.log('Going to TikTok For You feed...');
    await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 30000 });
    await this.delay(3, 6);

    this.log('Starting scrape loop...\n');
    this.log('All creators with email -> CrossCheck AI\n');
    await this.sheets.updateStatus('scraping');

    let videoCount = 0;

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

        videoCount++;
        await this.delay(2, 5);

        const username = await this.getCreatorFromFeed();
        this.log(`Video ${videoCount}: @${username || '(not found)'}`);

        if (!username) {
          this.notFoundCount++;
          if (this.notFoundCount >= 5) await this.cooldown();
          await this.scrollToNextVideo();
          continue;
        } else {
          this.notFoundCount = 0;
        }

        if (username === this.lastUsername) {
          this.sameUsernameCount++;
          this.log(`  -> Same as last (${this.sameUsernameCount}x)`);

          if (this.sameUsernameCount >= 6) {
            // FIX #6: After all escape attempts failed, enter cooldown
            await this.cooldown();
          } else if (this.sameUsernameCount >= 4) {
            // FIX #6: Try DOM refresh before resorting to cooldown
            this.log(`  -> DOM may be stale, trying page refresh...`);
            await this.refreshStaleDOM();
          } else if (this.sameUsernameCount >= 3) {
            await this.escapeStuckVideo();
          } else {
            await this.scrollToNextVideo();
          }
          continue;
        } else {
          this.sameUsernameCount = 0;
          this.lastUsername = username;
        }

        if (this.visited.has(username)) {
          this.consecutiveAlreadyChecked++;
          this.log(`  -> Already checked (${this.consecutiveAlreadyChecked}x consecutive)`);

          if (this.consecutiveAlreadyChecked >= 3) {
            await this.escapeStuckVideo();
            this.consecutiveAlreadyChecked = 0;
          } else {
            await this.scrollToNextVideo(2);
          }
          continue;
        }

        this.consecutiveAlreadyChecked = 0;
        this.visited.add(username);
        this.log(`  -> Visiting profile...`);

        await this.page.goto(`https://www.tiktok.com/@${username}`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        });
        await this.delay(2, 5);

        const data = await this.getProfileData();
        const followers = this.parseFollowers(data.followers);
        this.log(`  -> ${followers.toLocaleString()} followers`);

        const emails = this.extractEmails(data.bio);

        if (emails.length > 0) {
          this.log(`  -> IDENTIFIED for CrossCheck AI`);
          for (const email of emails) {
            this.emails.add(email);
            await this.sheets.addEmail(email, username, followers);
          }
          console.log(`\n  *** FOUND: @${username} (${followers.toLocaleString()}) -> ${emails.join(', ')} ***\n`);
        } else {
          this.log(`  -> No email in bio`);
        }

        await this.delay(1, 3);
        await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 15000 });
        await this.delay(2, 4);

        await this.scrollToNextVideo(2);

        if (videoCount % 10 === 0) {
          console.log(`\n=== ${videoCount} videos | ${this.visited.size} profiles | ${this.emails.size} emails ===\n`);
        }

        if (videoCount % 100 === 0) {
          this.log(`\n  ** 90s break **\n`);
          await this.sheets.updateStatus('break');
          await this.delay(90, 91, false);
          await this.sheets.updateStatus('scraping');
          this.pruneVisitedSet();
        }

        // FIX #3: Session rotation every 200-350 videos
        if (!this.nextRotation) this.nextRotation = 200 + Math.floor(Math.random() * 150);
        if (videoCount >= this.nextRotation) {
          this.log(`\n  ** Rotating session at video ${videoCount} **\n`);
          await this.rotateSession();
          await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 30000 });
          await this.delay(2, 4);
          this.nextRotation = videoCount + 200 + Math.floor(Math.random() * 150);
        }

      } catch (err) {
        this.log(`  !! Error: ${err.message}`);
        await this.delay(3, 8);
        try {
          await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 30000 });
          await this.delay(2, 4);
        } catch (e) {}
      }
    }
  }
}

module.exports = { TikTokScraper, CONFIG };
