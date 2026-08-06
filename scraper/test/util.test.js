const test = require('node:test');
const assert = require('node:assert');
const {
  extractEmails, isPlausibleLeadEmail, parseFollowers, inFollowerRange,
  isInWindow, minutesUntil, parseClock, minutesOfDayInZone, isRetryableApiError, withRetry,
} = require('../src/lib/util');

test('extractEmails finds and normalises real addresses', () => {
  assert.deepStrictEqual(
    extractEmails('business: Collabs@Example-Brand.com for inquiries'),
    ['collabs@example-brand.com']
  );
  assert.deepStrictEqual(extractEmails('a@b.co and a@b.co'), ['a@b.co']);
  assert.deepStrictEqual(extractEmails('mail me at hi@studio.io.'), ['hi@studio.io']);
  assert.deepStrictEqual(extractEmails(''), []);
  assert.deepStrictEqual(extractEmails(null), []);
});

test('extractEmails rejects page furniture that looks like an address', () => {
  assert.deepStrictEqual(extractEmails('logo@2x.png'), []);
  assert.deepStrictEqual(extractEmails('noreply@mail.instagram.com'), []);
  assert.deepStrictEqual(extractEmails('privacy@tiktok.com'), []);
  assert.deepStrictEqual(extractEmails('security@facebook.com'), []);
  assert.deepStrictEqual(extractEmails('deadbeefdeadbeef1234@tracker.net'), []);
});

test('isPlausibleLeadEmail keeps genuine creator contacts', () => {
  assert.ok(isPlausibleLeadEmail('booking@talentagency.com'));
  assert.ok(isPlausibleLeadEmail('jane.doe@gmail.com'));
  assert.ok(!isPlausibleLeadEmail('notanemail'));
});

test('parseFollowers handles the formats the platforms render', () => {
  assert.strictEqual(parseFollowers('1.2M'), 1200000);
  assert.strictEqual(parseFollowers('12.3K'), 12300);
  assert.strictEqual(parseFollowers('1,234'), 1234);
  assert.strictEqual(parseFollowers('987'), 987);
  assert.strictEqual(parseFollowers('2.5B'), 2500000000);
  assert.strictEqual(parseFollowers('1.2M followers'), 1200000);
});

test('parseFollowers reports unknown rather than pretending it is zero', () => {
  assert.strictEqual(parseFollowers(''), null);
  assert.strictEqual(parseFollowers(null), null);
  assert.strictEqual(parseFollowers('Followers'), null);
});

test('inFollowerRange enforces both bounds', () => {
  const gate = { minFollowers: 10000, maxFollowers: 250000 };
  assert.ok(inFollowerRange(50000, gate));
  assert.ok(!inFollowerRange(500, gate));
  // The old engine ignored the upper bound entirely.
  assert.ok(!inFollowerRange(900000, gate));
  assert.ok(inFollowerRange(10000, gate));
  assert.ok(inFollowerRange(250000, gate));
});

test('inFollowerRange keeps leads whose follower count could not be read', () => {
  assert.ok(inFollowerRange(null, { minFollowers: 10000, maxFollowers: 250000 }));
});

test('isInWindow handles windows that wrap past midnight', () => {
  assert.ok(isInWindow(120, 75, 255));      // 02:00 inside 01:15-04:15
  assert.ok(!isInWindow(300, 75, 255));     // 05:00 outside
  assert.ok(isInWindow(30, 1380, 240));     // 00:30 inside 23:00-04:00
  assert.ok(isInWindow(1400, 1380, 240));   // 23:20 inside
  assert.ok(!isInWindow(600, 1380, 240));   // 10:00 outside
  assert.ok(!isInWindow(100, 60, 60));      // empty window
});

test('minutesUntil wraps across midnight', () => {
  assert.strictEqual(minutesUntil(120, 255), 135);
  assert.strictEqual(minutesUntil(1400, 240), 280);
});

test('parseClock reads HH:MM and falls back on nonsense', () => {
  assert.strictEqual(parseClock('01:15', 0), 75);
  assert.strictEqual(parseClock('23:59', 0), 1439);
  assert.strictEqual(parseClock('nope', 42), 42);
  assert.strictEqual(parseClock('99:99', 42), 42);
});

test('minutesOfDayInZone follows daylight saving instead of a fixed offset', () => {
  // 06:30 UTC maps to 01:30 EST in January and 02:30 EDT in July. A hardcoded
  // -5 offset — what the original code used — would report 01:30 for both.
  const winter = new Date('2026-01-15T06:30:00Z');
  const summer = new Date('2026-07-15T06:30:00Z');
  assert.strictEqual(minutesOfDayInZone(winter, 'America/New_York'), 90);
  assert.strictEqual(minutesOfDayInZone(summer, 'America/New_York'), 150);
});

test('isRetryableApiError distinguishes transient failures from real ones', () => {
  assert.ok(isRetryableApiError({ code: 429 }));
  assert.ok(isRetryableApiError({ code: 503 }));
  assert.ok(isRetryableApiError({ message: 'socket hang up' }));
  assert.ok(!isRetryableApiError({ code: 404 }));
  assert.ok(!isRetryableApiError({ code: 403, message: 'permission denied' }));
});

test('withRetry recovers from a transient failure', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('rate limited'), { code: 429 });
    return 'ok';
  }, { baseMs: 1 });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 3);
});

test('withRetry gives up immediately on a permanent failure', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls++;
    throw Object.assign(new Error('not found'), { code: 404 });
  }, { baseMs: 1 }));
  assert.strictEqual(calls, 1);
});
