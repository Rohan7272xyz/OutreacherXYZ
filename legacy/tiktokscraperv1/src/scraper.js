const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SheetsSync } = require('./sheets');

const CONFIG = {
  minFollowers: 10000,    // Accepting 10k+ (Sheet2 starts at 10k)
  maxFollowers: Infinity, // No upper limit (Sheet1 accepts 100k+)
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
    this.consecutiveAlreadyChecked = 0; // Track consecutive "already checked"

    if (!fs.existsSync(config.outputDir)) {
      fs.mkdirSync(config.outputDir, { recursive: true });
    }
  }

  log(msg) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${time}] ${msg}`);
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

  async init() {
    this.log('Initializing browser...');
    
    const userDataDir = path.join(__dirname, '..', 'browser-profile');
    
    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: this.config.headless,
      viewport: { width: 1280, height: 800 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });
    
    this.page = this.context.pages()[0] || await this.context.newPage();
    
    // Stealth: override navigator.webdriver
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    
    this.log('Browser ready');
    await this.sheets.init();
    await this.sheets.updateStatus('scraping');
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
    // Extract username from current video in For You feed
    const username = await this.page.evaluate(() => {
      // Method 1: video-author-avatar link
      const avatarLink = document.querySelector('a[data-e2e="video-author-avatar"]');
      if (avatarLink) {
        const href = avatarLink.getAttribute('href') || '';
        const match = href.match(/^\/@([a-zA-Z0-9._]+)/);
        if (match) return match[1];
      }
      // Method 2: any link with /@username pattern in main content
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
    // More aggressive escape: scroll multiple times and wait longer
    this.log('  -> Escaping stuck video (multiple scrolls)...');
    const scrollCount = 3 + Math.floor(Math.random() * 3); // 3-5 scrolls
    for (let i = 0; i < scrollCount; i++) {
      await this.page.keyboard.press('ArrowDown');
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
    }
    // Additional wait to let new content load
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
  }

  async getProfileData() {
    // Extract data from profile page using TikTok selectors
    const data = await this.page.evaluate(() => {
      const result = {
        username: '',
        followers: '',
        bio: '',
      };
      
      // Username
      const usernameEl = document.querySelector('h1[data-e2e="user-title"]');
      if (usernameEl) result.username = usernameEl.innerText.trim();
      
      // Followers count
      const followersEl = document.querySelector('strong[data-e2e="followers-count"]');
      if (followersEl) result.followers = followersEl.innerText.trim();
      
      // Bio
      const bioEl = document.querySelector('h2[data-e2e="user-bio"]');
      if (bioEl) result.bio = bioEl.innerText.trim();
      
      // Also grab any links in bio area
      const linkEl = document.querySelector('a[data-e2e="user-link"]');
      if (linkEl) result.bio += ' ' + linkEl.innerText.trim();
      
      // Fallback: grab all text from profile header area
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
    this.consecutiveAlreadyChecked = 0; // Reset this too
    
    for (let i = 15; i > 0; i--) {
      this.log(`  ** Cooldown: ${i} min remaining **`);
      await this.delay(60, 61, false);
    }
    
    this.log('\n  ** Cooldown complete **\n');
    await this.sheets.updateStatus('scraping');
    
    // Refresh page after cooldown
    await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 30000 });
    await this.delay(2, 4);
  }


  // WiFi blackout window: 1:15 AM - 4:15 AM EST
  isInBlackoutWindow() {
    const now = new Date();
    const estOffset = -5; // EST is UTC-5 (adjust to -4 for EDT if needed)
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const est = new Date(utc + 3600000 * estOffset);
    const hours = est.getHours();
    const minutes = est.getMinutes();
    const timeInMinutes = hours * 60 + minutes;
    // 1:15 AM = 75 minutes, 4:15 AM = 255 minutes
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
    // 4:15 AM = 255 minutes
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
    
    // Sleep in 5-minute chunks so we can log progress
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
    
    // Return to For You feed
    await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 30000 });
    await this.delay(2, 4);
  }

  async run() {
    this.log('Going to TikTok For You feed...');
    await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 30000 });
    await this.delay(3, 6);

    this.log('Starting scrape loop...\n');
    this.log('Follower routing: 10k-99k -> Sheet2 (CreatorPredict), 100k+ -> Sheet1 (CoinFluence)\n');
    await this.sheets.updateStatus('scraping');

    let videoCount = 0;

    while (true) {
      // Check for WiFi blackout window (1:15-4:15 AM EST)
      if (this.isInBlackoutWindow()) {
        await this.handleBlackoutPause();
        continue;
      }

      try {
        // Random distraction (5% chance)
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

        // Check if same username as last video (regardless of visited status)
        if (username === this.lastUsername) {
          this.sameUsernameCount++;
          this.log(`  -> Same as last (${this.sameUsernameCount}x)`);
          
          // After 3 repeats, try aggressive escape instead of simple scroll
          if (this.sameUsernameCount >= 3 && this.sameUsernameCount < 5) {
            await this.escapeStuckVideo();
          } else if (this.sameUsernameCount >= 5) {
            await this.cooldown();
          } else {
            await this.scrollToNextVideo();
          }
          continue;
        } else {
          this.sameUsernameCount = 0;
          this.lastUsername = username;
        }

        // Check if already visited
        if (this.visited.has(username)) {
          this.consecutiveAlreadyChecked++;
          this.log(`  -> Already checked (${this.consecutiveAlreadyChecked}x consecutive)`);
          
          // If we keep hitting already-checked users, scroll more aggressively
          if (this.consecutiveAlreadyChecked >= 3) {
            await this.escapeStuckVideo();
            this.consecutiveAlreadyChecked = 0; // Reset after aggressive scroll
          } else {
            await this.scrollToNextVideo(2); // Scroll 2x for already-checked
          }
          continue;
        }

        // New user - reset consecutive counter
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

        if (followers >= this.config.minFollowers) {
          const company = followers >= 250000 ? 'CoinFluence' : 'CreatorPredict';
          this.log(`  -> IDENTIFIED: ${company}`);
          const emails = this.extractEmails(data.bio);
          
          if (emails.length > 0) {
            for (const email of emails) {
              this.emails.add(email);
              // sheets.addEmail will route to correct sheet based on followers
              await this.sheets.addEmail(email, username, followers);
            }
            const targetSheet = followers >= 250000 ? 'CoinFluence' : 'CreatorPredict';
            console.log(`\n  *** FOUND: @${username} (${followers.toLocaleString()}) -> ${emails.join(', ')} -> ${targetSheet} ***\n`);
          } else {
            this.log(`  -> No email in bio`);
          }
        } else {
          this.log(`  -> Outside range (need 10k+)`);
        }

        // Go back to For You feed
        await this.delay(1, 3);
        await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'load', timeout: 15000 });
        await this.delay(2, 4);
        
        // Scroll past the video we just checked to avoid re-detecting it
        await this.scrollToNextVideo(2);

        // Progress report every 10 videos
        if (videoCount % 10 === 0) {
          console.log(`\n=== ${videoCount} videos | ${this.visited.size} profiles | ${this.emails.size} emails ===\n`);
        }

        // Break every 100 videos
        if (videoCount % 100 === 0) {
          this.log(`\n  ** 90s break **\n`);
          await this.sheets.updateStatus('break');
          await this.delay(90, 91, false);
          await this.sheets.updateStatus('scraping');
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