// Recurrence rules and occurrence expansion, shared by the browser and the server.
//
// Rule shape:
//   { freq: 'daily'|'weekly'|'monthly'|'yearly',
//     interval: 1..,
//     byday: [0..6]            // weekly only, 0 = Sunday
//     monthlyBy: 'date'|'weekday', nth: 1..4 | -1   // monthly only
//     until: 'YYYY-MM-DD' | null, count: n | null }
//
// Timed events repeat at the same wall-clock time in the event's time zone, so a
// 09:00 meeting stays at 09:00 across DST changes. Exception dates ("exdates")
// are date keys in that same zone.

import {
  isDateKey, parseDateKey, makeDateKey, addDaysToKey, diffDays, weekdayOfKey,
  daysInMonth, zonedParts, zonedToUtc, zonedDateKey,
} from './time.js';

export const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
const MAX_ITERATIONS = 200000;

export function normalizeRule(rule) {
  if (rule == null) return null;
  if (typeof rule !== 'object') throw new Error('Invalid repeat rule');
  const freq = rule.freq;
  if (!FREQS.includes(freq)) throw new Error('Invalid repeat frequency');
  const interval = rule.interval == null ? 1 : Number(rule.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) throw new Error('Invalid repeat interval');
  const out = { freq, interval, until: null, count: null };
  if (freq === 'weekly') {
    const byday = Array.isArray(rule.byday) ? [...new Set(rule.byday.map(Number))] : [];
    if (byday.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Invalid repeat weekdays');
    out.byday = byday.sort((a, b) => a - b);
  }
  if (freq === 'monthly') {
    out.monthlyBy = rule.monthlyBy === 'weekday' ? 'weekday' : 'date';
    if (out.monthlyBy === 'weekday' && rule.nth != null) {
      const nth = Number(rule.nth);
      if (![1, 2, 3, 4, -1].includes(nth)) throw new Error('Invalid repeat week number');
      out.nth = nth;
    }
  }
  if (rule.until != null && rule.until !== '') {
    if (!isDateKey(rule.until)) throw new Error('Invalid repeat end date');
    out.until = rule.until;
  }
  if (rule.count != null && rule.count !== '') {
    const count = Number(rule.count);
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Invalid repeat count');
    out.count = count;
  }
  if (out.until && out.count) out.count = null;
  return out;
}

// nth weekday of the month for a date key: 1..4, or -1 when it is the last one (5th).
export function nthWeekdayOf(key) {
  const { d } = parseDateKey(key);
  const nth = Math.ceil(d / 7);
  return nth >= 5 ? -1 : nth;
}

export function isLastWeekdayOfMonth(key) {
  const { y, m, d } = parseDateKey(key);
  return d + 7 > daysInMonth(y, m);
}

function nthWeekdayInMonth(y, m, weekday, nth) {
  if (nth === -1) {
    const last = daysInMonth(y, m);
    const lastWd = weekdayOfKey(makeDateKey(y, m, last));
    return makeDateKey(y, m, last - ((lastWd - weekday + 7) % 7));
  }
  const firstWd = weekdayOfKey(makeDateKey(y, m, 1));
  const day = 1 + ((weekday - firstWd + 7) % 7) + (nth - 1) * 7;
  return day <= daysInMonth(y, m) ? makeDateKey(y, m, day) : null;
}

// Yields candidate date keys of the series in ascending order, starting at baseKey.
function* candidateDates(rule, baseKey) {
  const base = parseDateKey(baseKey);
  const { interval } = rule;
  if (rule.freq === 'daily') {
    for (let k = 0; ; k++) yield addDaysToKey(baseKey, k * interval);
  } else if (rule.freq === 'weekly') {
    const days = rule.byday && rule.byday.length ? rule.byday : [weekdayOfKey(baseKey)];
    // Weeks start on Monday (iCalendar default WKST=MO).
    const order = days.map((d) => (d + 6) % 7).sort((a, b) => a - b);
    const weekStart = addDaysToKey(baseKey, -((weekdayOfKey(baseKey) + 6) % 7));
    for (let w = 0; ; w++) {
      const start = addDaysToKey(weekStart, w * interval * 7);
      for (const offset of order) {
        const key = addDaysToKey(start, offset);
        if (key >= baseKey) yield key;
      }
    }
  } else if (rule.freq === 'monthly') {
    const byWeekday = rule.monthlyBy === 'weekday';
    const weekday = weekdayOfKey(baseKey);
    const nth = rule.nth ?? nthWeekdayOf(baseKey);
    for (let k = 0; ; k++) {
      const mi = base.m - 1 + k * interval;
      const y = base.y + Math.floor(mi / 12);
      const m = (mi % 12) + 1;
      let key;
      if (byWeekday) key = nthWeekdayInMonth(y, m, weekday, nth);
      else key = base.d <= daysInMonth(y, m) ? makeDateKey(y, m, base.d) : null;
      if (key && key >= baseKey) yield key;
    }
  } else {
    for (let k = 0; ; k++) {
      const y = base.y + k * interval;
      if (base.d <= daysInMonth(y, base.m)) yield makeDateKey(y, base.m, base.d);
    }
  }
}

// The date key an event starts on, in its own zone (all-day events have no zone).
export function eventStartKey(event) {
  return event.allDay ? event.start : zonedDateKey(new Date(event.start), event.tz);
}

/**
 * Expand an event into the occurrences that overlap [from, to).
 * `from` / `to` are Date instants. Non-recurring events are returned as-is when
 * they overlap. Each occurrence carries `occurrenceDate` (date key in the event zone).
 * All-day occurrences are matched loosely (±1 day) — callers filter precisely.
 */
export function expandEvent(event, from, to) {
  const fromKey = makeDateKey(from.getUTCFullYear(), from.getUTCMonth() + 1, from.getUTCDate() - 1);
  const toKey = makeDateKey(to.getUTCFullYear(), to.getUTCMonth() + 1, to.getUTCDate() + 1);

  if (!event.rrule) {
    const hit = event.allDay
      ? event.end >= fromKey && event.start <= toKey
      : new Date(event.end) > from && new Date(event.start) < to;
    return hit ? [{ ...event, occurrenceDate: eventStartKey(event) }] : [];
  }

  const rule = event.rrule;
  const exdates = new Set(event.exdates || []);
  const baseKey = eventStartKey(event);
  const out = [];

  let durationDays = 0;
  let durationMs = 0;
  let wall = null;
  if (event.allDay) {
    durationDays = diffDays(event.start, event.end);
  } else {
    durationMs = new Date(event.end) - new Date(event.start);
    wall = zonedParts(new Date(event.start), event.tz);
  }

  let n = 0;
  let iterations = 0;
  for (const key of candidateDates(rule, baseKey)) {
    if (++iterations > MAX_ITERATIONS) break;
    if (rule.until && key > rule.until) break;
    if (rule.count && n >= rule.count) break;
    n++;
    if (key > toKey) break;
    if (exdates.has(key)) continue;

    if (event.allDay) {
      const endKey = addDaysToKey(key, durationDays);
      if (endKey >= fromKey) out.push({ ...event, start: key, end: endKey, occurrenceDate: key });
    } else {
      const { y, m, d } = parseDateKey(key);
      const start = zonedToUtc(y, m, d, wall.h, wall.mi, event.tz);
      const end = new Date(start.getTime() + durationMs);
      if (end > from && start < to) {
        out.push({ ...event, start: start.toISOString(), end: end.toISOString(), occurrenceDate: key });
      }
    }
  }
  return out;
}

// All occurrence date keys of a series before `beforeKey` (used to split a series).
export function countOccurrencesBefore(event, beforeKey) {
  if (!event.rrule) return 0;
  let n = 0;
  let iterations = 0;
  for (const key of candidateDates(event.rrule, eventStartKey(event))) {
    if (++iterations > MAX_ITERATIONS) break;
    if (key >= beforeKey) break;
    if (event.rrule.until && key > event.rrule.until) break;
    if (event.rrule.count && n >= event.rrule.count) break;
    n++;
  }
  return n;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDINALS = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };

export function describeRule(rule, startKey) {
  if (!rule) return 'Does not repeat';
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[rule.freq];
  let text = rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`;
  if (rule.freq === 'weekly') {
    const days = rule.byday && rule.byday.length ? rule.byday : [weekdayOfKey(startKey)];
    text += ' on ' + days.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(', ');
  } else if (rule.freq === 'monthly') {
    if (rule.monthlyBy === 'weekday') {
      const nth = rule.nth ?? nthWeekdayOf(startKey);
      text += ` on the ${ORDINALS[nth]} ${WEEKDAY_NAMES[weekdayOfKey(startKey)]}`;
    } else {
      text += ` on day ${parseDateKey(startKey).d}`;
    }
  }
  if (rule.until) text += `, until ${rule.until}`;
  if (rule.count) text += `, ${rule.count} times`;
  return text;
}
