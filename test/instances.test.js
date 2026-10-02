// Service instance precedence, ETSI TS 103 770 V1.2.1 clause 5.2.13, and scheduled service hours,
// clauses 5.2.5.2 and 5.5.15 (public/instances.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const I = require('../public/instances.js');

const H = 3600000, D = 24 * H;
const t = s => Date.parse(s);
const iv = (o = {}) => ({ days: [1, 2, 3, 4, 5, 6, 7], recurrence: 1, recurrenceGiven: false, start: 0, end: D - 1, ...o });
const period = (o = {}) => ({ validFrom: null, validTo: null, intervals: [], ...o });

test('no Availability element: always available', () => {
  assert.equal(I.isAvailable(null, t('2026-10-02T12:00:00Z')), true);
  assert.equal(I.nextChange(null, 0), null);
});

test('clause 5.2.5.2 example: on air only in July and September 2019, the union of Periods', () => {
  const av = { periods: [
    period({ validFrom: t('2019-07-01T00:00:00Z'), validTo: t('2019-07-31T23:59:59Z') }),
    period({ validFrom: t('2019-09-01T00:00:00Z'), validTo: t('2019-09-30T23:59:59Z') }),
  ] };
  assert.equal(I.isAvailable(av, t('2019-07-15T10:00:00Z')), true);
  assert.equal(I.isAvailable(av, t('2019-08-15T10:00:00Z')), false);
  assert.equal(I.isAvailable(av, t('2019-09-15T10:00:00Z')), true);
  assert.equal(I.nextChange(av, t('2019-08-15T10:00:00Z')), t('2019-09-01T00:00:00Z'));
});

test('clause 5.2.5.2 example: Mondays and Wednesdays 16:00 to 16:30 UTC', () => {
  const av = { periods: [period({ intervals: [iv({ days: [1, 3], start: 16 * H, end: 16.5 * H })] })] };
  assert.equal(I.isAvailable(av, t('2026-09-28T16:10:00Z')), true, 'Monday 16:10');
  assert.equal(I.isAvailable(av, t('2026-09-28T16:30:00Z')), false, 'Monday 16:30 is the end');
  assert.equal(I.isAvailable(av, t('2026-09-29T16:10:00Z')), false, 'Tuesday');
  assert.equal(I.isAvailable(av, t('2026-09-30T16:10:00Z')), true, 'Wednesday');
  assert.equal(I.nextChange(av, t('2026-09-29T09:00:00Z')), t('2026-09-30T16:00:00Z'));
  assert.equal(I.nextChange(av, t('2026-09-30T16:10:00Z')), t('2026-09-30T16:30:00Z'));
});

test('table 26 @endTime: an end at or before the start runs into the following day', () => {
  const av = { periods: [period({ intervals: [iv({ days: [5], start: 22 * H, end: 2 * H })] })] };
  assert.equal(I.isAvailable(av, t('2026-10-02T23:00:00Z')), true, 'Friday 23:00');
  assert.equal(I.isAvailable(av, t('2026-10-03T01:00:00Z')), true, 'Saturday 01:00, from Friday');
  assert.equal(I.isAvailable(av, t('2026-10-03T02:00:00Z')), false);
  assert.equal(I.isAvailable(av, t('2026-10-03T23:00:00Z')), false, 'Saturday is not a start day');
});

test('clause 5.2.5.2: @recurrence counts weeks from the week of @validFrom', () => {
  // Fortnightly on Thursdays, starting the week of Thursday 1 October 2026.
  const av = { periods: [period({ validFrom: t('2026-10-01T00:00:00Z'),
    intervals: [iv({ days: [4], recurrence: 2, recurrenceGiven: true, start: 20 * H, end: 21 * H })] })] };
  assert.equal(I.isAvailable(av, t('2026-10-01T20:30:00Z')), true, 'week 0');
  assert.equal(I.isAvailable(av, t('2026-10-08T20:30:00Z')), false, 'week 1');
  assert.equal(I.isAvailable(av, t('2026-10-15T20:30:00Z')), true, 'week 2');
  assert.equal(I.nextChange(av, t('2026-10-02T00:00:00Z')), t('2026-10-15T20:00:00Z'));
});

test('clause 5.2.5.2: an Interval with @recurrence but no @validFrom is ignored', () => {
  const av = { periods: [period({ intervals: [iv({ days: [1], recurrence: 2, recurrenceGiven: true, start: 0, end: H })] })] };
  assert.equal(I.isAvailable(av, t('2026-09-29T12:00:00Z')), true, 'the Period without usable Intervals covers its validity');
});

test('Period bounds limit its Intervals', () => {
  const av = { periods: [period({ validFrom: t('2026-10-05T00:00:00Z'), intervals: [iv({ start: 9 * H, end: 10 * H })] })] };
  assert.equal(I.isAvailable(av, t('2026-10-04T09:30:00Z')), false);
  assert.equal(I.isAvailable(av, t('2026-10-05T09:30:00Z')), true);
});

const caps = { dash: true, hls: true, eme: true, keySystem: id => ({ 'urn:uuid:w': 'com.widevine.alpha' })[id] || null };
const inst = (o = {}) => ({ type: 'application/dash+xml', priority: 0, availability: null, protection: null, ...o });

test('clause 5.2.13: instances outside their scheduled hours are not evaluated', () => {
  const now = t('2026-10-02T12:00:00Z');
  const past = { periods: [period({ validTo: t('2026-10-01T00:00:00Z') })] };
  assert.deepEqual(I.candidates([inst({ priority: 1, availability: past }), inst({ priority: 2 })], now, caps), [1]);
});

test('clause 5.2.13: instances known in advance not to play are discarded', () => {
  const cases = [
    [inst({ type: 'multicast' }), /multicast/],
    [inst(), /no DASH player/, { ...caps, dash: false }],
    [inst({ type: 'application/vnd.apple.mpegurl' }), /no HLS player/, { ...caps, hls: false }],
    [inst({ protection: { allSystems: {}, caSystems: ['0x0B00'] } }), /conditional access only/],
    [inst({ protection: { allSystems: { 'urn:uuid:w': '' }, caSystems: [] } }), /Encrypted Media Extensions/, { ...caps, eme: false }],
    [inst({ protection: { allSystems: { 'urn:uuid:unknown': '' }, caSystems: [] } }), /DRM systems this client does not know/],
  ];
  for (const [i, why, c] of cases) {
    assert.match(I.cannotPlay(i, c || caps), why);
    assert.deepEqual(I.candidates([i], 0, c || caps), []);
  }
  assert.equal(I.cannotPlay(inst({ protection: { allSystems: { 'urn:uuid:unknown': '', 'urn:uuid:w': '' }, caSystems: ['0x0B00'] } }), caps), null,
    'one usable DRM system is enough, whatever else is listed');
});

test('clause 5.2.13: otherwise @priority is respected, lower first, ties in document order', () => {
  assert.deepEqual(I.candidates([inst({ priority: 3 }), inst({ priority: 0 }), inst({ priority: 3 }), inst({ priority: 1 })], 0, caps), [1, 3, 0, 2]);
  assert.deepEqual(I.candidates([inst({ priority: 0 }), inst({ priority: 1 })], 0, caps, new Set([0])), [1], 'a failed instance is set aside');
});
