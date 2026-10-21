// iCalendar (RFC 5545) feed generation.
import { addDaysToKey, parseDateKey, weekdayOfKey, zonedParts, zonedToUtc } from '../public/js/shared/time.js';
import { nthWeekdayOf, eventStartKey } from '../public/js/shared/recurrence.js';

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const pad = (n, w = 2) => String(n).padStart(w, '0');

export function escapeText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Fold lines longer than 75 octets without splitting multi-byte characters.
export function foldLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = out.length ? 74 : 75;
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

const dateValue = (key) => key.replace(/-/g, '');

function utcStamp(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function localStamp(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.y}${pad(p.m)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}`;
}

function rruleValue(event) {
  const r = event.rrule;
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  const startKey = eventStartKey(event);
  if (r.freq === 'weekly' && r.byday?.length) parts.push(`BYDAY=${r.byday.map((d) => DAY_CODES[d]).join(',')}`);
  if (r.freq === 'monthly' && r.monthlyBy === 'weekday') {
    parts.push(`BYDAY=${r.nth ?? nthWeekdayOf(startKey)}${DAY_CODES[weekdayOfKey(startKey)]}`);
  }
  if (r.until) {
    if (event.allDay) parts.push(`UNTIL=${dateValue(r.until)}`);
    else {
      const { y, m, d } = parseDateKey(r.until);
      parts.push(`UNTIL=${utcStamp(new Date(zonedToUtc(y, m, d, 23, 59, event.tz).getTime() + 59000))}`);
    }
  }
  if (r.count) parts.push(`COUNT=${r.count}`);
  return parts.join(';');
}

export function buildFeed({ calendar, events, subcalendars, host }) {
  const subNames = new Map(subcalendars.map((s) => [s.id, s.name]));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TeamCal//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `X-WR-TIMEZONE:${calendar.timezone}`,
  ];
  const stamp = utcStamp(new Date());
  for (const e of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:event-${e.id}@${host}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`LAST-MODIFIED:${utcStamp(new Date(e.updatedAt))}`);
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateValue(e.start)}`);
      lines.push(`DTEND;VALUE=DATE:${dateValue(addDaysToKey(e.end, 1))}`);
    } else if (e.rrule && e.tz) {
      // Recurring events keep their wall-clock time in the event's zone.
      lines.push(`DTSTART;TZID=${e.tz}:${localStamp(new Date(e.start), e.tz)}`);
      lines.push(`DTEND;TZID=${e.tz}:${localStamp(new Date(e.end), e.tz)}`);
    } else {
      lines.push(`DTSTART:${utcStamp(new Date(e.start))}`);
      lines.push(`DTEND:${utcStamp(new Date(e.end))}`);
    }
    if (e.rrule) {
      lines.push(`RRULE:${rruleValue(e)}`);
      if (e.exdates.length) {
        if (e.allDay) lines.push(`EXDATE;VALUE=DATE:${e.exdates.map(dateValue).join(',')}`);
        else {
          const wall = localStamp(new Date(e.start), e.tz).slice(8);
          lines.push(`EXDATE;TZID=${e.tz}:${e.exdates.map((k) => dateValue(k) + wall).join(',')}`);
        }
      }
    }
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    const description = [e.who && `Who: ${e.who}`, e.notes].filter(Boolean).join('\n\n');
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    const cats = e.subcalendarIds.map((id) => subNames.get(id)).filter(Boolean);
    if (cats.length) lines.push(`CATEGORIES:${cats.map(escapeText).join(',')}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
