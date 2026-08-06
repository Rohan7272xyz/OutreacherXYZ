const { BaseScraper } = require('../lib/base');
const { config } = require('../config');

const DEVICES = [
  { width: 1280, height: 800, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  { width: 1366, height: 768, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
  { width: 1440, height: 900, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  { width: 1536, height: 864, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' },
  { width: 1920, height: 1080, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' },
  { width: 1600, height: 900, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0' },
  { width: 1680, height: 1050, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
  { width: 1400, height: 1050, ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
];

class TikTokScraper extends BaseScraper {
  constructor(cfg = config) {
    super('tiktok', 'TT', cfg);
    this.notFoundCount = 0;
    this.sameUsernameCount = 0;
    this.lastUsername = null;
    this.consecutiveAlreadyChecked = 0;
    this.cooldownTimestamps = [];
    this.baseUrl = cfg.baseUrl || 'https://www.tiktok.com';
  }

  getRandomDevice() {
    const base = DEVICES[Math.floor(Math.random() * DEVICES.length)];
    return {
      ...base,
      width: base.width + Math.floor(Math.random() * 21) - 10,
      height: base.height + Math.floor(Math.random() * 21) - 10,
    };
  }

  feedUrl() { return `${this.baseUrl}/foryou`; }
  profileUrl(username) { return `${this.baseUrl}/@${username}`; }

  async init() {
    await super.init();
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }

  async getCreatorFromFeed() {
    return this.page.evaluate(() => {
      const avatar = document.querySelector('a[data-e2e="video-author-avatar"]');
      if (avatar) {
        const m = (avatar.getAttribute('href') || '').match(/^\/@([a-zA-Z0-9._]+)/);
        if (m) return m[1];
      }
      for (const link of document.querySelectorAll('a[href^="/@"]')) {
        const m = (link.getAttribute('href') || '').match(/^\/@([a-zA-Z0-9._]+)/);
        if (!m) continue;
        const rect = link.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top > 0 && rect.top < 800) return m[1];
      }
      return null;
    });
  }

  async advanceFeed(count = 1) {
    for (let i = 0; i < count && !this.stopping; i++) {
      await this.page.keyboard.press('ArrowDown');
      await this.interruptibleSleep(700 + Math.random() * 500);
    }
  }

  async resetToFeed(advance = 5) {
    this.log('  -> resetting the feed...');
    try {
      await this.page.goto(this.feedUrl(), { waitUntil: 'domcontentloaded', timeout: 25000 });
      await this.delay(2, 4);
      await this.advanceFeed(advance);
      this.lastUsername = null;
      this.sameUsernameCount = 0;
      return true;
    } catch (err) {
      this.log(`  -> feed reset failed: ${err.message}`);
      return false;
    }
  }

  async escapeStuckVideo() {
    this.log('  -> feed stuck, scrolling clear...');
    await this.advanceFeed(10 + Math.floor(Math.random() * 5));
    const username = await this.getCreatorFromFeed();
    if (!username || username === this.lastUsername) await this.resetToFeed();
  }

  async cooldown() {
    const now = Date.now();
    this.cooldownTimestamps = this.cooldownTimestamps.filter((t) => now - t < 60 * 60 * 1000);
    this.cooldownTimestamps.push(now);
    const cooldownEnd = new Date(now + 15 * 60 * 1000);

    if (this.cooldownTimestamps.length >= 3) {
      this.log('\n  !! repeated cooldowns — the feed may be rate limited\n');
      await this.sheets.updateStatus('stuck-loop', cooldownEnd);
    } else {
      this.log('\n  !! cooling down for 15 minutes\n');
      await this.sheets.updateStatus('cooldown', cooldownEnd);
    }

    this.notFoundCount = 0;
    this.sameUsernameCount = 0;
    this.lastUsername = null;
    this.consecutiveAlreadyChecked = 0;
    const forgotten = this.visited.forgetRecent(300);
    if (forgotten) this.log(`  -> released ${forgotten} recent creators back into rotation`);

    for (let i = 15; i > 0 && !this.stopping; i--) {
      this.log(`  ** cooldown: ${i} min remaining **`);
      await this.interruptibleSleep(60000);
    }
    if (this.stopping) return;

    await this.resetToFeed();
    this.log('\n  ** cooldown complete **\n');
    await this.sheets.updateStatus('scraping');
  }

  async scrapeProfile(username) {
    return this.withProfileTab(this.profileUrl(username), async (tab) => tab.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || '').trim() : '';
      };
      return {
        followers: pick('strong[data-e2e="followers-count"]'),
        // Bio and the linked website only — not the whole page, which would
        // sweep in emails from video captions and other creators' panels.
        bio: [pick('h2[data-e2e="user-bio"]'), pick('a[data-e2e="user-link"]')].join(' ').trim(),
      };
    }));
  }

  async run() {
    this.log('Opening the For You feed...');
    await this.page.goto(this.feedUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.delay(3, 6);

    this.log(`Scraping (campaign: ${this.config.campaign}). Press Ctrl+C to stop.\n`);
    await this.sheets.updateStatus('scraping');

    let videoCount = 0;
    let nextRotation = 200 + Math.floor(Math.random() * 150);

    while (!this.stopping) {
      if (this.isInBlackoutWindow()) {
        await this.handleBlackoutPause();
        continue;
      }

      try {
        videoCount++;
        this.stats.checked = videoCount;
        await this.delay(1.5, 4);

        const username = await this.getCreatorFromFeed();

        if (!username) {
          this.notFoundCount++;
          this.log(`Video ${videoCount}: no creator detected (${this.notFoundCount}/5)`);
          if (this.notFoundCount >= 5) { await this.cooldown(); this.notFoundCount = 0; }
          else await this.advanceFeed();
          continue;
        }
        this.notFoundCount = 0;

        if (username === this.lastUsername) {
          this.sameUsernameCount++;
          this.log(`Video ${videoCount}: still @${username} (${this.sameUsernameCount})`);
          if (this.sameUsernameCount >= 6) await this.cooldown();
          else if (this.sameUsernameCount >= 4) await this.resetToFeed(15);
          else if (this.sameUsernameCount >= 3) await this.escapeStuckVideo();
          else await this.advanceFeed();
          continue;
        }
        this.sameUsernameCount = 0;
        this.lastUsername = username;

        if (this.visited.has(username)) {
          this.consecutiveAlreadyChecked++;
          this.log(`Video ${videoCount}: @${username} — already checked (${this.consecutiveAlreadyChecked})`);
          this.stats.skipped++;
          if (this.consecutiveAlreadyChecked >= 3) {
            await this.escapeStuckVideo();
            this.consecutiveAlreadyChecked = 0;
          } else {
            await this.advanceFeed(2);
          }
          continue;
        }

        this.consecutiveAlreadyChecked = 0;
        this.visited.add(username);
        this.stats.profiles++;

        this.log(`Video ${videoCount}: @${username} — checking profile`);
        const data = await this.scrapeProfile(username);
        await this.recordLead(username, data.followers, [data.bio]);

        // Feed tab kept its place, so no reload and no re-scrolling.
        await this.delay(1, 2.5);
        await this.advanceFeed();

        if (videoCount % 10 === 0) {
          console.log(`\n=== ${videoCount} videos | ${this.stats.profiles} profiles | ${this.emails.size} emails | ${this.stats.skipped} skipped ===\n`);
        }

        if (videoCount % 100 === 0) {
          this.log('\n  ** short break **\n');
          await this.sheets.updateStatus('break');
          await this.interruptibleSleep(90000);
          await this.sheets.updateStatus('scraping');
          const pruned = this.visited.prune();
          if (pruned) this.log(`  -> pruned ${pruned} old entries from history`);
          this.visited.save();
        }

        if (videoCount >= nextRotation) {
          this.log(`\n  ** rotating session at video ${videoCount} **\n`);
          await this.rotateSession();
          await this.resetToFeed();
          nextRotation = videoCount + 200 + Math.floor(Math.random() * 150);
        }
      } catch (err) {
        if (this.stopping) break;
        this.log(`  !! ${err.message}`);
        await this.delay(3, 8);
        await this.resetToFeed();
      }
    }
  }
}

module.exports = { TikTokScraper, CONFIG: config };
