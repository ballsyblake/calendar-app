// Date helpers shared by the browser and the server.
// "Date keys" are plain calendar dates ("YYYY-MM-DD") with no time zone attached;
// arithmetic on them is done in UTC so it never shifts across DST boundaries.

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(value) {
  if (typeof value !== 'string' || !DATE_KEY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

export function makeDateKey(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.toISOString().slice(0, 10);
}

export function addDaysToKey(key, days) {
  const { y, m, d } = parseDateKey(key);
  return makeDateKey(y, m, d + days);
}

export function diffDays(a, b) {
  const pa = parseDateKey(a);
  const pb = parseDateKey(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

// 0 = Sunday … 6 = Saturday
export function weekdayOfKey(key) {
  const { y, m, d } = parseDateKey(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Local (browser/server process) date key for a Date.
export function localDateKey(date) {
  return makeDateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function localDateFromKey(key) {
  const { y, m, d } = parseDateKey(key);
  return new Date(y, m - 1, d);
}

// ---- Time zone support (IANA names via Intl, no external data) ----

const formatterCache = new Map();

function formatterFor(tz) {
  if (formatterCache.has(tz)) return formatterCache.get(tz);
  let fmt = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    fmt = null;
  }
  formatterCache.set(tz, fmt);
  return fmt;
}

export function isValidTimeZone(tz) {
  return typeof tz === 'string' && tz.length > 0 && tz.length < 64 && formatterFor(tz) !== null;
}

// Wall-clock components of `date` in `tz` (falls back to the process local zone).
export function zonedParts(date, tz) {
  const fmt = tz ? formatterFor(tz) : null;
  if (!fmt) {
    return {
      y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate(),
      h: date.getHours(), mi: date.getMinutes(), s: date.getSeconds(),
    };
  }
  const out = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

// The instant at which the wall clock in `tz` reads y-m-d h:mi.
// Nonexistent local times (spring-forward gap) resolve to the later offset.
export function zonedToUtc(y, m, d, h, mi, tz) {
  const fmt = tz ? formatterFor(tz) : null;
  if (!fmt) return new Date(y, m - 1, d, h, mi);
  const target = Date.UTC(y, m - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    const delta = target - shown;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

export function zonedDateKey(date, tz) {
  const p = zonedParts(date, tz);
  return makeDateKey(p.y, p.m, p.d);
}
