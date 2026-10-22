import { h, clear, relativeTime, toast } from './dom.js';
import { dialog, confirmDialog } from './editor.js';
import { calendarUrl } from './api.js';

const ROLE_LABELS = {
  admin: 'Administrator — full control',
  modify: 'Modify — add, edit and delete events',
  add: 'Add only — add events, cannot edit',
  read: 'Read only',
};
const VIEW_LABELS = { month: 'Month', week: 'Week', day: 'Day', list: 'List', timeline: 'Timeline', year: 'Year' };

const linkUrl = calendarUrl;
const feedUrl = (key, subIds) => new URL(`feed/${encodeURIComponent(key)}.ics${subIds ? `?subcalendars=${subIds.join(',')}` : ''}`, location.href).href;
const LOCAL_NOTE = 'This copy runs without a server: data lives in this browser only, so links open the calendar only on this device and browser.';

function download(filename, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Subscription URL with the server; a one-off .ics download without one.
function feedControl(app, subIds) {
  if (!app.api.isLocal) return copyRow(feedUrl(app.key, subIds));
  return h('div', {}, h('button', {
    type: 'button',
    class: 'btn',
    onclick: async () => download(`${app.calendar.name}.ics`, await app.api.feed(subIds), 'text/calendar'),
  }, 'Download .ics'));
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    window.prompt('Copy this link:', text);
  }
}

function copyRow(text) {
  return h('div', { class: 'copy-row' },
    h('input', { class: 'input', readonly: true, value: text, onfocus: (e) => e.target.select() }),
    h('button', { type: 'button', class: 'btn', onclick: () => copy(text) }, 'Copy'));
}

// Read-only "share & subscribe" panel for non-admin links.
export function openShare(app) {
  const body = h('div', { class: 'dialog-body' },
    h('p', {}, `You are using the link "${app.me.name}" (${ROLE_LABELS[app.me.role]}).`),
    h('h3', {}, 'This link'), copyRow(linkUrl(app.key)),
    app.api.isLocal ? h('p', { class: 'muted' }, LOCAL_NOTE) : null,
    h('h3', {}, app.api.isLocal ? 'Export to Google Calendar, Outlook or Apple Calendar' : 'Subscribe in Google Calendar, Outlook or Apple Calendar'),
    h('p', { class: 'muted' }, app.api.isLocal
      ? 'Download an iCal file and import it. It is a snapshot and does not update.'
      : 'Add this iCal feed URL as a subscription. It updates automatically.'),
    feedControl(app));
  const dlg = dialog('settings-dialog', [
    h('div', { class: 'dialog-header' }, h('h2', {}, 'Share & subscribe'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')),
    body]);
}

export function openSettings(app, initialTab = 'general') {
  const tabs = {
    general: ['General', generalTab],
    subcalendars: ['Sub-calendars', subcalendarsTab],
    links: ['Sharing links', linksTab],
    feeds: ['iCal feeds', feedsTab],
    activity: ['Activity', activityTab],
  };
  const panel = h('div', { class: 'settings-panel' });
  const nav = h('nav', { class: 'settings-nav', role: 'tablist' });
  const show = (name) => {
    for (const b of nav.children) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    clear(panel);
    tabs[name][1](app, panel, () => show(name));
  };
  for (const [name, [label]] of Object.entries(tabs)) {
    nav.append(h('button', { type: 'button', role: 'tab', class: 'settings-tab', dataset: { tab: name }, onclick: () => show(name) }, label));
  }
  const dlg = dialog('settings-dialog wide', [
    h('div', { class: 'dialog-header' }, h('h2', {}, 'Calendar settings'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')),
    h('div', { class: 'settings' }, nav, panel)], { onClose: () => app.reload() });
  show(initialTab);
}

function generalTab(app, panel) {
  const cal = app.calendar;
  const name = h('input', { class: 'input', value: cal.name, maxlength: 100 });
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch { /* older browsers */ }
  if (!zones.includes(cal.timezone)) zones.unshift(cal.timezone);
  const tz = h('select', { class: 'input' }, zones.map((z) => h('option', { value: z, selected: z === cal.timezone }, z)));
  const weekStart = h('select', { class: 'input' },
    [[1, 'Monday'], [0, 'Sunday'], [6, 'Saturday']].map(([v, l]) => h('option', { value: v, selected: v === cal.weekStart }, l)));
  const view = h('select', { class: 'input' },
    Object.entries(VIEW_LABELS).map(([v, l]) => h('option', { value: v, selected: v === cal.defaultView }, l)));
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes');
  const form = h('form', { class: 'stack' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Calendar name'), name),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Time zone'), tz,
      h('span', { class: 'hint' }, 'Used for new events created through links that do not send a time zone and for the iCal feed.')),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Week starts on'), weekStart),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Default view'), view),
    h('div', {}, save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      app.calendar = await app.api.updateCalendar({ name: name.value, timezone: tz.value, weekStart: Number(weekStart.value), defaultView: view.value });
      toast('Settings saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  panel.append(form);
  if (app.api.isLocal) panel.append(backupSection(app));
}

function backupSection(app) {
  const file = h('input', { type: 'file', accept: '.sqlite,application/octet-stream', hidden: true });
  file.addEventListener('change', async () => {
    const [f] = file.files;
    if (!f) return;
    if (!(await confirmDialog('Restore backup?', 'All calendars stored in this browser will be replaced by the backup.', 'Restore'))) return;
    try {
      await app.api.importBytes(new Uint8Array(await f.arrayBuffer()));
      toast('Backup restored');
      location.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  return h('section', { class: 'stack' },
    h('h3', {}, 'Backup'),
    h('p', { class: 'muted' }, `${LOCAL_NOTE} Clearing site data deletes it, so download a backup now and then.`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => download('teamcal-backup.sqlite', app.api.exportBytes(), 'application/octet-stream') }, 'Download backup'),
      h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, 'Restore backup…'),
      file));
}

function subcalendarsTab(app, panel, rerender) {
  const list = h('ul', { class: 'sub-admin' });
  for (const s of app.subcalendars) {
    const name = h('input', { class: 'input', value: s.name, maxlength: 80, 'aria-label': 'Name' });
    const color = h('input', { type: 'color', class: 'color', value: s.color, 'aria-label': 'Color' });
    const saveIt = async () => {
      if (name.value.trim() === s.name && color.value === s.color) return;
      try {
        Object.assign(s, await app.api.updateSub(s.id, { name: name.value, color: color.value }));
        app.renderAll();
      } catch (err) {
        toast(err.message, 'error');
        name.value = s.name;
      }
    };
    name.addEventListener('change', saveIt);
    color.addEventListener('change', saveIt);
    list.append(h('li', {}, color, name,
      h('button', {
        type: 'button',
        class: 'btn btn-ghost danger',
        onclick: async () => {
          if (!(await confirmDialog(`Delete "${s.name}"?`, 'Events that belong only to this sub-calendar will be deleted. Links restricted to it lose access.'))) return;
          try {
            await app.api.deleteSub(s.id);
            await app.reload();
            rerender();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Delete')));
  }
  const newName = h('input', { class: 'input', placeholder: 'New sub-calendar name', maxlength: 80 });
  const newColor = h('input', { type: 'color', class: 'color', value: '#2f6fde', 'aria-label': 'Color' });
  const add = h('form', { class: 'inline-form' }, newColor, newName, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add'));
  add.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await app.api.createSub({ name: newName.value, color: newColor.value });
      await app.reload();
      rerender();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  panel.append(
    h('p', { class: 'muted' }, 'Sub-calendars group events by team, resource or topic. Each has its own color and can be shown, hidden or shared separately.'),
    list, add);
}

function subScopePicker(app, selected) {
  const box = h('div', { class: 'scope-picker' });
  for (const s of app.subcalendars) {
    const cb = h('input', { type: 'checkbox', value: s.id, checked: !selected || selected.includes(s.id) });
    box.append(h('label', { class: 'sub-option', style: { '--c': s.color } }, cb, h('span', { class: 'swatch' }), s.name));
  }
  box.read = () => {
    const ids = [...box.querySelectorAll('input:checked')].map((cb) => Number(cb.value));
    return ids.length === app.subcalendars.length ? null : ids;
  };
  return box;
}

async function linksTab(app, panel, rerender) {
  panel.append(h('p', { class: 'muted' },
    'Share the calendar without accounts: each link grants its own permission level and can be limited to some sub-calendars. Anyone with a link has its access — delete a link to revoke it.'));
  if (app.api.isLocal) panel.append(h('p', { class: 'local-note' }, LOCAL_NOTE));
  let links;
  try {
    links = await app.api.links();
  } catch (err) {
    panel.append(h('p', { class: 'form-error' }, err.message));
    return;
  }
  const list = h('div', { class: 'links' });
  for (const link of links) {
    const role = h('select', { class: 'input' }, Object.entries(ROLE_LABELS).map(([v, l]) => h('option', { value: v, selected: v === link.role }, l)));
    const name = h('input', { class: 'input', value: link.name, maxlength: 80, 'aria-label': 'Link name' });
    const scope = subScopePicker(app, link.subcalendarIds);
    scope.hidden = link.role === 'admin';
    role.addEventListener('change', () => (scope.hidden = role.value === 'admin'));
    const save = h('button', { type: 'button', class: 'btn' }, 'Save');
    save.addEventListener('click', async () => {
      const ids = scope.read();
      if (ids && !ids.length) return toast('Select at least one sub-calendar', 'error');
      try {
        await app.api.updateLink(link.key, { name: name.value, role: role.value, subcalendarIds: ids });
        toast('Link updated');
        rerender();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    const del = h('button', {
      type: 'button',
      class: 'btn btn-ghost danger',
      onclick: async () => {
        if (!(await confirmDialog(`Delete link "${link.name}"?`, 'Anyone using this link will lose access immediately.'))) return;
        try {
          await app.api.deleteLink(link.key);
          rerender();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, 'Delete');
    list.append(h('div', { class: `link-card${link.key === app.key ? ' current' : ''}` },
      h('div', { class: 'row' }, name, role),
      scope,
      copyRow(linkUrl(link.key)),
      h('div', { class: 'row end' },
        link.key === app.key ? h('span', { class: 'badge' }, 'You are using this link') : null,
        del, save)));
  }
  const newName = h('input', { class: 'input', placeholder: 'e.g. "Sales team" or "Public read-only"', maxlength: 80 });
  const newRole = h('select', { class: 'input' }, Object.entries(ROLE_LABELS).map(([v, l]) => h('option', { value: v, selected: v === 'read' }, l)));
  const newScope = subScopePicker(app, null);
  newRole.addEventListener('change', () => (newScope.hidden = newRole.value === 'admin'));
  const form = h('form', { class: 'link-card new' }, h('h3', {}, 'Create a new link'), h('div', { class: 'row' }, newName, newRole), newScope,
    h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create link')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = newScope.read();
    if (ids && !ids.length) return toast('Select at least one sub-calendar', 'error');
    try {
      await app.api.createLink({ name: newName.value, role: newRole.value, subcalendarIds: ids });
      toast('Link created');
      rerender();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  panel.append(list, form);
}

function feedsTab(app, panel) {
  panel.append(
    h('p', { class: 'muted' }, app.api.isLocal
      ? 'Download iCal files to import into Google Calendar, Outlook or Apple Calendar. Live subscription URLs need the TeamCal server.'
      : 'Subscribe to these URLs from Google Calendar, Outlook or Apple Calendar. Feeds are read-only and follow the access of the link they are built from.'),
    h('h3', {}, 'All sub-calendars'), feedControl(app));
  for (const s of app.subcalendars) {
    panel.append(h('h3', {}, h('span', { class: 'swatch', style: { background: s.color } }), s.name), feedControl(app, [s.id]));
  }
}

async function activityTab(app, panel) {
  try {
    const entries = await app.api.activity();
    if (!entries.length) panel.append(h('p', { class: 'muted' }, 'No activity yet.'));
    panel.append(h('ul', { class: 'activity' }, entries.map((a) => h('li', {},
      h('span', { class: 'muted' }, relativeTime(a.at)), ' ', h('strong', {}, a.actor), ' ', a.summary))));
  } catch (err) {
    panel.append(h('p', { class: 'form-error' }, err.message));
  }
}
