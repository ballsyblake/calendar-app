// Turns server events into display items for a date range, and maps edits
// on a single occurrence back onto the stored event or series.
import { expandEvent, eventStartKey, countOccurrencesBefore } from './shared/recurrence.js';
import { addDaysToKey, localDateFromKey, localDateKey, diffDays } from './shared/time.js';
import { addDays, dayDiff } from './dom.js';

export function buildItems(events, rangeStart, rangeEnd, subMap, hidden) {
  const items = [];
  for (const ev of events) {
    const subs = ev.subcalendarIds.filter((id) => subMap.has(id) && !hidden.has(id));
    if (!subs.length) continue;
    for (const occ of expandEvent(ev, rangeStart, rangeEnd)) {
      const start = occ.allDay ? localDateFromKey(occ.start) : new Date(occ.start);
      const end = occ.allDay ? localDateFromKey(addDaysToKey(occ.end, 1)) : new Date(occ.end);
      const overlaps = end > rangeStart && start < rangeEnd;
      const instant = +start === +end && start >= rangeStart && start < rangeEnd;
      if (!overlaps && !instant) continue;
      items.push({
        id: `${ev.id}:${occ.occurrenceDate}`,
        event: ev,
        occurrenceDate: occ.occurrenceDate,
        start,
        end,
        allDay: occ.allDay,
        title: ev.title,
        subs,
        colors: subs.map((id) => subMap.get(id).color),
      });
      items[items.length - 1].isBar = isBar(items[items.length - 1]);
    }
  }
  return items.sort(compareItems);
}

export function compareItems(a, b) {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.title.localeCompare(b.title);
}

// Spans more than one calendar day (or is all-day) — drawn as a bar in month/all-day rows.
export function isBar(item) {
  if (item.allDay) return true;
  const lastMoment = new Date(item.end - 1);
  return dayDiff(item.start, lastMoment) > 0;
}

export const isRecurring = (item) => !!item.event.rrule;

// Converts edited occurrence times into a payload for the server.
// `fields` has the form values; `item` is the occurrence that was opened (or null).
export function buildSavePlan(item, fields, scope) {
  const ev = item?.event;
  if (!ev) return { kind: 'create', body: fields };
  if (!ev.rrule || scope === 'all') {
    let body = fields;
    if (ev.rrule) body = { ...fields, ...shiftSeries(item, fields), exdates: ev.exdates };
    return { kind: 'update', id: ev.id, body: { scope: 'all', event: body } };
  }
  if (scope === 'one') {
    return { kind: 'update', id: ev.id, body: { scope: 'one', occurrenceDate: item.occurrenceDate, event: { ...fields, rrule: null } } };
  }
  // 'future': end the original series the day before and start a new one.
  if (item.occurrenceDate === eventStartKey(ev)) return buildSavePlan(item, fields, 'all');
  const before = countOccurrencesBefore(ev, item.occurrenceDate);
  const seriesRrule = truncatedRule(ev, item.occurrenceDate, before);
  let rrule = fields.rrule;
  if (rrule && ev.rrule.count && rrule.count === ev.rrule.count) rrule = { ...rrule, count: Math.max(1, ev.rrule.count - before) };
  return {
    kind: 'update',
    id: ev.id,
    body: { scope: 'future', occurrenceDate: item.occurrenceDate, seriesRrule, event: { ...fields, rrule } },
  };
}

export function buildDeletePlan(item, scope) {
  const ev = item.event;
  if (!ev.rrule || scope === 'all' || (scope === 'future' && item.occurrenceDate === eventStartKey(ev))) {
    return { scope: 'all' };
  }
  if (scope === 'one') return { scope: 'one', occurrenceDate: item.occurrenceDate };
  const before = countOccurrencesBefore(ev, item.occurrenceDate);
  return { scope: 'future', occurrenceDate: item.occurrenceDate, seriesRrule: truncatedRule(ev, item.occurrenceDate, before) };
}

function truncatedRule(ev, occurrenceDate, before) {
  const rule = { ...ev.rrule };
  if (rule.count) rule.count = Math.max(1, before);
  else rule.until = addDaysToKey(occurrenceDate, -1);
  return rule;
}

// Applying an occurrence edit to the whole series: move the series start by the
// same offset the occurrence was moved by.
function shiftSeries(item, fields) {
  const ev = item.event;
  if (fields.allDay && ev.allDay) {
    const delta = diffDays(item.occurrenceDate, fields.start);
    return { start: addDaysToKey(ev.start, delta), end: addDaysToKey(ev.start, delta + diffDays(fields.start, fields.end)) };
  }
  if (!fields.allDay && !ev.allDay) {
    const delta = new Date(fields.start) - item.start;
    const start = new Date(new Date(ev.start).getTime() + delta);
    return { start: start.toISOString(), end: new Date(start.getTime() + (new Date(fields.end) - new Date(fields.start))).toISOString() };
  }
  // Switching between all-day and timed: anchor the series at its first date.
  const firstDay = localDateFromKey(eventStartKey(ev));
  const offset = dayDiff(item.start, firstDay);
  if (fields.allDay) {
    const start = addDaysToKey(fields.start, offset);
    return { start, end: addDaysToKey(start, diffDays(fields.start, fields.end)) };
  }
  const s = addDays(new Date(fields.start), offset);
  return { start: s.toISOString(), end: new Date(s.getTime() + (new Date(fields.end) - new Date(fields.start))).toISOString() };
}

// Field values for moving/resizing an item to new times via drag and drop.
export function movedFields(item, start, end) {
  const ev = item.event;
  const base = {
    title: ev.title, allDay: item.allDay, location: ev.location, who: ev.who, notes: ev.notes,
    subcalendarIds: ev.subcalendarIds, rrule: ev.rrule, tz: ev.tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  if (item.allDay) return { ...base, start: localDateKey(start), end: localDateKey(addDays(end, -1)) };
  return { ...base, start: start.toISOString(), end: end.toISOString() };
}
