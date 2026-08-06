// Pure helpers shared by both platform scrapers. No browser or network access,
// so everything here is covered by test/util.test.js.

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}/g;

// Addresses that show up in page furniture rather than in a creator's bio.
const NOISE_DOMAINS = new Set([
  'instagram.com', 'tiktok.com', 'facebook.com', 'meta.com', 'fb.com',
  'example.com', 'example.org', 'sentry.io', 'w3.org', 'schema.org',
]);
const NOISE_LOCALPARTS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'privacy', 'abuse',
  'postmaster', 'webmaster', 'security', 'legal', 'copyright', 'dmca',
]);
// Image/asset filenames that satisfy the email shape (e.g. logo@2x.png).
const ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'css', 'js', 'json']);

function isPlausibleLeadEmail(email) {
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  const tld = domain.slice(domain.lastIndexOf('.') + 1);

  if (ASSET_EXTENSIONS.has(tld)) return false;
  if (NOISE_DOMAINS.has(domain)) return false;
  if (NOISE_LOCALPARTS.has(local)) return false;
  if (domain.endsWith('.instagram.com') || domain.endsWith('.tiktok.com')) return false;
  // Hex blobs and tracking ids masquerading as addresses.
  if (/^[0-9a-f]{16,}$/.test(local)) return false;
  if (email.length > 100) return false;
  return true;
}

function extractEmails(text) {
  if (!text) return [];
  const matches = String(text).match(EMAIL_REGEX);
  if (!matches) return [];
  const cleaned = matches
    .map((e) => e.toLowerCase().replace(/[.,;:]+$/, ''))
    .filter(isPlausibleLeadEmail);
  return [...new Set(cleaned)];
}

// "1.2M" / "12.3K" / "1,234" / "1.2 mil" -> integer. Returns null when there is
// no number to read, so callers can tell "zero followers" from "couldn't parse".
function parseFollowers(text) {
  if (text === null || text === undefined) return null;
  const raw = String(text).toLowerCase().replace(/,/g, '').trim();
  const m = raw.match(/(\d+(?:\.\d+)?)\s*([kmb])?/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.floor(value * mult);
}

function inFollowerRange(followers, { minFollowers = 0, maxFollowers = Infinity } = {}) {
  // Unknown follower count is not a reason to discard a lead that has an email.
  if (followers === null) return true;
  return followers >= (minFollowers || 0) && followers <= (maxFollowers === null ? Infinity : maxFollowers);
}

function randomDelayMs(minSec, maxSec, jitter = true) {
  let ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
  if (jitter) ms *= 0.85 + Math.random() * 0.3;
  return Math.max(0, ms);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Minutes since midnight in an IANA zone. Uses Intl so daylight saving is
// handled by the platform rather than a hardcoded UTC offset.
function minutesOfDayInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return hour * 60 + minute;
}

// Window may wrap past midnight (e.g. 23:00 -> 04:00).
function isInWindow(nowMinutes, startMinutes, endMinutes) {
  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? nowMinutes >= startMinutes && nowMinutes < endMinutes
    : nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function minutesUntil(nowMinutes, endMinutes) {
  const diff = endMinutes - nowMinutes;
  return diff > 0 ? diff : diff + 1440;
}

function parseClock(value, fallbackMinutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return fallbackMinutes;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallbackMinutes;
  return h * 60 + min;
}

function isRetryableApiError(err) {
  const code = err && (err.code || err.status || (err.response && err.response.status));
  if ([429, 500, 502, 503, 504].includes(Number(code))) return true;
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test((err && err.message) || '');
}

// Retries transient Google API failures so a blip doesn't drop a lead.
async function withRetry(fn, { attempts = 4, baseMs = 500, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetryableApiError(err)) throw err;
      const wait = baseMs * 2 ** i + Math.random() * 250;
      if (onRetry) onRetry(err, i + 1, Math.round(wait));
      await sleep(wait);
    }
  }
  throw lastErr;
}

module.exports = {
  EMAIL_REGEX,
  isPlausibleLeadEmail,
  extractEmails,
  parseFollowers,
  inFollowerRange,
  randomDelayMs,
  sleep,
  minutesOfDayInZone,
  isInWindow,
  minutesUntil,
  parseClock,
  isRetryableApiError,
  withRetry,
};
