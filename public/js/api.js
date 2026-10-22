// Client for the TeamCal server. All URLs are relative so the app works under a sub-path.
export class Api {
  constructor(key) {
    this.key = key;
    this.base = `api/c/${encodeURIComponent(key)}`;
    this.isLocal = false;
  }

  static async createCalendar(data) {
    const res = await fetch('api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not create the calendar');
    return body;
  }

  // Live updates via server-sent events.
  subscribe(onChange) {
    if (!window.EventSource) return;
    new EventSource(`${this.base}/stream`).onmessage = onChange;
  }

  async request(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  info() { return this.request('GET', '/'); }
  updateCalendar(data) { return this.request('PUT', '/', data); }

  events(from, to) { return this.request('GET', `/events?from=${from}&to=${to}`); }
  search(q) { return this.request('GET', `/events?q=${encodeURIComponent(q)}`); }
  createEvent(data) { return this.request('POST', '/events', data); }
  updateEvent(id, body) { return this.request('PUT', `/events/${id}`, body); }
  deleteEvent(id, body = {}) { return this.request('DELETE', `/events/${id}`, body); }

  comments(id) { return this.request('GET', `/events/${id}/comments`); }
  addComment(id, data) { return this.request('POST', `/events/${id}/comments`, data); }
  deleteComment(id, cid) { return this.request('DELETE', `/events/${id}/comments/${cid}`); }

  createSub(data) { return this.request('POST', '/subcalendars', data); }
  updateSub(id, data) { return this.request('PUT', `/subcalendars/${id}`, data); }
  deleteSub(id) { return this.request('DELETE', `/subcalendars/${id}`); }

  links() { return this.request('GET', '/links'); }
  createLink(data) { return this.request('POST', '/links', data); }
  updateLink(key, data) { return this.request('PUT', `/links/${encodeURIComponent(key)}`, data); }
  deleteLink(key) { return this.request('DELETE', `/links/${encodeURIComponent(key)}`); }

  activity() { return this.request('GET', '/activity'); }
}

// Uses the server when one answers; otherwise (static hosting such as GitHub Pages)
// falls back to the in-browser backend.
let modePromise = null;
export function backendMode() {
  modePromise ??= fetch('api/health', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => (body?.ok ? 'server' : 'local'))
    .catch(() => 'local');
  return modePromise;
}

export async function connect(key) {
  if ((await backendMode()) === 'server') return new Api(key);
  const { LocalApi, localBackend } = await import('./local.js');
  return new LocalApi(await localBackend(), key);
}

export async function createCalendar(data) {
  if ((await backendMode()) === 'server') return Api.createCalendar(data);
  const { LocalApi } = await import('./local.js');
  return LocalApi.createCalendar(data);
}

export const calendarUrl = (key) => new URL(`app.html?c=${encodeURIComponent(key)}`, location.href).href;
