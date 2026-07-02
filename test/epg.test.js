const { test } = require('node:test');
const assert = require('node:assert/strict');
const DVBIEpg = require('../public/epg.js');

test('parseISODuration: hours/minutes/seconds', () => {
  assert.equal(DVBIEpg.parseISODuration('PT1H'), 3600000);
  assert.equal(DVBIEpg.parseISODuration('PT30M'), 1800000);
  assert.equal(DVBIEpg.parseISODuration('PT1H30M'), 5400000);
  assert.equal(DVBIEpg.parseISODuration('PT15S'), 15000);
  assert.equal(DVBIEpg.parseISODuration('PT0S'), 0);
});

test('parseISODuration: day component (P1DT2H)', () => {
  assert.equal(DVBIEpg.parseISODuration('P1DT2H'), (86400 + 7200) * 1000);
  assert.equal(DVBIEpg.parseISODuration('P2D'), 2 * 86400 * 1000);
});

test('parseISODuration: case-insensitive and fractional', () => {
  assert.equal(DVBIEpg.parseISODuration('pt1h30m'), 5400000);
  assert.equal(DVBIEpg.parseISODuration('PT1.5H'), 5400000);
});

test('parseISODuration: invalid/empty input returns 0', () => {
  assert.equal(DVBIEpg.parseISODuration(''), 0);
  assert.equal(DVBIEpg.parseISODuration(null), 0);
  assert.equal(DVBIEpg.parseISODuration('not a duration'), 0);
  assert.equal(DVBIEpg.parseISODuration('PTX'), 0);
});

function ev(startOffsetMin, durMin, extra) {
  const start = new Date(Date.now() + startOffsetMin * 60000);
  const end = new Date(start.getTime() + durMin * 60000);
  return { title: `ev@${startOffsetMin}`, start, end, durMs: durMin * 60000, ...extra };
}

test('getNowNext: returns current and next when a programme is airing', () => {
  const events = [ev(-30, 30), ev(0, 30), ev(30, 30)];
  const { current, next } = DVBIEpg.getNowNext(events);
  assert.equal(current.title, 'ev@0');
  assert.equal(next.title, 'ev@30');
});

test('getNowNext: during a gap, next is the first UPCOMING event, not the earliest', () => {
  // ev@-60 already ended (started 60min ago, 30min long -> ended 30min ago); ev@30 is upcoming.
  const events = [ev(-60, 30), ev(30, 30)];
  const { current, next } = DVBIEpg.getNowNext(events);
  assert.equal(current, null);
  assert.equal(next.title, 'ev@30', 'must not return the stale past event as "next"');
});

test('getNowNext: all events in the past -> no current, no next', () => {
  const events = [ev(-120, 30), ev(-60, 30)];
  const { current, next } = DVBIEpg.getNowNext(events);
  assert.equal(current, null);
  assert.equal(next, null);
});

test('getNowNext: all events in the future -> no current, next is the earliest', () => {
  const events = [ev(60, 30), ev(120, 30)];
  const { current, next } = DVBIEpg.getNowNext(events);
  assert.equal(current, null);
  assert.equal(next.title, 'ev@60');
});

test('getGenres: dedupes and drops falsy genres', () => {
  const events = [{ genre: 'news' }, { genre: 'news' }, { genre: 'sport' }, { genre: null }, { genre: '' }];
  assert.deepEqual(DVBIEpg.getGenres(events), ['news', 'sport']);
});
