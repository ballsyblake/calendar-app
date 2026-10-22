// The browser backend runs the same Store on sql.js; check the adapter end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { wrapSqlJs } from '../public/js/local.js';
import { Store, initSchema } from '../public/js/shared/store.js';

async function openStore(bytes) {
  const SQL = await initSqlJs();
  const raw = new SQL.Database(bytes);
  const db = wrapSqlJs(raw);
  initSchema(db);
  return { store: new Store(db), raw };
}

test('Store works on sql.js and survives export/import', async () => {
  const { store, raw } = await openStore();
  const { adminKey } = store.createCalendar({ name: 'Local', timezone: 'UTC' });
  const admin = store.getAccess(adminKey);
  const subs = store.listSubcalendars(admin);
  const ev = store.createEvent(admin, {
    title: 'Daily', start: '2026-03-02T09:00:00Z', end: '2026-03-02T09:30:00Z', tz: 'UTC',
    subcalendarIds: [subs[0].id], rrule: { freq: 'daily', count: 5 },
  });
  assert.equal(typeof ev.id, 'number');
  store.deleteEvent(admin, ev.id, { scope: 'one', occurrenceDate: '2026-03-03' });
  assert.deepEqual(store.getEvent(admin, ev.id).exdates, ['2026-03-03']);

  const reader = store.getAccess(store.createKey(admin, { name: 'Viewer', role: 'read' }).key);
  assert.throws(() => store.createEvent(reader, { ...ev, subcalendarIds: [subs[0].id] }), /does not allow/);

  // Foreign-key cascades are active: deleting the sub-calendar removes its only events.
  store.deleteSubcalendar(admin, subs[0].id);
  assert.throws(() => store.getEvent(admin, ev.id), /not found/);

  const copy = await openStore(raw.export());
  assert.equal(copy.store.getCalendar(admin.calendarId).name, 'Local');
  assert.equal(copy.store.listKeys(admin.calendarId).length, 2);
});
