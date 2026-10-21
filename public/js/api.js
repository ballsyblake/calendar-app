export class Api {
  constructor(key) {
    this.base = `/api/c/${encodeURIComponent(key)}`;
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
