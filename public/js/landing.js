import { h, storage, relativeTime } from './dom.js';
import { createCalendar, calendarUrl, backendMode } from './api.js';

const form = document.getElementById('create-form');
const error = document.getElementById('create-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const { adminKey } = await createCalendar({
      name: document.getElementById('cal-name-input').value,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    location.href = calendarUrl(adminKey);
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
    h('a', { href: calendarUrl(r.key) }, r.name),
    h('span', { class: 'muted' }, ` · ${roles[r.role] || r.role} · ${relativeTime(new Date(r.at).toISOString())}`))));
}

backendMode().then((mode) => {
  if (mode === 'local') document.getElementById('local-note').hidden = false;
});
