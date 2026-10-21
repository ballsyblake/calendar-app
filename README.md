# TeamCal

A shared team calendar modeled on [Teamup](https://www.teamup.com): one calendar, color-coded sub-calendars, and access through shareable links instead of user accounts.

## Features

- **Sub-calendars**: group events by team, project, room or person. Each has its own color and can be shown, hidden or soloed ("only") in the sidebar. An event can belong to several sub-calendars.
- **Six views**: day, week, month, year, list (next 30 days) and a timeline that shows sub-calendars as rows.
- **Access links, no accounts**: each link has a role (`admin`, `modify`, `add`, `read`) and can be limited to a subset of sub-calendars. Delete a link to revoke it.
- **Repeating events**: daily, weekly (chosen weekdays), monthly (by date, nth weekday or last weekday) and yearly rules, with an interval, an end date or an occurrence count. When editing, moving or deleting an occurrence you choose *only this*, *this and following*, or *all*.
- **Drag and drop**: drag across the time grid to create an event; drag events to move them; drag the bottom edge to resize. In month view, drag events between days.
- **Event details**: location, who, notes, comment threads, a duplicate button, and who created the event and when it last changed.
- **Live updates**: changes appear in every open tab immediately (server-sent events).
- **iCal feeds**: `/feed/<link>.ics`, optionally `?subcalendars=1,2`, for Google Calendar, Outlook or Apple Calendar.
- **Admin settings**: calendar name, time zone, week start, default view, sub-calendar management, sharing links, feeds and an activity log.
- **Search** across title, location, who and notes, plus keyboard shortcuts (`d w m y l t` switch views, `←/→` move through dates, `.` jumps to today, `n` creates an event, `/` searches).
- Responsive layout and dark mode.

## Running it

Requires Node.js 22.13 or newer. Storage uses the built-in `node:sqlite`, so there are no native dependencies.

```sh
npm install
npm start            # http://localhost:3000
npm test             # API and recurrence tests
```

Environment variables:

| Variable  | Default            | Purpose              |
|-----------|--------------------|----------------------|
| `PORT`    | `3000`             | HTTP port            |
| `DB_FILE` | `data/teamcal.db`  | SQLite database path |

Open the start page, create a calendar and **bookmark the admin link you're given**. It's the only key to the calendar.

## Architecture

```
server/
  index.js      entry point
  app.js        Express routes, permission checks, SSE hub, iCal endpoint
  db.js         SQLite schema, validation, data access (Store)
  ical.js       RFC 5545 feed generation
public/
  index.html    start page (create calendar, recently opened)
  app.html      calendar shell
  js/shared/    date, time-zone and recurrence logic used by the browser and the server
  js/views/     month, week/day time grid, list, timeline, year
  js/editor.js  event dialog, recurrence scope prompts, comments
  js/settings.js admin settings dialog
test/           node:test suites
```

- The frontend is plain ES modules with no build step.
- Repeating events are stored once, as a rule plus exception dates. The client expands occurrences for the visible range, and the iCal feed emits `RRULE`/`EXDATE`.
- Timed events are stored in UTC along with the time zone they were created in. A series keeps its wall-clock time in that zone, so a 09:00 meeting stays at 09:00 across DST changes. Each viewer sees times in their own local zone.
- Editing one occurrence detaches it as a separate event and records an exception date on the series. Editing "this and following" ends the original series the day before and starts a new one.

## API

All calendar endpoints are under `/api/c/:key`, where `:key` is an access link token.

| Method | Path | Minimum role |
|---|---|---|
| `POST` | `/api/calendars` (create, returns admin key) | none |
| `GET` | `/` (calendar, your access, sub-calendars) | read |
| `PUT` | `/` (calendar settings) | admin |
| `GET` | `/events?from=YYYY-MM-DD&to=YYYY-MM-DD` or `?q=text` | read |
| `POST` | `/events` | add |
| `PUT` | `/events/:id` (`{ scope, occurrenceDate, event, seriesRrule }`) | modify |
| `DELETE` | `/events/:id` (body `{ scope, occurrenceDate, seriesRrule }`) | modify |
| `GET/POST` | `/events/:id/comments` | read / add |
| `DELETE` | `/events/:id/comments/:cid` | modify |
| `POST/PUT/DELETE` | `/subcalendars[/:id]` | admin |
| `GET/POST/PUT/DELETE` | `/links[/:key]` | admin |
| `GET` | `/activity` | admin |
| `GET` | `/stream` (server-sent events) | read |
| `GET` | `/feed/:key.ics` | read |

## Known limitations

- **Links are bearer tokens.** Anyone holding a link has its access. Serve the app over HTTPS and treat admin links like passwords. Rate limiting and abuse protection are not included.
- **Live updates are single-process.** The SSE hub lives in memory, so running several server instances needs a shared pub/sub layer.
- Permissions apply per link, not per sub-calendar: one role, optionally limited to some sub-calendars. Teamup lets you set a different role for each sub-calendar on the same link.
- Not implemented: email reminders, custom event fields, file attachments, sign-up/RSVP forms, dragging events in the all-day row, and importing `.ics` files.
