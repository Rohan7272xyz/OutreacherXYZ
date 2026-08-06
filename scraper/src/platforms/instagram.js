const { BaseScraper } = require('../lib/base');
const { config } = require('../config');

const FEED_URL = 'https://www.instagram.com/reels/';

const DEVICES = [
  { width: 390, height: 844, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { width: 393, height: 852, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1' },
  { width: 430, height: 932, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' },
  { width: 428, height: 926, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1' },
  { width: 375, height: 812, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.7 Mobile/15E148 Safari/604.1' },
  { width: 360, height: 780, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  { width: 384, height: 854, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36' },
];

class InstagramScraper extends BaseScraper {
  constructor(cfg = config) {
    super('instagram', 'IG', cfg);
    this.consecutiveFailures = 0;
    this.sameUsernameCount = 0;
    this.lastUsername = null;
    this.cooldownTimestamps = [];
    this.baseUrl = cfg.baseUrl || 'https://www.instagram.com';
  }

  getRandomDevice() {
    const base = DEVICES[Math.floor(Math.random() * DEVICES.length)];
    return {
      ...base,
      width: base.width + Math.floor(Math.random() * 11) - 5,
      height: base.height + Math.floor(Math.random() * 11) - 5,
    };
  }

  feedUrl() { return this.config.baseUrl ? `${this.baseUrl}/reels/` : FEED_URL; }
  profileUrl(username) { return `${this.baseUrl}/${username}/`; }

  async clickVideo() {
    return this.page.evaluate(() => {
      for (const sel of ['video', 'article video', '[role="presentation"] video']) {
        const video = document.querySelector(sel);
        if (video) { video.click(); return true; }
      }
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      if (el) { el.click(); return true; }
      return false;
    });
  }

  async getCreatorUsername() {
    return this.page.evaluate(() => {
      for (const link of document.querySelectorAll('a[href$="/reels/"]')) {
        const match = (link.getAttribute('href') || '').match(/^\/([a-zA-Z0-9._]+)\/reels\/$/);
        if (!match) continue;
        const rect = link.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top > 0 && rect.top < 900) return match[1];
      }
      return null;
    });
  }

  async advanceFeed(count = 1) {
    for (let i = 0; i < count && !this.stopping; i++) {
      await this.page.keyboard.press('ArrowDown');
      await this.interruptibleSleep(500 + Math.random() * 400);
    }
  }

  // Only used when the feed genuinely breaks; the normal path never reloads.
  async resetToFeed(advance = 8) {
    this.log('  -> resetting the feed...');
    try {
      await this.page.goto(this.feedUrl(), { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.delay(1, 2.5);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await this.clickVideo()) break;
        await this.delay(1, 2);
      }
      await this.advanceFeed(advance);
      this.lastUsername = null;
      this.sameUsernameCount = 0;
      return !!(await this.getCreatorUsername());
    } catch (err) {
      this.log(`  -> feed reset failed: ${err.message}`);
      return false;
    }
  }

  async cooldown() {
    const now = Date.now();
    this.cooldownTimestamps = this.cooldownTimestamps.filter((t) => now - t < 2 * 60 * 60 * 1000);
    this.cooldownTimestamps.push(now);
    const cooldownEnd = new Date(now + 15 * 60 * 1000);

    if (this.cooldownTimestamps.length >= 4) {
      this.log('\n  !! repeated cooldowns — the feed may be rate limited\n');
      await this.sheets.updateStatus('stuck-loop', cooldownEnd);
    } else {
      this.log('\n  !! cooling down for 15 minutes\n');
      await this.sheets.updateStatus('cooldown', cooldownEnd);
    }

    this.consecutiveFailures = 0;
    this.sameUsernameCount = 0;
    this.lastUsername = null;
    // Forget only the recent tail: enough to unstick a saturated feed, while
    // keeping the long history that stops us re-scraping old creators.
    const forgotten = this.visited.forgetRecent(300);
    if (forgotten) this.log(`  -> released ${forgotten} recent creators back into rotation`);

    for (let i = 15; i > 0 && !this.stopping; i--) {
      this.log(`  ** cooldown: ${i} min remaining **`);
      await this.interruptibleSleep(60000);
    }
    if (this.stopping) return;

    await this.resetToFeed(10);
    this.log('\n  ** cooldown complete **\n');
    await this.sheets.updateStatus('scraping');
  }

  async skipVisitedCreators() {
    let skipped = 0;
    let username = await this.getCreatorUsername();
    while (username && this.visited.has(username) && skipped < 50 && !this.stopping) {
      skipped++;
      await this.page.keyboard.press('ArrowDown');
      await this.interruptibleSleep(150 + Math.random() * 120);
      username = await this.getCreatorUsername();
    }
    if (skipped) this.log(`  -> skipped ${skipped} already-checked creators`);
    this.stats.skipped += skipped;
    return { skipped, currentUsername: username };
  }

  async scrapeProfile(username) {
    return this.withProfileTab(this.profileUrl(username), async (tab) => {
      // Scope the text we read to this creator's own header/bio. The old code
      // also swept 3000 characters of body text, which could pull an email out
      // of a suggested-account panel and file it under the wrong username.
      return tab.evaluate(() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          return el ? (el.innerText || '') : '';
        };
        let followers = '';
        const meta = document.querySelector('meta[name="description"]');
        if (meta) {
          const m = (meta.getAttribute('content') || '').match(/([\d,.]+[KkMm]?)\s*[Ff]ollowers/);
          if (m) followers = m[1];
        }
        if (!followers) {
          const el = document.querySelector('a[href$="/followers/"], [data-testid="followers"]');
          if (el) followers = el.innerText || '';
        }
        const header = pick('header');
        const bioSection = pick('header section') || pick('main header');
        return { followers, bio: `${header}\n${bioSection}`.slice(0, 4000) };
      });
    });
  }

  async run() {
    this.log('Opening the reels feed...');
    await this.page.goto(this.feedUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.delay(1.5, 4);
    await this.clickVideo();
    await this.delay(1, 3);

    this.log(`Scraping (campaign: ${this.config.campaign}). Press Ctrl+C to stop.\n`);
    await this.sheets.updateStatus('scraping');

    let reelCount = 0;
    let nextRotation = 200 + Math.floor(Math.random() * 150);

    while (!this.stopping) {
      if (this.isInBlackoutWindow()) {
        await this.handleBlackoutPause();
        continue;
      }

      try {
        reelCount++;
        this.stats.checked = reelCount;
        const username = await this.getCreatorUsername();

        if (!username) {
          this.consecutiveFailures++;
          this.log(`Reel ${reelCount}: no creator detected (${this.consecutiveFailures}/10)`);
          if (this.consecutiveFailures >= 10) await this.cooldown();
          else if (this.consecutiveFailures >= 5) { await this.resetToFeed(); this.consecutiveFailures = 0; }
          else await this.advanceFeed();
          continue;
        }

        if (this.visited.has(username)) {
          this.log(`Reel ${reelCount}: @${username} — already checked`);
          const { currentUsername } = await this.skipVisitedCreators();
          if (!currentUsername || this.visited.has(currentUsername)) await this.resetToFeed();
          continue;
        }

        if (username === this.lastUsername) {
          this.sameUsernameCount++;
          if (this.sameUsernameCount >= 10) await this.cooldown();
          else if (this.sameUsernameCount >= 6) await this.resetToFeed(20);
          else { this.log(`  -> feed not advancing (${this.sameUsernameCount}/10)`); await this.advanceFeed(3); }
          continue;
        }

        this.consecutiveFailures = 0;
        this.sameUsernameCount = 0;
        this.lastUsername = username;
        this.visited.add(username);
        this.stats.profiles++;

        this.log(`Reel ${reelCount}: @${username} — checking profile`);
        const data = await this.scrapeProfile(username);
        await this.recordLead(username, data.followers, [data.bio]);

        // The feed tab never moved, so one press is all it takes.
        await this.delay(0.8, 2);
        await this.advanceFeed();

        if (reelCount % 10 === 0) {
          console.log(`\n=== ${reelCount} reels | ${this.stats.profiles} profiles | ${this.emails.size} emails | ${this.stats.skipped} skipped ===\n`);
        }

        if (reelCount % 100 === 0) {
          this.log('\n  ** short break **\n');
          await this.sheets.updateStatus('break');
          await this.interruptibleSleep(90000);
          await this.sheets.updateStatus('scraping');
          const pruned = this.visited.prune();
          if (pruned) this.log(`  -> pruned ${pruned} old entries from history`);
          this.visited.save();
        }

        if (reelCount >= nextRotation) {
          this.log(`\n  ** rotating session at reel ${reelCount} **\n`);
          await this.rotateSession();
          await this.resetToFeed(5);
          nextRotation = reelCount + 200 + Math.floor(Math.random() * 150);
        }
      } catch (err) {
        if (this.stopping) break;
        this.log(`  !! ${err.message}`);
        this.consecutiveFailures++;
        await this.delay(2, 6);
        if (this.consecutiveFailures >= 5) {
          await this.resetToFeed();
          this.consecutiveFailures = 0;
        }
      }
    }
  }
}

module.exports = { InstagramScraper, CONFIG: config };
