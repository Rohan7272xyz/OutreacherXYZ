// Central runtime config. Everything is overridable by environment variable so
// the control panel (app/server.js) can drive the scraper without editing code.
const os = require('os');
const { parseClock } = require('./lib/util');

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

const env = process.env;

const config = {
  sheetId: env.SHEET_ID || '',
  // Tab that collected leads are appended to.
  leadsTab: env.LEADS_TAB || 'crosscheck',
  // Shown in logs; purely cosmetic labelling of the campaign.
  campaign: env.CAMPAIGN_NAME || 'outreach',
  deviceName: env.DEVICE_NAME || os.hostname(),
  headless: bool(env.HEADLESS, false),
  outputDir: env.OUTPUT_DIR || './output',

  // Follower gate. Blank = no bound.
  minFollowers: num(env.MIN_FOLLOWERS, 0),
  maxFollowers: num(env.MAX_FOLLOWERS, Infinity),

  // How many profiles to open per hour. The engine can go roughly 450/hr flat
  // out, which looks nothing like a person browsing and is what gets an account
  // rate limited or challenged. Default well below that; 0 removes the limit.
  profilesPerHour: num(env.PROFILES_PER_HOUR, 120),

  // Optional nightly pause, for machines whose network is cut on a schedule.
  // Off unless BLACKOUT_ENABLED is set — it was specific to one original host.
  blackout: {
    enabled: bool(env.BLACKOUT_ENABLED, false),
    startMinutes: parseClock(env.BLACKOUT_START, 75),
    endMinutes: parseClock(env.BLACKOUT_END, 255),
    timeZone: env.BLACKOUT_TZ || 'America/New_York',
  },

  // Remember which creators we've already checked between runs.
  persistVisited: bool(env.PERSIST_VISITED, true),
  maxVisited: num(env.MAX_VISITED, 5000),
};

module.exports = { config };
