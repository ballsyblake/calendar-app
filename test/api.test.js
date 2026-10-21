import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

let server;
let base;

before(async () => {
  const { app } = createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: res.status, data };
}

async function newCalendar() {
  const { data } = await call('POST', '/api/calendars', { name: 'Team', timezone: 'Europe/London' });
  const key = data.adminKey;
  const info = (await call('GET', `/api/c/${key}`)).data;
  return { key, info, subs: info.subcalendars };
}

const timed = (subId, extra = {}) => ({
  title: 'Standup', start: '2026-03-02T09:00:00.000Z', end: '2026-03-02T09:15:00.000Z',
  tz: 'UTC', subcalendarIds: [subId], ...extra,
});

test('creating a calendar returns an admin link with default sub-calendars', async () => {
  const { key, info } = await newCalendar();
  assert.ok(key.length >= 20);
  assert.equal(info.me.role, 'admin');
  assert.equal(info.calendar.timezone, 'Europe/London');
  assert.equal(info.subcalendars.length, 3);
  assert.equal((await call('GET', '/api/c/nope')).status, 404);
});

test('event CRUD and range queries', async () => {
  const { key, subs } = await newCalendar();
  const created = await call('POST', `/api/c/${key}/events`, timed(subs[0].id, { location: 'Room 1' }));
  assert.equal(created.status, 201);
  const id = created.data.id;

  let list = await call('GET', `/api/c/${key}/events?from=2026-03-01&to=2026-03-07`);
  assert.equal(list.data.length, 1);
  list = await call('GET', `/api/c/${key}/events?from=2026-04-01&to=2026-04-07`);
  assert.equal(list.data.length, 0);

  const updated = await call('PUT', `/api/c/${key}/events/${id}`, { event: { ...timed(subs[1].id), title: 'Daily sync' } });
  assert.equal(updated.data.event.title, 'Daily sync');
  assert.deepEqual(updated.data.event.subcalendarIds, [subs[1].id]);

  const search = await call('GET', `/api/c/${key}/events?q=sync`);
  assert.equal(search.data.length, 1);

  assert.equal((await call('DELETE', `/api/c/${key}/events/${id}`)).status, 204);
  assert.equal((await call('GET', `/api/c/${key}/events/${id}`)).status, 404);
});

test('validation errors', async () => {
  const { key, subs } = await newCalendar();
  const bad = [
    timed(subs[0].id, { end: '2026-03-01T00:00:00Z' }),
    timed(subs[0].id, { subcalendarIds: [] }),
    timed(subs[0].id, { subcalendarIds: [999999] }),
    timed(subs[0].id, { rrule: { freq: 'secondly' } }),
    { ...timed(subs[0].id), allDay: true },
  ];
  for (const body of bad) assert.equal((await call('POST', `/api/c/${key}/events`, body)).status, 400, JSON.stringify(body));
});

test('recurring series: edit one, edit future, delete one', async () => {
  const { key, subs } = await newCalendar();
  const series = (await call('POST', `/api/c/${key}/events`, timed(subs[0].id, { rrule: { freq: 'daily', count: 10 } }))).data;

  const one = await call('PUT', `/api/c/${key}/events/${series.id}`, {
    scope: 'one', occurrenceDate: '2026-03-03',
    event: timed(subs[0].id, { title: 'Moved', start: '2026-03-03T11:00:00Z', end: '2026-03-03T11:15:00Z', rrule: { freq: 'daily' } }),
  });
  assert.equal(one.data.event.rrule, null);
  assert.equal(one.data.event.seriesId, series.id);
  let master = (await call('GET', `/api/c/${key}/events/${series.id}`)).data;
  assert.deepEqual(master.exdates, ['2026-03-03']);

  await call('DELETE', `/api/c/${key}/events/${series.id}`, { scope: 'one', occurrenceDate: '2026-03-04' });
  master = (await call('GET', `/api/c/${key}/events/${series.id}`)).data;
  assert.deepEqual(master.exdates, ['2026-03-03', '2026-03-04']);

  const future = await call('PUT', `/api/c/${key}/events/${series.id}`, {
    scope: 'future', occurrenceDate: '2026-03-06', seriesRrule: { freq: 'daily', count: 4 },
    event: timed(subs[0].id, { title: 'Later', start: '2026-03-06T10:00:00Z', end: '2026-03-06T10:15:00Z', rrule: { freq: 'daily', count: 6 } }),
  });
  assert.equal(future.status, 200);
  master = (await call('GET', `/api/c/${key}/events/${series.id}`)).data;
  assert.equal(master.rrule.count, 4);
  assert.equal(future.data.event.rrule.count, 6);

  // Deleting the whole series removes detached occurrences too.
  await call('DELETE', `/api/c/${key}/events/${series.id}`, { scope: 'all' });
  assert.equal((await call('GET', `/api/c/${key}/events/${one.data.event.id}`)).status, 404);
});

test('access links enforce roles and sub-calendar scope', async () => {
  const { key, subs } = await newCalendar();
  const mk = async (body) => (await call('POST', `/api/c/${key}/links`, body)).data.key;
  const readKey = await mk({ name: 'Viewers', role: 'read' });
  const addKey = await mk({ name: 'Contributors', role: 'add' });
  const scopedKey = await mk({ name: 'Meetings team', role: 'modify', subcalendarIds: [subs[1].id] });

  const ev = (await call('POST', `/api/c/${key}/events`, timed(subs[0].id))).data;

  assert.equal((await call('POST', `/api/c/${readKey}/events`, timed(subs[0].id))).status, 403);
  assert.equal((await call('POST', `/api/c/${addKey}/events`, timed(subs[0].id))).status, 201);
  assert.equal((await call('PUT', `/api/c/${addKey}/events/${ev.id}`, { event: timed(subs[0].id) })).status, 403);
  assert.equal((await call('POST', `/api/c/${addKey}/events/${ev.id}/comments`, { body: 'Can I join?' })).status, 201);
  assert.equal((await call('GET', `/api/c/${readKey}/links`)).status, 403);
  assert.equal((await call('POST', `/api/c/${readKey}/subcalendars`, { name: 'x' })).status, 403);

  // Scoped link: sees only its sub-calendar, cannot touch others.
  const scoped = (await call('GET', `/api/c/${scopedKey}`)).data;
  assert.deepEqual(scoped.subcalendars.map((s) => s.id), [subs[1].id]);
  assert.equal((await call('GET', `/api/c/${scopedKey}/events/${ev.id}`)).status, 404);
  assert.equal((await call('POST', `/api/c/${scopedKey}/events`, timed(subs[0].id))).status, 403);
  assert.equal((await call('POST', `/api/c/${scopedKey}/events`, timed(subs[1].id))).status, 201);
  const visible = (await call('GET', `/api/c/${scopedKey}/events?from=2026-03-01&to=2026-03-07`)).data;
  assert.ok(visible.every((e) => e.subcalendarIds.includes(subs[1].id)));

  // Last admin link cannot be removed or demoted.
  assert.equal((await call('DELETE', `/api/c/${key}/links/${key}`)).status, 400);
  assert.equal((await call('PUT', `/api/c/${key}/links/${key}`, { role: 'read' })).status, 400);
});

test('deleting a sub-calendar removes events that only lived there', async () => {
  const { key, subs } = await newCalendar();
  const only = (await call('POST', `/api/c/${key}/events`, timed(subs[2].id))).data;
  const shared = (await call('POST', `/api/c/${key}/events`, timed(subs[2].id, { subcalendarIds: [subs[1].id, subs[2].id] }))).data;
  assert.equal((await call('DELETE', `/api/c/${key}/subcalendars/${subs[2].id}`)).status, 204);
  assert.equal((await call('GET', `/api/c/${key}/events/${only.id}`)).status, 404);
  assert.deepEqual((await call('GET', `/api/c/${key}/events/${shared.id}`)).data.subcalendarIds, [subs[1].id]);
});

test('iCal feed', async () => {
  const { key, subs } = await newCalendar();
  await call('POST', `/api/c/${key}/events`, timed(subs[0].id, { title: 'Weekly; sync, team', tz: 'Europe/Berlin', rrule: { freq: 'weekly', byday: [1], until: '2026-06-01' } }));
  await call('POST', `/api/c/${key}/events`, { title: 'Holiday', allDay: true, start: '2026-04-03', end: '2026-04-06', subcalendarIds: [subs[2].id] });
  const res = await fetch(`${base}/feed/${key}.ics`);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  const body = await res.text();
  assert.match(body, /SUMMARY:Weekly\\; sync\\, team/);
  assert.match(body, /DTSTART;TZID=Europe\/Berlin:20260302T100000/);
  assert.match(body, /RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T215959Z/);
  assert.match(body, /DTSTART;VALUE=DATE:20260403\r\nDTEND;VALUE=DATE:20260407/);
  const filtered = await (await fetch(`${base}/feed/${key}.ics?subcalendars=${subs[2].id}`)).text();
  assert.doesNotMatch(filtered, /Weekly/);
});

test('activity log records changes', async () => {
  const { key, subs } = await newCalendar();
  await call('POST', `/api/c/${key}/events`, timed(subs[0].id, { title: 'Logged' }));
  const log = (await call('GET', `/api/c/${key}/activity`)).data;
  assert.equal(log[0].summary, 'Created "Logged"');
});
