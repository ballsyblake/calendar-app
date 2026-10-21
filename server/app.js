import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, Store, HttpError, requireRole } from './db.js';
import { buildFeed } from './ical.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Server-sent events: every open calendar tab gets a "changed" ping after writes.
class Hub {
  constructor() {
    this.clients = new Map();
  }

  add(calendarId, res) {
    if (!this.clients.has(calendarId)) this.clients.set(calendarId, new Set());
    this.clients.get(calendarId).add(res);
  }

  remove(calendarId, res) {
    this.clients.get(calendarId)?.delete(res);
  }

  notify(calendarId, payload) {
    for (const res of this.clients.get(calendarId) ?? []) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

export function createApp({ dbFile = ':memory:' } = {}) {
  const store = new Store(openDb(dbFile));
  const hub = new Hub();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.static(publicDir));
  app.get('/c/:key', (req, res) => res.sendFile(path.join(publicDir, 'app.html')));

  app.post('/api/calendars', (req, res) => {
    const { adminKey } = store.createCalendar(req.body ?? {});
    res.status(201).json({ adminKey, url: `/c/${adminKey}` });
  });

  const api = express.Router({ mergeParams: true });
  api.use((req, res, next) => {
    const access = store.getAccess(req.params.key);
    if (!access) throw new HttpError(404, 'Calendar not found. Check the link.');
    req.access = access;
    next();
  });

  // Run a write, then tell other open tabs of the same calendar to refresh.
  const write = (fn) => (req, res) => {
    const result = fn(req, res);
    hub.notify(req.access.calendarId, { type: 'changed' });
    if (result === undefined) res.status(204).end();
    else res.status(req.method === 'POST' ? 201 : 200).json(result);
  };

  api.get('/', (req, res) => {
    const a = req.access;
    res.json({
      calendar: store.getCalendar(a.calendarId),
      me: { name: a.name, role: a.role, subcalendarIds: a.subcalendarIds },
      subcalendars: store.listSubcalendars(a),
    });
  });

  api.put('/', write((req) => {
    requireRole(req.access, 'admin');
    return store.updateCalendar(req.access, req.body ?? {});
  }));

  api.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const { calendarId } = req.access;
    hub.add(calendarId, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      hub.remove(calendarId, res);
    });
  });

  api.post('/subcalendars', write((req) => {
    requireRole(req.access, 'admin');
    return store.createSubcalendar(req.access, req.body ?? {});
  }));
  api.put('/subcalendars/:id', write((req) => {
    requireRole(req.access, 'admin');
    return store.updateSubcalendar(req.access, Number(req.params.id), req.body ?? {});
  }));
  api.delete('/subcalendars/:id', write((req) => {
    requireRole(req.access, 'admin');
    store.deleteSubcalendar(req.access, Number(req.params.id));
  }));

  api.get('/events', (req, res) => {
    const { from, to, q } = req.query;
    if (!from && !to && !q) throw new HttpError(400, 'Provide from/to or q');
    res.json(store.listEvents(req.access, { from, to, q: q?.trim() }));
  });
  api.get('/events/:id', (req, res) => res.json(store.getEvent(req.access, Number(req.params.id))));
  api.post('/events', write((req) => store.createEvent(req.access, req.body)));
  api.put('/events/:id', write((req) => store.updateEvent(req.access, Number(req.params.id), req.body ?? {})));
  api.delete('/events/:id', write((req) => {
    store.deleteEvent(req.access, Number(req.params.id), req.body ?? {});
  }));

  api.get('/events/:id/comments', (req, res) => res.json(store.listComments(req.access, Number(req.params.id))));
  api.post('/events/:id/comments', write((req) => store.addComment(req.access, Number(req.params.id), req.body)));
  api.delete('/events/:id/comments/:cid', write((req) => {
    store.deleteComment(req.access, Number(req.params.id), Number(req.params.cid));
  }));

  api.get('/links', (req, res) => {
    requireRole(req.access, 'admin');
    res.json(store.listKeys(req.access.calendarId));
  });
  api.post('/links', write((req) => {
    requireRole(req.access, 'admin');
    return store.createKey(req.access, req.body ?? {});
  }));
  api.put('/links/:target', write((req) => {
    requireRole(req.access, 'admin');
    return store.updateKey(req.access, req.params.target, req.body ?? {});
  }));
  api.delete('/links/:target', write((req) => {
    requireRole(req.access, 'admin');
    store.deleteKey(req.access, req.params.target);
  }));

  api.get('/activity', (req, res) => {
    requireRole(req.access, 'admin');
    res.json(store.listActivity(req.access.calendarId));
  });

  app.use('/api/c/:key', api);

  // Subscribable iCal feed: /feed/<key>.ics, optional ?subcalendars=1,2
  app.get('/feed/:file', (req, res) => {
    const match = /^(.+)\.ics$/.exec(req.params.file);
    const access = match && store.getAccess(match[1]);
    if (!access) throw new HttpError(404, 'Calendar not found');
    let subcalendars = store.listSubcalendars(access);
    let events = store.allEvents(access);
    if (req.query.subcalendars) {
      const wanted = new Set(String(req.query.subcalendars).split(',').map(Number));
      subcalendars = subcalendars.filter((s) => wanted.has(s.id));
      events = events.filter((e) => e.subcalendarIds.some((id) => wanted.has(id)));
    }
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="calendar.ics"');
    res.send(buildFeed({ calendar: store.getCalendar(access.calendarId), events, subcalendars, host: req.hostname || 'teamcal' }));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return { app, store, hub };
}
