import { Api } from './api.js';
import { h, clear, addMonths, startOfDay, startOfMonth, toast, storage, saveStorage, DAY } from './dom.js';
import { localDateKey, localDateFromKey, isDateKey } from './shared/time.js';
import { expandEvent } from './shared/recurrence.js';
import { buildItems, buildSavePlan, movedFields } from './model.js';
import { month } from './views/month.js';
import { week, day } from './views/timegrid.js';
import { list, timeline, year, miniMonth, renderAgenda } from './views/others.js';
import { openEditor, askScope } from './editor.js';
import { openSettings, openShare } from './settings.js';

const VIEWS = { month, week, day, list, timeline, year };
const VIEW_LABELS = { day: 'Day', week: 'Week', month: 'Month', year: 'Year', list: 'List', timeline: 'Timeline' };
const RANK = { read: 0, add: 1, modify: 2, admin: 3 };

const $ = (sel) => document.querySelector(sel);
const key = decodeURIComponent(location.pathname.split('/')[2] || '');

const app = {
  key,
  api: new Api(key),
  calendar: null,
  me: null,
  subcalendars: [],
  subMap: new Map(),
  hidden: new Set(storage(`teamcal.hidden.${key}`, [])),
  view: 'month',
  date: startOfDay(new Date()),
  miniDate: startOfMonth(new Date()),
  events: [],
  loaded: null,
  query: '',

  get weekStart() { return this.calendar?.weekStart ?? 1; },
  get canAdd() { return RANK[this.me.role] >= RANK.add && this.subcalendars.some((s) => this.canWriteSub(s.id)); },
  get canModifyAny() { return RANK[this.me.role] >= RANK.modify; },
  canWriteSub(id) {
    return RANK[this.me.role] >= RANK.add && (!this.me.subcalendarIds || this.me.subcalendarIds.includes(id));
  },
  canModify(item) {
    return this.canModifyAny && item.event.subcalendarIds.every((id) => this.canWriteSub(id));
  },
  defaultSubId() {
    const visible = this.subcalendars.find((s) => !this.hidden.has(s.id) && this.canWriteSub(s.id));
    return (visible || this.subcalendars.find((s) => this.canWriteSub(s.id)))?.id;
  },

  async reload() {
    const info = await this.api.info();
    this.calendar = info.calendar;
    this.me = info.me;
    this.subcalendars = info.subcalendars;
    this.subMap = new Map(info.subcalendars.map((s) => [s.id, s]));
    this.loaded = null;
    await this.refresh();
  },

  // Re-fetch events for the visible range and redraw.
  async refresh() {
    const { start, end } = currentRange();
    const from = localDateKey(start);
    const to = localDateKey(end);
    const requestId = (this.requestId = (this.requestId || 0) + 1);
    try {
      const events = await this.api.events(from, to);
      if (requestId !== this.requestId) return;
      this.events = events;
      this.loaded = `${from}/${to}`;
      this.renderAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  renderAll() {
    renderHeader();
    renderSidebar();
    renderView();
  },
};

function currentRange() {
  return VIEWS[app.view].range(app.date, app.weekStart);
}

// ---- routing: #view/YYYY-MM-DD ----

function readHash() {
  const [view, date] = location.hash.slice(1).split('/');
  if (VIEWS[view]) app.view = view;
  if (isDateKey(date)) app.date = localDateFromKey(date);
}

function goto(view, date) {
  const next = `#${view}/${localDateKey(date)}`;
  if (location.hash !== next) location.hash = next;
  else navigate();
}

function navigate() {
  readHash();
  app.miniDate = startOfMonth(app.date);
  const { start, end } = currentRange();
  if (app.loaded === `${localDateKey(start)}/${localDateKey(end)}`) app.renderAll();
  else {
    renderHeader();
    app.refresh();
  }
}

// ---- rendering ----

function renderHeader() {
  document.title = `${app.calendar.name} · TeamCal`;
  $('#cal-name').textContent = app.calendar.name;
  $('#range-title').textContent = app.query ? `Search: “${app.query}”` : VIEWS[app.view].title(app.date, app.weekStart);
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === app.view && !app.query));
  for (const b of document.querySelectorAll('.needs-add')) b.hidden = !app.canAdd;
  $('#settings-btn').hidden = app.me.role !== 'admin';
}

function renderSidebar() {
  const range = currentRange();
  const mini = clear($('#mini'));
  mini.append(h('div', { class: 'mini-nav' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => { app.miniDate = addMonths(app.miniDate, -1); renderSidebar(); } }, '‹'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month', onclick: () => { app.miniDate = addMonths(app.miniDate, 1); renderSidebar(); } }, '›')));
  mini.append(miniMonth(app.miniDate, app, {
    selected: ['day', 'week', 'timeline'].includes(app.view) ? range : null,
    onPick: (d) => goto(app.view === 'year' ? 'day' : app.view, d),
  }));

  const subs = clear($('#sub-list'));
  for (const s of app.subcalendars) {
    const cb = h('input', { type: 'checkbox', checked: !app.hidden.has(s.id) });
    cb.addEventListener('change', () => toggleSub(s.id, cb.checked));
    subs.append(h('li', { class: 'sub-item', style: { '--c': s.color } },
      h('label', {}, cb, h('span', { class: 'swatch' }), h('span', { class: 'sub-name' }, s.name)),
      h('button', { type: 'button', class: 'only-btn', title: `Show only ${s.name}`, onclick: () => showOnly(s.id) }, 'only')));
  }
  const allVisible = app.subcalendars.every((s) => !app.hidden.has(s.id));
  $('#toggle-all').textContent = allVisible ? 'Hide all' : 'Show all';

  const roleText = { admin: 'Administrator', modify: 'Can modify', add: 'Can add', read: 'Read only' }[app.me.role];
  clear($('#me')).append(h('span', { class: 'badge' }, roleText), ' ', app.me.name);
}

function renderView() {
  const root = clear($('#view'));
  root.className = `view view-${app.query ? 'search' : app.view}`;
  if (app.query) return renderSearch(root);
  const { start, end } = currentRange();
  const items = buildItems(app.events, start, end, app.subMap, app.hidden);
  VIEWS[app.view].render(root, viewContext(items));
}

function viewContext(items) {
  return {
    items,
    date: app.date,
    weekStart: app.weekStart,
    subMap: app.subMap,
    visibleSubs: app.subcalendars.filter((s) => !app.hidden.has(s.id)),
    canAdd: app.canAdd,
    canWriteSub: (id) => app.canWriteSub(id),
    canMove: (item) => app.canModify(item),
    open: (item) => openEditor(app, { item }),
    create: (draft) => app.canAdd && openEditor(app, { draft }),
    move: moveItem,
    goto,
  };
}

let searchSeq = 0;
async function renderSearch(root) {
  const seq = ++searchSeq;
  root.append(h('p', { class: 'muted pad' }, 'Searching…'));
  let events;
  try {
    events = await app.api.search(app.query);
  } catch (err) {
    clear(root).append(h('p', { class: 'form-error pad' }, err.message));
    return;
  }
  if (seq !== searchSeq) return;
  // One entry per event: the next occurrence of a series (or its last one if it has ended).
  const today = startOfDay(new Date());
  const items = [];
  for (const ev of events) {
    let from = new Date(1900, 0, 1);
    let to = new Date(2200, 0, 1);
    if (ev.rrule) {
      const occ = expandEvent(ev, new Date(today.getTime() - 3 * 365 * DAY), new Date(today.getTime() + 3 * 365 * DAY));
      const next = occ.find((o) => (o.allDay ? localDateFromKey(o.end) : new Date(o.end)) >= today) || occ[occ.length - 1];
      if (!next) continue;
      from = next.allDay ? localDateFromKey(next.start) : new Date(next.start);
      to = new Date(from.getTime() + 1);
    }
    const [item] = buildItems([ev], from, to, app.subMap, app.hidden);
    if (item) items.push(item);
  }
  items.sort((a, b) => a.start - b.start);
  clear(root);
  renderAgenda(root, items, { ...viewContext(items), range: null }, { emptyText: `No events match “${app.query}”.`, showYear: true });
}

// ---- actions ----

function toggleSub(id, visible) {
  if (visible) app.hidden.delete(id);
  else app.hidden.add(id);
  saveStorage(`teamcal.hidden.${key}`, [...app.hidden]);
  app.renderAll();
}

function showOnly(id) {
  app.hidden = new Set(app.subcalendars.filter((s) => s.id !== id).map((s) => s.id));
  saveStorage(`teamcal.hidden.${key}`, [...app.hidden]);
  app.renderAll();
}

async function moveItem(item, start, end) {
  if (!app.canModify(item)) return;
  let scope = 'all';
  if (item.event.rrule) {
    scope = await askScope('Move');
    if (!scope) return app.renderAll();
  }
  const plan = buildSavePlan(item, movedFields(item, start, end), scope);
  try {
    await app.api.updateEvent(plan.id, plan.body);
    toast('Event moved');
  } catch (err) {
    toast(err.message, 'error');
  }
  app.refresh();
}

function newEvent() {
  if (!app.canAdd) return;
  // Next full hour on the selected day.
  const hour = Math.min(new Date().getHours() + 1, 23);
  const start = new Date(app.date.getFullYear(), app.date.getMonth(), app.date.getDate(), hour);
  openEditor(app, { draft: { start, end: new Date(start.getTime() + 3600000), allDay: false } });
}

function step(dir) {
  goto(app.view, VIEWS[app.view].step(app.date, dir));
}

// ---- live updates ----

function connectStream() {
  if (!window.EventSource) return;
  const source = new EventSource(`/api/c/${encodeURIComponent(key)}/stream`);
  let timer;
  source.onmessage = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!document.querySelector('dialog[open]')) app.reload();
      else app.refresh();
    }, 300);
  };
}

// ---- boot ----

function bindChrome() {
  const viewBar = $('#view-buttons');
  for (const [v, label] of Object.entries(VIEW_LABELS)) {
    viewBar.append(h('button', {
      type: 'button',
      class: 'seg',
      dataset: { view: v },
      onclick: () => {
        clearSearch();
        goto(v, app.date);
      },
    }, label));
  }
  $('#today').addEventListener('click', () => goto(app.view, startOfDay(new Date())));
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  for (const b of document.querySelectorAll('.add-event')) b.addEventListener('click', newEvent);
  $('#settings-btn').addEventListener('click', () => openSettings(app));
  $('#share-btn').addEventListener('click', () => (app.me.role === 'admin' ? openSettings(app, 'links') : openShare(app)));
  $('#menu-btn').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  $('#toggle-all').addEventListener('click', () => {
    const allVisible = app.subcalendars.every((s) => !app.hidden.has(s.id));
    app.hidden = allVisible ? new Set(app.subcalendars.map((s) => s.id)) : new Set();
    saveStorage(`teamcal.hidden.${key}`, [...app.hidden]);
    app.renderAll();
  });

  const search = $('#search');
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      app.query = search.value.trim();
      renderHeader();
      renderView();
    }, 250);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearSearch();
      search.blur();
    }
  });

  window.addEventListener('hashchange', navigate);
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => app.view === 'month' && renderView(), 150);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const keys = { d: 'day', w: 'week', m: 'month', y: 'year', l: 'list', t: 'timeline' };
    if (e.key === 'ArrowLeft' || e.key === 'j') step(-1);
    else if (e.key === 'ArrowRight' || e.key === 'k') step(1);
    else if (e.key === '.') goto(app.view, startOfDay(new Date()));
    else if (e.key === 'n' || e.key === 'c') newEvent();
    else if (e.key === '/') {
      e.preventDefault();
      search.focus();
    } else if (keys[e.key]) goto(keys[e.key], app.date);
    else return;
    e.preventDefault();
  });
}

function clearSearch() {
  if (!app.query) return;
  app.query = '';
  $('#search').value = '';
  renderHeader();
  renderView();
}

async function boot() {
  if (!key) {
    location.href = '/';
    return;
  }
  bindChrome();
  try {
    const info = await app.api.info();
    Object.assign(app, { calendar: info.calendar, me: info.me, subcalendars: info.subcalendars });
    app.subMap = new Map(info.subcalendars.map((s) => [s.id, s]));
  } catch (err) {
    clear($('#view')).append(h('div', { class: 'fatal' },
      h('h2', {}, err.status === 404 ? 'Calendar not found' : 'Could not load the calendar'),
      h('p', {}, err.status === 404 ? 'This link is invalid or has been revoked. Ask the calendar administrator for a new link.' : err.message),
      h('a', { href: '/', class: 'btn' }, 'Go to start page')));
    document.body.classList.add('failed');
    return;
  }
  // Remember recently opened calendars on this device.
  const recent = storage('teamcal.recent', []).filter((r) => r.key !== key);
  recent.unshift({ key, name: app.calendar.name, role: app.me.role, at: Date.now() });
  saveStorage('teamcal.recent', recent.slice(0, 10));

  if (!location.hash) {
    app.view = matchMedia('(max-width: 700px)').matches && ['week', 'timeline'].includes(app.calendar.defaultView) ? 'day' : app.calendar.defaultView;
    history.replaceState(null, '', `#${app.view}/${localDateKey(app.date)}`);
  }
  readHash();
  app.miniDate = startOfMonth(app.date);
  renderHeader();
  await app.refresh();
  connectStream();
}

boot();
