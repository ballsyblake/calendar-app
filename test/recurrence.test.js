import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandEvent, normalizeRule, countOccurrencesBefore, describeRule } from '../public/js/shared/recurrence.js';
import { zonedToUtc, zonedParts, addDaysToKey, isDateKey } from '../public/js/shared/time.js';

const range = (a, b) => [new Date(a), new Date(b)];
const dates = (occ) => occ.map((o) => o.occurrenceDate);

test('date keys', () => {
  assert.equal(addDaysToKey('2026-02-28', 1), '2026-03-01');
  assert.equal(addDaysToKey('2024-02-28', 1), '2024-02-29');
  assert.equal(isDateKey('2026-02-30'), false);
  assert.equal(isDateKey('2026-12-31'), true);
});

test('zonedToUtc keeps wall-clock time across DST', () => {
  assert.equal(zonedToUtc(2026, 1, 15, 9, 0, 'America/New_York').toISOString(), '2026-01-15T14:00:00.000Z');
  assert.equal(zonedToUtc(2026, 7, 15, 9, 0, 'America/New_York').toISOString(), '2026-07-15T13:00:00.000Z');
  assert.deepEqual(zonedParts(new Date('2026-07-15T13:00:00Z'), 'America/New_York').h, 9);
});

test('non-recurring events are returned only when overlapping', () => {
  const e = { id: 1, allDay: false, start: '2026-03-10T10:00:00.000Z', end: '2026-03-10T11:00:00.000Z', tz: 'UTC' };
  assert.equal(expandEvent(e, ...range('2026-03-10T00:00Z', '2026-03-11T00:00Z')).length, 1);
  assert.equal(expandEvent(e, ...range('2026-03-11T00:00Z', '2026-03-12T00:00Z')).length, 0);
});

test('weekly on multiple days with interval, count and exdates', () => {
  const e = {
    allDay: false, tz: 'UTC',
    start: '2026-03-02T09:00:00.000Z', end: '2026-03-02T10:00:00.000Z', // Monday
    rrule: normalizeRule({ freq: 'weekly', interval: 2, byday: [1, 3], count: 5 }),
    exdates: ['2026-03-04'],
  };
  const occ = expandEvent(e, ...range('2026-01-01T00:00Z', '2026-12-31T00:00Z'));
  // Mon 2, (Wed 4 excluded but counted), Mon 16, Wed 18, Mon 30
  assert.deepEqual(dates(occ), ['2026-03-02', '2026-03-16', '2026-03-18', '2026-03-30']);
  assert.equal(occ[1].start, '2026-03-16T09:00:00.000Z');
});

test('weekly series in a DST zone stays at 09:00 local', () => {
  const e = {
    allDay: false, tz: 'Europe/Berlin',
    start: '2026-03-23T08:00:00.000Z', end: '2026-03-23T09:00:00.000Z', // 09:00 CET
    rrule: normalizeRule({ freq: 'weekly' }),
  };
  const occ = expandEvent(e, ...range('2026-03-20T00:00Z', '2026-04-05T00:00Z'));
  assert.deepEqual(occ.map((o) => o.start), ['2026-03-23T08:00:00.000Z', '2026-03-30T07:00:00.000Z']);
});

test('monthly by date skips short months; by weekday handles "last"', () => {
  const byDate = { allDay: true, start: '2026-01-31', end: '2026-01-31', rrule: normalizeRule({ freq: 'monthly' }) };
  assert.deepEqual(dates(expandEvent(byDate, ...range('2026-01-01T00:00Z', '2026-06-01T00:00Z'))), ['2026-01-31', '2026-03-31', '2026-05-31']);

  const lastFri = { allDay: true, start: '2026-01-30', end: '2026-01-30', rrule: normalizeRule({ freq: 'monthly', monthlyBy: 'weekday', nth: -1 }) };
  assert.deepEqual(dates(expandEvent(lastFri, ...range('2026-01-01T00:00Z', '2026-04-01T00:00Z'))), ['2026-01-30', '2026-02-27', '2026-03-27']);

  const thirdTue = { allDay: true, start: '2026-01-20', end: '2026-01-20', rrule: normalizeRule({ freq: 'monthly', monthlyBy: 'weekday' }) };
  assert.deepEqual(dates(expandEvent(thirdTue, ...range('2026-01-01T00:00Z', '2026-04-01T00:00Z'))), ['2026-01-20', '2026-02-17', '2026-03-17']);
});

test('yearly on Feb 29 only in leap years; until is inclusive', () => {
  const e = { allDay: true, start: '2024-02-29', end: '2024-02-29', rrule: normalizeRule({ freq: 'yearly', until: '2032-02-29' }) };
  assert.deepEqual(dates(expandEvent(e, ...range('2024-01-01T00:00Z', '2040-01-01T00:00Z'))), ['2024-02-29', '2028-02-29', '2032-02-29']);
});

test('multi-day all-day occurrences keep their length', () => {
  const e = { allDay: true, start: '2026-05-01', end: '2026-05-03', rrule: normalizeRule({ freq: 'daily', interval: 7, count: 2 }) };
  const occ = expandEvent(e, ...range('2026-04-01T00:00Z', '2026-06-01T00:00Z'));
  assert.deepEqual(occ.map((o) => [o.start, o.end]), [['2026-05-01', '2026-05-03'], ['2026-05-08', '2026-05-10']]);
});

test('countOccurrencesBefore counts the part kept when splitting', () => {
  const e = { allDay: true, start: '2026-05-01', end: '2026-05-01', rrule: normalizeRule({ freq: 'daily', count: 10 }) };
  assert.equal(countOccurrencesBefore(e, '2026-05-04'), 3);
});

test('normalizeRule rejects bad input', () => {
  assert.throws(() => normalizeRule({ freq: 'hourly' }));
  assert.throws(() => normalizeRule({ freq: 'daily', interval: 0 }));
  assert.throws(() => normalizeRule({ freq: 'weekly', byday: [7] }));
  assert.equal(normalizeRule(null), null);
});

test('describeRule', () => {
  assert.equal(describeRule(normalizeRule({ freq: 'weekly', interval: 2, byday: [1, 3] }), '2026-03-02'), 'Every 2 weeks on Mon, Wed');
  assert.equal(describeRule(normalizeRule({ freq: 'monthly', monthlyBy: 'weekday' }), '2026-01-20'), 'Every month on the third Tuesday');
});
