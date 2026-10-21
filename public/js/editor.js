import { h, clear, addDays, fmt, fmtLongDay, fmtRange, relativeTime, storage, saveStorage, toast } from './dom.js';
import { localDateKey, weekdayOfKey, parseDateKey } from './shared/time.js';
import { describeRule, nthWeekdayOf, isLastWeekdayOfMonth, eventStartKey } from './shared/recurrence.js';
import { buildSavePlan, buildDeletePlan } from './model.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ORD = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };
const pad = (n) => String(n).padStart(2, '0');
const timeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function dialog(className, content, { onClose } = {}) {
  const dlg = h('dialog', { class: `dialog ${className}` }, content);
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// Asks how far a change to a repeating event should reach.
export function askScope(verb) {
  return new Promise((resolve) => {
    let answer = null;
    const pick = (value) => () => {
      answer = value;
      dlg.close();
    };
    const dlg = dialog('scope-dialog', h('div', { class: 'dialog-body' },
      h('h2', {}, `${verb} repeating event`),
      h('p', {}, 'This event is part of a series. Apply the change to:'),
      h('div', { class: 'scope-buttons' },
        h('button', { type: 'button', class: 'btn', onclick: pick('one') }, 'Only this event'),
        h('button', { type: 'button', class: 'btn', onclick: pick('future') }, 'This and following events'),
        h('button', { type: 'button', class: 'btn', onclick: pick('all') }, 'All events in the series'),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: pick(null) }, 'Cancel'))), { onClose: () => resolve(answer) });
  });
}

export function confirmDialog(title, text, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let ok = false;
    const dlg = dialog('confirm-dialog', h('div', { class: 'dialog-body' },
      h('h2', {}, title),
      h('p', {}, text),
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'btn btn-danger', onclick: () => { ok = true; dlg.close(); } }, okLabel))), { onClose: () => resolve(ok) });
  });
}

/**
 * Opens the event editor. `item` is an existing occurrence; `draft` pre-fills a new event
 * ({ start, end, allDay, subcalendarId }).
 */
export function openEditor(app, { item = null, draft = null, copyFrom = null }) {
  const ev = item?.event;
  const src = ev || copyFrom;
  const editable = item ? app.canModify(item) : app.canAdd;
  const writableSubs = app.subcalendars.filter((s) => app.canWriteSub(s.id));
  const start = item ? item.start : draft.start;
  const end = item ? item.end : draft.end;
  const allDay = item ? item.allDay : draft.allDay;
  // All-day ends are exclusive internally; the form shows the last day.
  const endShown = allDay ? addDays(end, -1) : end;

  const f = {};
  const field = (label, control, extra = '') => h('label', { class: `field ${extra}` }, h('span', { class: 'field-label' }, label), control);
  f.title = h('input', { type: 'text', class: 'input input-title', placeholder: 'Event title', maxlength: 200, value: src?.title ?? '', required: true });

  const initialSubs = ev ? ev.subcalendarIds
    : copyFrom ? copyFrom.subcalendarIds.filter((id) => app.canWriteSub(id))
      : [draft.subcalendarId ?? app.defaultSubId()].filter(Boolean);
  const selectedSubs = new Set(initialSubs);
  const subPicker = h('div', { class: 'sub-picker', role: 'group', 'aria-label': 'Sub-calendars' });
  const subsForPicker = ev ? app.subcalendars.filter((s) => writableSubs.includes(s) || selectedSubs.has(s.id)) : writableSubs;
  for (const s of subsForPicker) {
    const cb = h('input', { type: 'checkbox', checked: selectedSubs.has(s.id), disabled: !editable || !app.canWriteSub(s.id) });
    cb.addEventListener('change', () => (cb.checked ? selectedSubs.add(s.id) : selectedSubs.delete(s.id)));
    subPicker.append(h('label', { class: 'sub-option', style: { '--c': s.color } }, cb, h('span', { class: 'swatch' }), s.name));
  }

  f.allDay = h('input', { type: 'checkbox', checked: allDay });
  f.startDate = h('input', { type: 'date', class: 'input', value: localDateKey(start), required: true });
  f.startTime = h('input', { type: 'time', class: 'input', value: timeValue(start), step: 300 });
  f.endDate = h('input', { type: 'date', class: 'input', value: localDateKey(endShown), required: true });
  f.endTime = h('input', { type: 'time', class: 'input', value: timeValue(end), step: 300 });
  const syncAllDay = () => {
    f.startTime.hidden = f.allDay.checked;
    f.endTime.hidden = f.allDay.checked;
  };
  f.allDay.addEventListener('change', syncAllDay);
  syncAllDay();
  // Keep the duration when the start moves.
  let lastStart = f.startDate.value;
  f.startDate.addEventListener('change', () => {
    if (!f.startDate.value) return;
    const shift = Math.round((new Date(f.startDate.value) - new Date(lastStart)) / 86400000);
    if (f.endDate.value) f.endDate.value = localDateKey(addDays(new Date(`${f.endDate.value}T00:00`), shift));
    lastStart = f.startDate.value;
    renderRepeatOptions();
  });

  // Repeat
  const rule = src?.rrule;
  f.freq = h('select', { class: 'input' },
    ['none', 'daily', 'weekly', 'monthly', 'yearly'].map((v) => h('option', { value: v, selected: (rule?.freq ?? 'none') === v },
      { none: 'Does not repeat', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[v])));
  f.interval = h('input', { type: 'number', class: 'input input-narrow', min: 1, max: 999, value: rule?.interval ?? 1 });
  const unitLabel = h('span');
  const byday = new Set(rule?.byday ?? []);
  const weekdayBox = h('div', { class: 'weekday-picker' });
  const monthlyBox = h('div', { class: 'monthly-picker' });
  f.endMode = h('select', { class: 'input' },
    h('option', { value: 'never', selected: !rule?.until && !rule?.count }, 'Never'),
    h('option', { value: 'until', selected: !!rule?.until }, 'On date'),
    h('option', { value: 'count', selected: !!rule?.count }, 'After'));
  f.until = h('input', { type: 'date', class: 'input', value: rule?.until ?? '' });
  f.count = h('input', { type: 'number', class: 'input input-narrow', min: 1, max: 1000, value: rule?.count ?? 10 });
  const countLabel = h('span', {}, 'times');
  let monthlyChoice = rule?.monthlyBy === 'weekday' ? (rule.nth === -1 ? 'last' : 'nth') : 'date';
  const summary = h('p', { class: 'repeat-summary' });
  const repeatDetails = h('div', { class: 'repeat-details' },
    h('div', { class: 'row' }, h('span', {}, 'Every'), f.interval, unitLabel),
    weekdayBox, monthlyBox,
    h('div', { class: 'row' }, h('span', {}, 'Ends'), f.endMode, f.until, f.count, countLabel),
    summary);

  function currentRule() {
    const freq = f.freq.value;
    if (freq === 'none') return null;
    const r = { freq, interval: Number(f.interval.value) || 1 };
    if (freq === 'weekly') r.byday = byday.size ? [...byday].sort() : [weekdayOfKey(f.startDate.value)];
    if (freq === 'monthly') {
      r.monthlyBy = monthlyChoice === 'date' ? 'date' : 'weekday';
      if (monthlyChoice === 'last') r.nth = -1;
    }
    if (f.endMode.value === 'until' && f.until.value) r.until = f.until.value;
    if (f.endMode.value === 'count') r.count = Number(f.count.value) || 1;
    return r;
  }

  function renderRepeatOptions() {
    const freq = f.freq.value;
    repeatDetails.hidden = freq === 'none';
    const n = Number(f.interval.value) || 1;
    unitLabel.textContent = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[freq] + (n === 1 ? '' : 's');
    const key = f.startDate.value || localDateKey(start);
    clear(weekdayBox).hidden = freq !== 'weekly';
    if (freq === 'weekly') {
      if (!byday.size) byday.add(weekdayOfKey(key));
      for (let i = 0; i < 7; i++) {
        const d = (app.weekStart + i) % 7;
        weekdayBox.append(h('button', {
          type: 'button',
          class: `toggle${byday.has(d) ? ' on' : ''}`,
          'aria-pressed': String(byday.has(d)),
          disabled: !editable,
          onclick: () => {
            if (byday.has(d) && byday.size > 1) byday.delete(d);
            else byday.add(d);
            renderRepeatOptions();
          },
        }, WEEKDAYS[d]));
      }
    }
    clear(monthlyBox).hidden = freq !== 'monthly';
    if (freq === 'monthly') {
      const wd = fmt(new Date(`${key}T00:00`), { weekday: 'long' });
      const options = [['date', `On day ${parseDateKey(key).d}`]];
      const nth = nthWeekdayOf(key);
      if (nth !== -1) options.push(['nth', `On the ${ORD[nth]} ${wd}`]);
      if (isLastWeekdayOfMonth(key)) options.push(['last', `On the last ${wd}`]);
      if (!options.some(([v]) => v === monthlyChoice)) monthlyChoice = 'date';
      for (const [value, label] of options) {
        const radio = h('input', { type: 'radio', name: 'monthly', value, checked: monthlyChoice === value, disabled: !editable });
        radio.addEventListener('change', () => {
          monthlyChoice = value;
          renderRepeatOptions();
        });
        monthlyBox.append(h('label', { class: 'radio' }, radio, label));
      }
    }
    f.until.hidden = f.endMode.value !== 'until';
    f.count.hidden = countLabel.hidden = f.endMode.value !== 'count';
    summary.textContent = describeRule(currentRule(), key);
  }
  for (const el of [f.freq, f.interval, f.endMode, f.until, f.count]) el.addEventListener('change', renderRepeatOptions);
  renderRepeatOptions();

  f.location = h('input', { type: 'text', class: 'input', maxlength: 300, value: src?.location ?? '', placeholder: 'Add a location' });
  f.who = h('input', { type: 'text', class: 'input', maxlength: 300, value: src?.who ?? '', placeholder: 'People involved' });
  f.notes = h('textarea', { class: 'input', rows: 4, maxlength: 10000, placeholder: 'Description, agenda, links…' }, src?.notes ?? '');

  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = h('form', { class: 'editor-form', novalidate: true },
    f.title,
    field('Sub-calendars', subPicker),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'When'),
      h('div', { class: 'when' },
        h('div', { class: 'row' }, f.startDate, f.startTime, h('span', { class: 'to' }, 'to'), f.endDate, f.endTime),
        h('label', { class: 'checkbox' }, f.allDay, 'All day'))),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Repeat'), h('div', {}, f.freq, repeatDetails)),
    field('Where', f.location),
    field('Who', f.who),
    field('Notes', f.notes),
    errorBox);

  if (!editable) {
    for (const el of form.querySelectorAll('input, select, textarea')) el.disabled = true;
  }

  function readFields() {
    const subs = [...selectedSubs];
    if (!subs.length) throw new Error('Choose at least one sub-calendar.');
    const isAllDay = f.allDay.checked;
    if (!f.startDate.value || !f.endDate.value) throw new Error('Start and end dates are required.');
    const out = {
      title: f.title.value.trim(),
      allDay: isAllDay,
      subcalendarIds: subs,
      location: f.location.value,
      who: f.who.value,
      notes: f.notes.value,
      rrule: currentRule(),
      tz: src?.tz || browserTz(),
    };
    if (isAllDay) {
      out.start = f.startDate.value;
      out.end = f.endDate.value;
      if (out.end < out.start) throw new Error('The end date is before the start date.');
    } else {
      const s = new Date(`${f.startDate.value}T${f.startTime.value || '00:00'}`);
      const e = new Date(`${f.endDate.value}T${f.endTime.value || '00:00'}`);
      if (e < s) throw new Error('The end time is before the start time.');
      out.start = s.toISOString();
      out.end = e.toISOString();
    }
    if (out.rrule?.until && out.rrule.until < f.startDate.value) throw new Error('The repeat end date is before the start date.');
    return out;
  }

  async function save(e) {
    e.preventDefault();
    errorBox.hidden = true;
    let fields;
    try {
      fields = readFields();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      return;
    }
    let scope = 'all';
    if (ev?.rrule) {
      scope = await askScope('Edit');
      if (!scope) return;
    }
    const plan = buildSavePlan(item, fields, scope);
    try {
      saveBtn.disabled = true;
      if (plan.kind === 'create') await app.api.createEvent(plan.body);
      else await app.api.updateEvent(plan.id, plan.body);
      dlg.close();
      toast(plan.kind === 'create' ? 'Event created' : 'Event saved');
      app.refresh();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function remove() {
    let scope = 'all';
    if (ev.rrule) {
      scope = await askScope('Delete');
      if (!scope) return;
    } else if (!(await confirmDialog('Delete event?', `"${ev.title}" will be removed for everyone.`))) {
      return;
    }
    try {
      await app.api.deleteEvent(ev.id, buildDeletePlan(item, scope));
      dlg.close();
      toast('Event deleted');
      app.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, item ? 'Save' : 'Create');
  form.addEventListener('submit', save);
  const actions = h('div', { class: 'dialog-actions' },
    item && editable ? h('button', { type: 'button', class: 'btn btn-danger btn-left', onclick: remove }, 'Delete') : null,
    item && app.canAdd ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => duplicate() }, 'Duplicate') : null,
    h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => dlg.close() }, editable ? 'Cancel' : 'Close'),
    editable ? saveBtn : null);
  // Submit button lives outside <form>; link it.
  form.id = `event-form-${Math.random().toString(36).slice(2)}`;
  saveBtn.setAttribute('form', form.id);

  function duplicate() {
    dlg.close();
    openEditor(app, { draft: { start: item.start, end: item.end, allDay: item.allDay, subcalendarId: ev.subcalendarIds.find((id) => app.canWriteSub(id)) }, copyFrom: ev });
  }

  const header = h('div', { class: 'dialog-header' },
    h('h2', {}, item ? (editable ? 'Edit event' : ev.title) : 'New event'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '×'));

  const body = h('div', { class: 'dialog-body' });
  if (item && !editable) {
    body.append(readOnlySummary(app, item));
  } else {
    body.append(form);
  }
  if (item) {
    body.append(h('p', { class: 'meta' },
      ev.createdBy ? `Added by ${ev.createdBy} · ` : '', `Last changed ${relativeTime(ev.updatedAt)}`));
    body.append(commentsSection(app, ev));
  }

  const dlg = dialog('editor-dialog', [header, body, actions]);
  if (editable) setTimeout(() => (item ? null : f.title.focus()), 0);
  return dlg;
}

function readOnlySummary(app, item) {
  const ev = item.event;
  const rows = [
    ['When', `${fmtLongDay(item.start)} · ${fmtRange(item)}`],
    ev.rrule ? ['Repeats', describeRule(ev.rrule, eventStartKey(ev))] : null,
    ev.location ? ['Where', ev.location] : null,
    ev.who ? ['Who', ev.who] : null,
    ['Calendars', ev.subcalendarIds.map((id) => app.subMap.get(id)?.name).filter(Boolean).join(', ')],
  ].filter(Boolean);
  return h('div', { class: 'readonly' },
    h('dl', {}, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    ev.notes ? h('div', { class: 'notes' }, ev.notes) : null);
}

function commentsSection(app, ev) {
  const listEl = h('ul', { class: 'comments' }, h('li', { class: 'muted' }, 'Loading comments…'));
  const section = h('section', { class: 'comments-section' }, h('h3', {}, 'Comments'), listEl);

  const load = async () => {
    try {
      const comments = await app.api.comments(ev.id);
      clear(listEl);
      if (!comments.length) listEl.append(h('li', { class: 'muted' }, 'No comments yet.'));
      for (const c of comments) {
        listEl.append(h('li', { class: 'comment' },
          h('div', { class: 'comment-head' }, h('strong', {}, c.author), h('span', { class: 'muted' }, relativeTime(c.createdAt)),
            app.canModifyAny ? h('button', {
              type: 'button',
              class: 'linkish danger',
              onclick: async () => {
                await app.api.deleteComment(ev.id, c.id).catch((err) => toast(err.message, 'error'));
                load();
              },
            }, 'Delete') : null),
          h('p', {}, c.body)));
      }
    } catch (err) {
      clear(listEl).append(h('li', { class: 'form-error' }, err.message));
    }
  };
  load();

  if (app.canAdd) {
    const author = h('input', { type: 'text', class: 'input', placeholder: 'Your name', maxlength: 80, value: storage('teamcal.author', '') });
    const text = h('textarea', { class: 'input', rows: 2, placeholder: 'Write a comment…', maxlength: 2000 });
    const post = h('button', { type: 'button', class: 'btn' }, 'Post');
    post.addEventListener('click', async () => {
      if (!text.value.trim()) return;
      saveStorage('teamcal.author', author.value.trim());
      try {
        post.disabled = true;
        await app.api.addComment(ev.id, { author: author.value, body: text.value });
        text.value = '';
        load();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        post.disabled = false;
      }
    });
    section.append(h('div', { class: 'comment-form' }, author, text, post));
  }
  return section;
}
