import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRule } from '../public/js/shared/recurrence.js';
import { isDateKey, isValidTimeZone, addDaysToKey } from '../public/js/shared/time.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const ROLES = ['read', 'add', 'modify', 'admin'];
const RANK = { read: 0, add: 1, modify: 2, admin: 3 };
export const PALETTE = ['#2f6fde', '#d94a3d', '#2e9d5b', '#e08a1e', '#8a4fd1', '#1f9fa8', '#c2457f', '#6b7a1f', '#5a6b7d', '#b5651d'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calendars (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  week_start INTEGER NOT NULL DEFAULT 1,
  default_view TEXT NOT NULL DEFAULT 'month',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_keys (
  key TEXT PRIMARY KEY,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('read', 'add', 'modify', 'admin')),
  subcalendar_ids TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS access_keys_calendar ON access_keys(calendar_id);
CREATE TABLE IF NOT EXISTS subcalendars (
  id INTEGER PRIMARY KEY,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS subcalendars_calendar ON subcalendars(calendar_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  tz TEXT,
  location TEXT NOT NULL DEFAULT '',
  who TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  rrule TEXT,
  exdates TEXT NOT NULL DEFAULT '[]',
  series_id INTEGER,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_range ON events(calendar_id, start_at, end_at);
CREATE TABLE IF NOT EXISTS event_subcalendars (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subcalendar_id INTEGER NOT NULL REFERENCES subcalendars(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, subcalendar_id)
);
CREATE INDEX IF NOT EXISTS event_subcalendars_sub ON event_subcalendars(subcalendar_id);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_event ON comments(event_id);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_calendar ON activity(calendar_id, id);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function newKey() {
  return crypto.randomBytes(15).toString('base64url');
}

const now = () => new Date().toISOString();

// ---- input validation ----

function str(value, field, { max = 200, required = false } = {}) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  value = value.trim();
  if (required && !value) throw new HttpError(400, `${field} is required`);
  if (value.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return value;
}

function color(value) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new HttpError(400, 'color must be #rrggbb');
  return value.toLowerCase();
}

function idList(value, field) {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be a list`);
  const ids = [...new Set(value.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new HttpError(400, `${field} contains an invalid id`);
  return ids;
}

function role(value) {
  if (!ROLES.includes(value)) throw new HttpError(400, `role must be one of ${ROLES.join(', ')}`);
  return value;
}

// ---- access helpers ----

export function hasRole(access, minimum) {
  return RANK[access.role] >= RANK[minimum];
}

export function requireRole(access, minimum) {
  if (!hasRole(access, minimum)) throw new HttpError(403, 'This link does not allow that action');
}

export function canSeeEvent(access, subIds) {
  if (!access.subcalendarIds) return true;
  return subIds.some((id) => access.subcalendarIds.includes(id));
}

function canWriteSubs(access, subIds) {
  if (!access.subcalendarIds) return true;
  return subIds.every((id) => access.subcalendarIds.includes(id));
}

// ---- row mapping ----

function mapCalendar(row) {
  return {
    id: row.id, name: row.name, timezone: row.timezone, weekStart: row.week_start,
    defaultView: row.default_view, createdAt: row.created_at,
  };
}

function mapKey(row) {
  return {
    key: row.key, name: row.name, role: row.role,
    subcalendarIds: row.subcalendar_ids ? JSON.parse(row.subcalendar_ids) : null,
    createdAt: row.created_at,
  };
}

function mapSub(row) {
  return { id: row.id, name: row.name, color: row.color, sort: row.sort };
}

function mapEvent(row, subIds) {
  return {
    id: row.id,
    title: row.title,
    start: row.start_at,
    end: row.end_at,
    allDay: !!row.all_day,
    tz: row.tz,
    location: row.location,
    who: row.who,
    notes: row.notes,
    rrule: row.rrule ? JSON.parse(row.rrule) : null,
    exdates: JSON.parse(row.exdates),
    seriesId: row.series_id,
    subcalendarIds: subIds,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const VIEWS = ['month', 'week', 'day', 'list', 'timeline', 'year'];

export class Store {
  constructor(db) {
    this.db = db;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  log(calendarId, actor, action, summary) {
    this.db.prepare('INSERT INTO activity (calendar_id, actor, action, summary, at) VALUES (?, ?, ?, ?, ?)')
      .run(calendarId, actor, action, summary.slice(0, 300), now());
  }

  // ---- calendars & access ----

  createCalendar({ name, timezone }) {
    name = str(name, 'Calendar name', { required: true, max: 100 });
    const tz = isValidTimeZone(timezone) ? timezone : 'UTC';
    return this.tx(() => {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO calendars (name, timezone, created_at) VALUES (?, ?, ?)')
        .run(name, tz, now());
      const calendarId = Number(lastInsertRowid);
      const defaults = [['General', PALETTE[0]], ['Meetings', PALETTE[2]], ['Out of office', PALETTE[3]]];
      defaults.forEach(([subName, c], i) => {
        this.db.prepare('INSERT INTO subcalendars (calendar_id, name, color, sort) VALUES (?, ?, ?, ?)')
          .run(calendarId, subName, c, i);
      });
      const key = newKey();
      this.db.prepare('INSERT INTO access_keys (key, calendar_id, name, role, subcalendar_ids, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(key, calendarId, 'Administrator', 'admin', now());
      this.log(calendarId, 'Administrator', 'calendar.create', `Created calendar "${name}"`);
      return { calendarId, adminKey: key };
    });
  }

  getAccess(key) {
    if (typeof key !== 'string' || key.length > 64) return null;
    const row = this.db.prepare('SELECT * FROM access_keys WHERE key = ?').get(key);
    if (!row) return null;
    const k = mapKey(row);
    return { ...k, calendarId: row.calendar_id, subcalendarIds: k.role === 'admin' ? null : k.subcalendarIds };
  }

  getCalendar(id) {
    return mapCalendar(this.db.prepare('SELECT * FROM calendars WHERE id = ?').get(id));
  }

  updateCalendar(access, input) {
    const cal = this.getCalendar(access.calendarId);
    const name = input.name !== undefined ? str(input.name, 'Calendar name', { required: true, max: 100 }) : cal.name;
    let timezone = cal.timezone;
    if (input.timezone !== undefined) {
      if (!isValidTimeZone(input.timezone)) throw new HttpError(400, 'Unknown time zone');
      timezone = input.timezone;
    }
    let weekStart = cal.weekStart;
    if (input.weekStart !== undefined) {
      weekStart = Number(input.weekStart);
      if (![0, 1, 6].includes(weekStart)) throw new HttpError(400, 'weekStart must be 0, 1 or 6');
    }
    let defaultView = cal.defaultView;
    if (input.defaultView !== undefined) {
      if (!VIEWS.includes(input.defaultView)) throw new HttpError(400, 'Unknown view');
      defaultView = input.defaultView;
    }
    this.db.prepare('UPDATE calendars SET name = ?, timezone = ?, week_start = ?, default_view = ? WHERE id = ?')
      .run(name, timezone, weekStart, defaultView, access.calendarId);
    this.log(access.calendarId, access.name, 'calendar.update', 'Updated calendar settings');
    return this.getCalendar(access.calendarId);
  }

  listKeys(calendarId) {
    return this.db.prepare('SELECT * FROM access_keys WHERE calendar_id = ? ORDER BY created_at').all(calendarId).map(mapKey);
  }

  validateKeyInput(calendarId, input, existing) {
    const name = input.name !== undefined ? str(input.name, 'Link name', { required: true, max: 80 }) : existing.name;
    const r = input.role !== undefined ? role(input.role) : existing.role;
    let subs = existing ? existing.subcalendarIds : null;
    if (input.subcalendarIds !== undefined) {
      if (input.subcalendarIds === null) subs = null;
      else {
        subs = idList(input.subcalendarIds, 'subcalendarIds');
        if (!subs.length) throw new HttpError(400, 'Select at least one sub-calendar');
        this.assertSubsBelong(calendarId, subs);
      }
    }
    if (r === 'admin') subs = null;
    return { name, role: r, subs };
  }

  createKey(access, input) {
    const { name, role: r, subs } = this.validateKeyInput(
      access.calendarId,
      { name: input.name ?? '', role: input.role ?? 'read', subcalendarIds: input.subcalendarIds ?? null },
      { subcalendarIds: null },
    );
    const key = newKey();
    this.db.prepare('INSERT INTO access_keys (key, calendar_id, name, role, subcalendar_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, access.calendarId, name, r, subs ? JSON.stringify(subs) : null, now());
    this.log(access.calendarId, access.name, 'link.create', `Created ${r} link "${name}"`);
    return mapKey(this.db.prepare('SELECT * FROM access_keys WHERE key = ?').get(key));
  }

  updateKey(access, key, input) {
    const row = this.db.prepare('SELECT * FROM access_keys WHERE key = ? AND calendar_id = ?').get(key, access.calendarId);
    if (!row) throw new HttpError(404, 'Link not found');
    const existing = mapKey(row);
    const next = this.validateKeyInput(access.calendarId, input, existing);
    if (existing.role === 'admin' && next.role !== 'admin') this.assertOtherAdmin(access.calendarId, key);
    this.db.prepare('UPDATE access_keys SET name = ?, role = ?, subcalendar_ids = ? WHERE key = ?')
      .run(next.name, next.role, next.subs ? JSON.stringify(next.subs) : null, key);
    this.log(access.calendarId, access.name, 'link.update', `Updated link "${next.name}"`);
    return mapKey(this.db.prepare('SELECT * FROM access_keys WHERE key = ?').get(key));
  }

  deleteKey(access, key) {
    const row = this.db.prepare('SELECT * FROM access_keys WHERE key = ? AND calendar_id = ?').get(key, access.calendarId);
    if (!row) throw new HttpError(404, 'Link not found');
    if (row.role === 'admin') this.assertOtherAdmin(access.calendarId, key);
    this.db.prepare('DELETE FROM access_keys WHERE key = ?').run(key);
    this.log(access.calendarId, access.name, 'link.delete', `Deleted link "${row.name}"`);
  }

  assertOtherAdmin(calendarId, key) {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM access_keys WHERE calendar_id = ? AND role = 'admin' AND key != ?").get(calendarId, key);
    if (!n) throw new HttpError(400, 'A calendar needs at least one administrator link');
  }

  // ---- sub-calendars ----

  listSubcalendars(access) {
    const rows = this.db.prepare('SELECT * FROM subcalendars WHERE calendar_id = ? ORDER BY sort, id').all(access.calendarId).map(mapSub);
    return access.subcalendarIds ? rows.filter((s) => access.subcalendarIds.includes(s.id)) : rows;
  }

  assertSubsBelong(calendarId, ids) {
    const valid = new Set(this.db.prepare('SELECT id FROM subcalendars WHERE calendar_id = ?').all(calendarId).map((r) => r.id));
    if (ids.some((id) => !valid.has(id))) throw new HttpError(400, 'Unknown sub-calendar');
  }

  createSubcalendar(access, input) {
    const name = str(input.name, 'Sub-calendar name', { required: true, max: 80 });
    const c = input.color ? color(input.color) : PALETTE[this.listSubcalendars(access).length % PALETTE.length];
    const { m } = this.db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM subcalendars WHERE calendar_id = ?').get(access.calendarId);
    const { lastInsertRowid } = this.db.prepare('INSERT INTO subcalendars (calendar_id, name, color, sort) VALUES (?, ?, ?, ?)')
      .run(access.calendarId, name, c, m + 1);
    this.log(access.calendarId, access.name, 'subcalendar.create', `Created sub-calendar "${name}"`);
    return mapSub(this.db.prepare('SELECT * FROM subcalendars WHERE id = ?').get(lastInsertRowid));
  }

  updateSubcalendar(access, id, input) {
    const row = this.db.prepare('SELECT * FROM subcalendars WHERE id = ? AND calendar_id = ?').get(id, access.calendarId);
    if (!row) throw new HttpError(404, 'Sub-calendar not found');
    const name = input.name !== undefined ? str(input.name, 'Sub-calendar name', { required: true, max: 80 }) : row.name;
    const c = input.color !== undefined ? color(input.color) : row.color;
    let sort = row.sort;
    if (input.sort !== undefined) {
      sort = Number(input.sort);
      if (!Number.isInteger(sort)) throw new HttpError(400, 'sort must be an integer');
    }
    this.db.prepare('UPDATE subcalendars SET name = ?, color = ?, sort = ? WHERE id = ?').run(name, c, sort, id);
    this.log(access.calendarId, access.name, 'subcalendar.update', `Updated sub-calendar "${name}"`);
    return mapSub(this.db.prepare('SELECT * FROM subcalendars WHERE id = ?').get(id));
  }

  deleteSubcalendar(access, id) {
    const row = this.db.prepare('SELECT * FROM subcalendars WHERE id = ? AND calendar_id = ?').get(id, access.calendarId);
    if (!row) throw new HttpError(404, 'Sub-calendar not found');
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM subcalendars WHERE calendar_id = ?').get(access.calendarId);
    if (n <= 1) throw new HttpError(400, 'A calendar needs at least one sub-calendar');
    this.tx(() => {
      // Events that live only in this sub-calendar go with it.
      this.db.prepare(`
        DELETE FROM events WHERE id IN (
          SELECT es.event_id FROM event_subcalendars es
          GROUP BY es.event_id
          HAVING COUNT(*) = 1 AND MAX(es.subcalendar_id) = ?
        )`).run(id);
      this.db.prepare('DELETE FROM subcalendars WHERE id = ?').run(id);
      // Drop the id from restricted links; a link left with no sub-calendars is removed.
      for (const k of this.listKeys(access.calendarId)) {
        if (!k.subcalendarIds || !k.subcalendarIds.includes(id)) continue;
        const rest = k.subcalendarIds.filter((s) => s !== id);
        if (rest.length) this.db.prepare('UPDATE access_keys SET subcalendar_ids = ? WHERE key = ?').run(JSON.stringify(rest), k.key);
        else this.db.prepare('DELETE FROM access_keys WHERE key = ?').run(k.key);
      }
      this.log(access.calendarId, access.name, 'subcalendar.delete', `Deleted sub-calendar "${row.name}"`);
    });
  }

  // ---- events ----

  subIdsFor(eventIds) {
    const map = new Map(eventIds.map((id) => [id, []]));
    if (!eventIds.length) return map;
    const rows = this.db.prepare(
      `SELECT event_id, subcalendar_id FROM event_subcalendars WHERE event_id IN (${eventIds.map(() => '?').join(',')}) ORDER BY subcalendar_id`,
    ).all(...eventIds);
    for (const r of rows) map.get(r.event_id).push(r.subcalendar_id);
    return map;
  }

  rowsToEvents(access, rows) {
    const subs = this.subIdsFor(rows.map((r) => r.id));
    return rows.map((r) => mapEvent(r, subs.get(r.id))).filter((e) => canSeeEvent(access, e.subcalendarIds));
  }

  // Returns non-recurring events overlapping the range plus every series that may
  // produce occurrences in it; the client expands series. Without a range, `q` searches all.
  listEvents(access, { from, to, q } = {}) {
    const where = ['calendar_id = ?'];
    const params = [access.calendarId];
    if (from || to) {
      if (!isDateKey(from) || !isDateKey(to)) throw new HttpError(400, 'from and to must be YYYY-MM-DD');
      if (to < from) throw new HttpError(400, 'to must not be before from');
      // Timed events are stored in UTC; widen by a day so every zone is covered.
      const lo = addDaysToKey(from, -1);
      const hi = addDaysToKey(to, 2);
      where.push('((rrule IS NULL AND end_at >= ? AND start_at < ?) OR (rrule IS NOT NULL AND start_at < ?))');
      params.push(lo, hi, hi);
    }
    if (q) {
      const term = `%${String(q).slice(0, 100).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR who LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
      params.push(term, term, term, term);
    }
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY start_at LIMIT 5000`).all(...params);
    let events = this.rowsToEvents(access, rows);
    if (from) {
      const lo = addDaysToKey(from, -1);
      events = events.filter((e) => !e.rrule || !e.rrule.until || e.rrule.until >= lo);
    }
    return events;
  }

  allEvents(access) {
    return this.rowsToEvents(access, this.db.prepare('SELECT * FROM events WHERE calendar_id = ? ORDER BY start_at').all(access.calendarId));
  }

  getEvent(access, id) {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ? AND calendar_id = ?').get(id, access.calendarId);
    if (!row) throw new HttpError(404, 'Event not found');
    const [event] = this.rowsToEvents(access, [row]);
    if (!event) throw new HttpError(404, 'Event not found');
    return event;
  }

  validateEvent(access, input) {
    if (!input || typeof input !== 'object') throw new HttpError(400, 'Event data is required');
    const title = str(input.title, 'Title', { max: 200 }) || '(No title)';
    const allDay = !!input.allDay;
    let start;
    let end;
    let tz = null;
    if (allDay) {
      if (!isDateKey(input.start) || !isDateKey(input.end)) throw new HttpError(400, 'All-day events need start and end dates (YYYY-MM-DD)');
      start = input.start;
      end = input.end;
    } else {
      const s = new Date(input.start);
      const e = new Date(input.end);
      if (typeof input.start !== 'string' || typeof input.end !== 'string' || isNaN(s) || isNaN(e)) {
        throw new HttpError(400, 'Events need a valid start and end time');
      }
      start = s.toISOString();
      end = e.toISOString();
      tz = isValidTimeZone(input.tz) ? input.tz : this.getCalendar(access.calendarId).timezone;
    }
    if (end < start) throw new HttpError(400, 'End must not be before start');
    let rrule = null;
    try {
      rrule = normalizeRule(input.rrule);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (rrule?.until && rrule.until < start.slice(0, 10) && allDay) throw new HttpError(400, 'Repeat end date is before the start');
    const subcalendarIds = idList(input.subcalendarIds ?? [], 'subcalendarIds');
    if (!subcalendarIds.length) throw new HttpError(400, 'Choose at least one sub-calendar');
    this.assertSubsBelong(access.calendarId, subcalendarIds);
    if (!canWriteSubs(access, subcalendarIds)) throw new HttpError(403, 'This link cannot write to that sub-calendar');
    let exdates = [];
    if (input.exdates !== undefined) {
      if (!Array.isArray(input.exdates) || input.exdates.some((d) => !isDateKey(d))) throw new HttpError(400, 'Invalid exception dates');
      exdates = [...new Set(input.exdates)].sort();
    }
    return {
      title, start, end, allDay, tz, rrule, exdates, subcalendarIds,
      location: str(input.location, 'Location', { max: 300 }),
      who: str(input.who, 'Who', { max: 300 }),
      notes: str(input.notes, 'Notes', { max: 10000 }),
    };
  }

  insertEvent(access, data, seriesId = null) {
    const t = now();
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO events (calendar_id, title, start_at, end_at, all_day, tz, location, who, notes, rrule, exdates, series_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      access.calendarId, data.title, data.start, data.end, data.allDay ? 1 : 0, data.tz,
      data.location, data.who, data.notes, data.rrule ? JSON.stringify(data.rrule) : null,
      JSON.stringify(data.exdates), seriesId, access.name, t, t,
    );
    const id = Number(lastInsertRowid);
    this.setEventSubs(id, data.subcalendarIds);
    return id;
  }

  setEventSubs(id, subIds) {
    this.db.prepare('DELETE FROM event_subcalendars WHERE event_id = ?').run(id);
    const ins = this.db.prepare('INSERT INTO event_subcalendars (event_id, subcalendar_id) VALUES (?, ?)');
    for (const s of subIds) ins.run(id, s);
  }

  createEvent(access, input) {
    requireRole(access, 'add');
    const data = this.validateEvent(access, input);
    return this.tx(() => {
      const id = this.insertEvent(access, data);
      this.log(access.calendarId, access.name, 'event.create', `Created "${data.title}"`);
      return this.getEvent(access, id);
    });
  }

  // scope: 'all' updates the event (or whole series); 'one' detaches a single
  // occurrence; 'future' ends the series before the occurrence and starts a new one.
  updateEvent(access, id, { scope = 'all', occurrenceDate, event: input, seriesRrule } = {}) {
    requireRole(access, 'modify');
    const existing = this.getEvent(access, id);
    if (!canWriteSubs(access, existing.subcalendarIds)) throw new HttpError(403, 'This link cannot modify that event');
    if (input && input.exdates === undefined) input = { ...input, exdates: scope === 'all' ? existing.exdates : [] };
    const data = this.validateEvent(access, input);

    return this.tx(() => {
      if (scope === 'all' || !existing.rrule) {
        this.db.prepare(`
          UPDATE events SET title = ?, start_at = ?, end_at = ?, all_day = ?, tz = ?, location = ?, who = ?, notes = ?,
            rrule = ?, exdates = ?, updated_at = ? WHERE id = ?`).run(
          data.title, data.start, data.end, data.allDay ? 1 : 0, data.tz, data.location, data.who, data.notes,
          data.rrule ? JSON.stringify(data.rrule) : null, JSON.stringify(data.exdates), now(), id,
        );
        this.setEventSubs(id, data.subcalendarIds);
        this.log(access.calendarId, access.name, 'event.update', `Updated "${data.title}"`);
        return { event: this.getEvent(access, id) };
      }
      if (!isDateKey(occurrenceDate)) throw new HttpError(400, 'occurrenceDate is required');
      if (scope === 'one') {
        this.addExdate(existing, occurrenceDate);
        const newId = this.insertEvent(access, { ...data, rrule: null, exdates: [] }, id);
        this.log(access.calendarId, access.name, 'event.update', `Updated one occurrence of "${data.title}" (${occurrenceDate})`);
        return { event: this.getEvent(access, newId) };
      }
      if (scope === 'future') {
        this.truncateSeries(existing, seriesRrule);
        const newId = this.insertEvent(access, data, null);
        this.log(access.calendarId, access.name, 'event.update', `Updated "${data.title}" from ${occurrenceDate} on`);
        return { event: this.getEvent(access, newId) };
      }
      throw new HttpError(400, 'scope must be all, one or future');
    });
  }

  addExdate(event, dateKey) {
    const exdates = [...new Set([...event.exdates, dateKey])].sort();
    this.db.prepare('UPDATE events SET exdates = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(exdates), now(), event.id);
  }

  // The client computes the shortened rule (it knows the occurrence count); it
  // must still describe the same series, only ending earlier.
  truncateSeries(event, seriesRrule) {
    let rule;
    try {
      rule = normalizeRule(seriesRrule);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (!rule || rule.freq !== event.rrule.freq || (!rule.until && !rule.count)) {
      throw new HttpError(400, 'seriesRrule must end the existing series');
    }
    this.db.prepare('UPDATE events SET rrule = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(rule), now(), event.id);
  }

  deleteEvent(access, id, { scope = 'all', occurrenceDate, seriesRrule } = {}) {
    requireRole(access, 'modify');
    const existing = this.getEvent(access, id);
    if (!canWriteSubs(access, existing.subcalendarIds)) throw new HttpError(403, 'This link cannot delete that event');
    this.tx(() => {
      if (scope === 'all' || !existing.rrule) {
        this.db.prepare('DELETE FROM events WHERE id = ? OR (series_id = ? AND calendar_id = ?)').run(id, id, access.calendarId);
        this.log(access.calendarId, access.name, 'event.delete', `Deleted "${existing.title}"`);
      } else if (scope === 'one') {
        if (!isDateKey(occurrenceDate)) throw new HttpError(400, 'occurrenceDate is required');
        this.addExdate(existing, occurrenceDate);
        this.log(access.calendarId, access.name, 'event.delete', `Deleted one occurrence of "${existing.title}" (${occurrenceDate})`);
      } else if (scope === 'future') {
        this.truncateSeries(existing, seriesRrule);
        this.log(access.calendarId, access.name, 'event.delete', `Deleted "${existing.title}" from ${occurrenceDate || 'selected date'} on`);
      } else {
        throw new HttpError(400, 'scope must be all, one or future');
      }
    });
  }

  // ---- comments ----

  listComments(access, eventId) {
    this.getEvent(access, eventId);
    return this.db.prepare('SELECT * FROM comments WHERE event_id = ? ORDER BY id').all(eventId)
      .map((r) => ({ id: r.id, author: r.author, body: r.body, createdAt: r.created_at }));
  }

  addComment(access, eventId, input) {
    requireRole(access, 'add');
    const event = this.getEvent(access, eventId);
    const author = str(input?.author, 'Name', { max: 80 }) || access.name;
    const body = str(input?.body, 'Comment', { required: true, max: 2000 });
    const { lastInsertRowid } = this.db.prepare('INSERT INTO comments (event_id, author, body, created_at) VALUES (?, ?, ?, ?)')
      .run(eventId, author, body, now());
    this.log(access.calendarId, author, 'comment.create', `Commented on "${event.title}"`);
    const r = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(lastInsertRowid);
    return { id: r.id, author: r.author, body: r.body, createdAt: r.created_at };
  }

  deleteComment(access, eventId, commentId) {
    requireRole(access, 'modify');
    this.getEvent(access, eventId);
    const { changes } = this.db.prepare('DELETE FROM comments WHERE id = ? AND event_id = ?').run(commentId, eventId);
    if (!changes) throw new HttpError(404, 'Comment not found');
  }

  listActivity(calendarId, limit = 100) {
    return this.db.prepare('SELECT * FROM activity WHERE calendar_id = ? ORDER BY id DESC LIMIT ?').all(calendarId, limit)
      .map((r) => ({ id: r.id, actor: r.actor, action: r.action, summary: r.summary, at: r.at }));
  }
}

