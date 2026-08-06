// Drives the Instagram scraper's main loop against a stubbed browser. This is
// where the tab-based navigation is verified: the feed page must never be
// re-navigated while profiles are being checked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outreacher-engine-'));
process.env.OUTPUT_DIR = workDir;
process.env.SHEET_ID = '';
process.env.MIN_FOLLOWERS = '10000';
process.env.MAX_FOLLOWERS = '250000';
process.env.PERSIST_VISITED = '0';
process.env.BLACKOUT_ENABLED = '0';

const { config } = require('../src/config');
const { InstagramScraper } = require('../src/platforms/instagram');

const CREATORS = [
  { username: 'alpha', followers: '48.2K', bio: 'business: alpha@studio.com' },
  { username: 'beta', followers: '1.2M', bio: 'contact beta@huge.com' },      // over the ceiling
  { username: 'gamma', followers: '15.7K', bio: 'gamma@films.co' },
  { username: 'delta', followers: '900', bio: 'delta@tiny.com' },             // under the floor
  { username: 'epsilon', followers: '88K', bio: 'hi@epsilon.co' },
];

function buildScraper() {
  const state = {
    index: 0,
    feedGotos: [],
    profileTabsOpened: [],
    profileTabsClosed: 0,
    arrowPresses: 0,
    broughtToFront: 0,
  };

  const feedPage = {
    url: () => 'https://www.instagram.com/reels/',
    goto: async (u) => { state.feedGotos.push(u); },
    keyboard: {
      press: async (key) => {
        if (key === 'ArrowDown') {
          state.arrowPresses++;
          state.index++;
        }
      },
    },
    // The feed page's only evaluate() call is getCreatorUsername.
    evaluate: async () => {
      const creator = CREATORS[state.index];
      return creator ? creator.username : null;
    },
    bringToFront: async () => { state.broughtToFront++; },
    close: async () => {},
  };

  const context = {
    newPage: async () => {
      let navigatedTo = null;
      return {
        goto: async (u) => { navigatedTo = u; state.profileTabsOpened.push(u); },
        // The profile tab's evaluate() call is the bio/follower scrape.
        evaluate: async () => {
          const name = (navigatedTo || '').replace(/\/$/, '').split('/').pop();
          const creator = CREATORS.find((c) => c.username === name);
          return creator
            ? { followers: creator.followers, bio: creator.bio }
            : { followers: '', bio: '' };
        },
        close: async () => { state.profileTabsClosed++; },
      };
    },
    cookies: async () => [],
    close: async () => {},
    addCookies: async () => {},
    addInitScript: async () => {},
  };

  const scraper = new InstagramScraper({ ...config, campaign: 'test' });
  scraper.page = feedPage;
  scraper.context = context;
  scraper.browser = { close: async () => {}, isConnected: () => false };
  scraper.delay = async () => {};
  scraper.interruptibleSleep = async () => {};
  scraper.clickVideo = async () => true;

  // End the run once the fixture creators are exhausted.
  const originalGetUsername = scraper.getCreatorUsername.bind(scraper);
  scraper.getCreatorUsername = async () => {
    if (state.index >= CREATORS.length) { scraper.stopping = true; return null; }
    return originalGetUsername();
  };

  return { scraper, state };
}

test('profiles open in their own tab and the feed page is never re-navigated', async () => {
  const { scraper, state } = buildScraper();
  await scraper.run();

  assert.strictEqual(state.profileTabsOpened.length, 5, 'one tab per creator');
  assert.strictEqual(state.profileTabsClosed, 5, 'every profile tab was closed');
  // The single entry is the initial navigation in run(); the old engine added
  // one feed reload per creator on top of that.
  assert.strictEqual(state.feedGotos.length, 1,
    `feed was re-navigated ${state.feedGotos.length} times: ${state.feedGotos.join(', ')}`);
  assert.ok(state.broughtToFront >= 5, 'feed tab was refocused after each profile');
});

test('the feed advances one step per creator instead of dozens', async () => {
  const { scraper, state } = buildScraper();
  await scraper.run();
  // Five creators, one ArrowDown each. The old path pressed 15-25 per creator
  // because it restarted the feed every time.
  assert.ok(state.arrowPresses <= 8,
    `expected roughly one advance per creator, got ${state.arrowPresses}`);
});

test('the follower gate excludes creators outside both bounds', async () => {
  const { scraper } = buildScraper();
  await scraper.run();
  const collected = [...scraper.emails];
  assert.ok(collected.includes('alpha@studio.com'));
  assert.ok(collected.includes('gamma@films.co'));
  assert.ok(collected.includes('hi@epsilon.co'));
  assert.ok(!collected.includes('beta@huge.com'), 'beta is above the ceiling');
  assert.ok(!collected.includes('delta@tiny.com'), 'delta is below the floor');
});

test('every creator is recorded as visited so they are not rechecked', async () => {
  const { scraper } = buildScraper();
  await scraper.run();
  for (const c of CREATORS) {
    assert.ok(scraper.visited.has(c.username), `${c.username} not marked visited`);
  }
});

test('shutdown closes the browser and reports totals', async () => {
  const { scraper } = buildScraper();
  await scraper.run();
  let closed = false;
  scraper.browser = { close: async () => { closed = true; }, isConnected: () => false };
  await scraper.shutdown('test');
  assert.ok(closed, 'browser was not closed');
  assert.strictEqual(scraper.stats.profiles, 5);
});

test.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
