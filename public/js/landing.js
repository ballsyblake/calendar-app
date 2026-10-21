import { h, storage, relativeTime } from './dom.js';

const form = document.getElementById('create-form');
const error = document.getElementById('create-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const res = await fetch('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('cal-name-input').value,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create the calendar');
    location.href = data.url;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    button.disabled = false;
  }
});

const recent = storage('teamcal.recent', []);
if (recent.length) {
  document.getElementById('recent').hidden = false;
  const roles = { admin: 'Administrator', modify: 'Can modify', add: 'Can add', read: 'Read only' };
  document.getElementById('recent-list').append(...recent.map((r) => h('li', {},
    h('a', { href: `/c/${encodeURIComponent(r.key)}` }, r.name),
    h('span', { class: 'muted' }, ` · ${roles[r.role] || r.role} · ${relativeTime(new Date(r.at).toISOString())}`))));
}
