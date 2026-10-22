// In-browser backend used when no TeamCal server is reachable (e.g. GitHub Pages).
// Runs the same Store as the server on SQLite compiled to WebAssembly (sql.js) and
// keeps the database in IndexedDB. Tabs stay in sync through a BroadcastChannel;
// writes take a Web Lock and reload the latest copy first, so tabs never overwrite
// each other's changes.
import { Store, initSchema, requireRole, HttpError } from './shared/store.js';
import { buildFeed } from './shared/ical.js';

// node:sqlite-style interface over a sql.js Database.
export function wrapSqlJs(raw) {
  const query = (sql, params, collect) => {
    const stmt = raw.prepare(sql);
    try {
      stmt.bind(params);
      return collect(stmt);
    } finally {
      stmt.free();
    }
  };
  return {
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      return {
        run(...params) {
          raw.run(sql, params);
          const changes = raw.getRowsModified();
          const lastInsertRowid = raw.exec('SELECT last_insert_rowid()')[0].values[0][0];
          return { changes, lastInsertRowid };
        },
        get: (...params) => query(sql, params, (s) => (s.step() ? s.getAsObject() : undefined)),
        all: (...params) => query(sql, params, (s) => {
          const rows = [];
          while (s.step()) rows.push(s.getAsObject());
          return rows;
        }),
      };
    },
  };
}

// ---- IndexedDB persistence: one record { bytes, version } ----

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('teamcal', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('db');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('db', mode);
      const req = fn(tx.objectStore('db'));
      tx.oncomplete = () => {
        open.result.close();
        resolve(req.result);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const loadRecord = () => idb('readonly', (s) => s.get('main'));
const saveRecord = (record) => idb('readwrite', (s) => s.put(record, 'main'));

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Could not load the database engine'));
    document.head.append(el);
  });
}

class LocalBackend {
  async init() {
    const vendor = new URL('vendor/', document.baseURI).href;
    if (!window.initSqlJs) await loadScript(`${vendor}sql-wasm.js`);
    this.SQL = await window.initSqlJs({ locateFile: (file) => vendor + file });
    this.listeners = new Set();
    await this.reload();
    this.channel = 'BroadcastChannel' in window ? new BroadcastChannel('teamcal') : null;
    if (this.channel) {
      this.channel.onmessage = async () => {
        await this.reload();
        for (const fn of this.listeners) fn();
      };
    }
    return this;
  }

  async reload() {
    const record = await loadRecord();
    this.raw?.close();
    this.raw = record ? new this.SQL.Database(record.bytes) : new this.SQL.Database();
    this.version = record?.version ?? 0;
    const db = wrapSqlJs(this.raw);
    initSchema(db);
    this.store = new Store(db);
  }

  read(fn) {
    return fn(this.store);
  }

  locked(fn) {
    return navigator.locks ? navigator.locks.request('teamcal-db', fn) : fn();
  }

  changed() {
    this.channel?.postMessage('changed');
    for (const listener of this.listeners) listener();
  }

  async write(fn) {
    const result = await this.locked(async () => {
      const record = await loadRecord();
      if ((record?.version ?? 0) !== this.version) await this.reload();
      const value = fn(this.store);
      this.version += 1;
      await saveRecord({ bytes: this.raw.export(), version: this.version });
      return value;
    });
    this.changed();
    return result;
  }

  exportBytes() {
    return this.raw.export();
  }

  async importBytes(bytes) {
    const test = new this.SQL.Database(bytes);
    try {
      test.exec('SELECT COUNT(*) FROM calendars');
    } catch {
      throw new Error('This file is not a TeamCal backup');
    } finally {
      test.close();
    }
    await this.locked(async () => {
      const record = await loadRecord();
      await saveRecord({ bytes, version: (record?.version ?? 0) + 1 });
      await this.reload();
    });
    this.changed();
  }
}

let backendPromise = null;
export function localBackend() {
  backendPromise ??= new LocalBackend().init();
  return backendPromise;
}

// Responses are cloned so callers can't mutate stored state, like a network round trip.
const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

function call(fn) {
  try {
    return clone(fn());
  } catch (err) {
    if (err instanceof HttpError) {
      const e = new Error(err.message);
      e.status = err.status;
      throw e;
    }
    throw err;
  }
}

export class LocalApi {
  constructor(backend, key) {
    this.backend = backend;
    this.key = key;
    this.isLocal = true;
  }

  static async createCalendar(data) {
    const backend = await localBackend();
    return backend.write((store) => store.createCalendar(data));
  }

  access(store) {
    const access = store.getAccess(this.key);
    if (!access) throw new HttpError(404, 'Calendar not found. Check the link.');
    return access;
  }

  get(fn) {
    return Promise.resolve().then(() => call(() => this.backend.read((s) => fn(s, this.access(s)))));
  }

  async set(fn) {
    let result;
    await this.backend.write((s) => {
      result = call(() => fn(s, this.access(s)));
    });
    return result;
  }

  admin(fn) {
    return (s, a) => {
      requireRole(a, 'admin');
      return fn(s, a);
    };
  }

  subscribe(onChange) {
    this.backend.listeners.add(onChange);
  }

  info() {
    return this.get((s, a) => ({
      calendar: s.getCalendar(a.calendarId),
      me: { name: a.name, role: a.role, subcalendarIds: a.subcalendarIds },
      subcalendars: s.listSubcalendars(a),
    }));
  }

  updateCalendar(data) { return this.set(this.admin((s, a) => s.updateCalendar(a, data))); }

  events(from, to) { return this.get((s, a) => s.listEvents(a, { from, to })); }
  search(q) { return this.get((s, a) => s.listEvents(a, { q })); }
  createEvent(data) { return this.set((s, a) => s.createEvent(a, data)); }
  updateEvent(id, body) { return this.set((s, a) => s.updateEvent(a, id, body)); }
  deleteEvent(id, body = {}) { return this.set((s, a) => s.deleteEvent(a, id, body)); }

  comments(id) { return this.get((s, a) => s.listComments(a, id)); }
  addComment(id, data) { return this.set((s, a) => s.addComment(a, id, data)); }
  deleteComment(id, cid) { return this.set((s, a) => s.deleteComment(a, id, cid)); }

  createSub(data) { return this.set(this.admin((s, a) => s.createSubcalendar(a, data))); }
  updateSub(id, data) { return this.set(this.admin((s, a) => s.updateSubcalendar(a, id, data))); }
  deleteSub(id) { return this.set(this.admin((s, a) => s.deleteSubcalendar(a, id))); }

  links() { return this.get(this.admin((s, a) => s.listKeys(a.calendarId))); }
  createLink(data) { return this.set(this.admin((s, a) => s.createKey(a, data))); }
  updateLink(key, data) { return this.set(this.admin((s, a) => s.updateKey(a, key, data))); }
  deleteLink(key) { return this.set(this.admin((s, a) => s.deleteKey(a, key))); }

  activity() { return this.get(this.admin((s, a) => s.listActivity(a.calendarId))); }

  // iCal export of everything this link can see, optionally limited to some sub-calendars.
  feed(subIds) {
    return this.get((s, a) => {
      let subcalendars = s.listSubcalendars(a);
      let events = s.allEvents(a);
      if (subIds) {
        subcalendars = subcalendars.filter((sub) => subIds.includes(sub.id));
        events = events.filter((e) => e.subcalendarIds.some((id) => subIds.includes(id)));
      }
      return buildFeed({ calendar: s.getCalendar(a.calendarId), events, subcalendars, host: location.hostname || 'teamcal' });
    });
  }

  exportBytes() { return this.backend.exportBytes(); }
  importBytes(bytes) { return this.backend.importBytes(bytes); }
}
