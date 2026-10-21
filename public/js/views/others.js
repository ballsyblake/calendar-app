import {
  h, addDays, addMonths, startOfDay, startOfWeek, startOfMonth, sameDay, fmt, fmtRange,
  eventBackground, weekdayShort, withMinutes,
} from '../dom.js';
import { isRecurring } from '../model.js';
import { describeRule, eventStartKey } from '../shared/recurrence.js';
import { rowSegments, assignLanes, chip } from './layout.js';

// ---- List (agenda) ----

const LIST_DAYS = 30;

export function renderAgenda(root, items, ctx, { emptyText, showYear = false } = {}) {
  const byDay = new Map();
  for (const item of items) {
    // Multi-day items appear on each day they cover, within the list range.
    const last = item.allDay ? addDays(item.end, -1) : new Date(Math.max(+item.end - 1, +item.start));
    for (let d = startOfDay(item.start); d <= last; d = addDays(d, 1)) {
      if (ctx.range && (d < ctx.range.start || d >= ctx.range.end)) continue;
      const k = +d;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(item);
      if (!ctx.range) break;
    }
  }
  const list = h('div', { class: 'agenda' });
  if (!byDay.size) list.append(h('p', { class: 'empty' }, emptyText || 'No events in this period.'));
  const today = new Date();
  for (const [k, dayItems] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const date = new Date(k);
    const group = h('section', { class: `agenda-day${sameDay(date, today) ? ' today' : ''}` },
      h('h3', { class: 'agenda-date' },
        h('button', { type: 'button', class: 'linkish', onclick: () => ctx.goto('day', date) },
          fmt(date, { weekday: 'long', month: 'long', day: 'numeric', ...(showYear || date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }))));
    for (const item of dayItems) {
      const ev = item.event;
      group.append(h('button', { type: 'button', class: 'agenda-item', onclick: () => ctx.open(item) },
        h('span', { class: 'agenda-swatch', style: { background: eventBackground(item.colors) } }),
        h('span', { class: 'agenda-time' }, fmtRange(item)),
        h('span', { class: 'agenda-main' },
          h('span', { class: 'agenda-title' }, item.title, isRecurring(item) ? h('span', { class: 'chip-icon', title: describeRule(ev.rrule, eventStartKey(ev)) }, ' ↻') : null),
          ev.location || ev.who ? h('span', { class: 'agenda-meta' }, [ev.location, ev.who && `Who: ${ev.who}`].filter(Boolean).join(' · ')) : null,
          h('span', { class: 'agenda-subs' }, item.subs.map((id) => ctx.subMap.get(id)?.name).filter(Boolean).join(', ')))));
    }
    list.append(group);
  }
  root.append(list);
}

export const list = {
  range(date) {
    const start = startOfDay(date);
    return { start, end: addDays(start, LIST_DAYS) };
  },
  title(date) {
    const { start, end } = this.range(date);
    return `${fmt(start, { month: 'short', day: 'numeric' })} – ${fmt(addDays(end, -1), { month: 'short', day: 'numeric', year: 'numeric' })}`;
  },
  step: (date, dir) => addDays(date, dir * LIST_DAYS),
  render(root, ctx) {
    renderAgenda(root, ctx.items, { ...ctx, range: this.range(ctx.date) });
  },
};

// ---- Timeline: one row per sub-calendar, days across ----

const TL_DAYS = 7;
const TL_LANE = 24;

export const timeline = {
  range(date, weekStart) {
    const start = startOfWeek(date, weekStart);
    return { start, end: addDays(start, TL_DAYS) };
  },
  title(date, weekStart) {
    const { start } = this.range(date, weekStart);
    return `${fmt(start, { month: 'short', day: 'numeric' })} – ${fmt(addDays(start, TL_DAYS - 1), { month: 'short', day: 'numeric', year: 'numeric' })}`;
  },
  step: (date, dir) => addDays(date, dir * TL_DAYS),
  render(root, ctx) {
    const { start } = this.range(ctx.date, ctx.weekStart);
    const today = new Date();
    const head = h('div', { class: 'tl-head' }, h('div', { class: 'tl-label' }));
    const scale = h('div', { class: 'tl-scale' });
    for (let d = 0; d < TL_DAYS; d++) {
      const date = addDays(start, d);
      scale.append(h('button', {
        type: 'button',
        class: `tl-day${sameDay(date, today) ? ' today' : ''}`,
        onclick: () => ctx.goto('day', date),
      }, `${weekdayShort(date)} ${date.getDate()}`));
    }
    head.append(scale);
    const body = h('div', { class: 'tl-body' });

    for (const sub of ctx.visibleSubs) {
      const segs = rowSegments(ctx.items.filter((i) => i.subs.includes(sub.id)), start, TL_DAYS);
      const lanes = assignLanes(segs);
      const track = h('div', { class: 'tl-track', style: { height: `${Math.max(1, lanes) * TL_LANE + 8}px` } });
      for (let d = 0; d < TL_DAYS; d++) {
        const date = addDays(start, d);
        track.append(h('div', {
          class: `tl-cell${[0, 6].includes(date.getDay()) ? ' weekend' : ''}${sameDay(date, today) ? ' today' : ''}`,
          style: { left: `${(d / TL_DAYS) * 100}%`, width: `${100 / TL_DAYS}%` },
          onclick: () => {
            if (!ctx.canAdd || !ctx.canWriteSub(sub.id)) return;
            ctx.create({ start: withMinutes(date, 9 * 60), end: withMinutes(date, 10 * 60), allDay: false, subcalendarId: sub.id });
          },
        }));
      }
      for (const seg of segs) {
        const el = chip(seg, ctx);
        Object.assign(el.style, {
          top: `${4 + seg.lane * TL_LANE}px`,
          left: `calc(${(seg.startCol / TL_DAYS) * 100}% + 2px)`,
          width: `calc(${((seg.endCol - seg.startCol) / TL_DAYS) * 100}% - 4px)`,
        });
        track.append(el);
      }
      body.append(h('div', { class: 'tl-row' },
        h('div', { class: 'tl-label' }, h('span', { class: 'swatch', style: { background: sub.color } }), sub.name),
        track));
    }
    if (!ctx.visibleSubs.length) body.append(h('p', { class: 'empty' }, 'All sub-calendars are hidden.'));
    root.append(h('div', { class: 'tl' }, head, body));
  },
};

// ---- Year: twelve mini months with event density ----

export const year = {
  range(date) {
    const start = new Date(date.getFullYear(), 0, 1);
    return { start, end: new Date(date.getFullYear() + 1, 0, 1) };
  },
  title: (date) => String(date.getFullYear()),
  step: (date, dir) => addMonths(date, dir * 12),
  render(root, ctx) {
    const { start } = this.range(ctx.date);
    const counts = new Map();
    for (const item of ctx.items) {
      const last = item.allDay ? addDays(item.end, -1) : new Date(Math.max(+item.end - 1, +item.start));
      for (let d = startOfDay(item.start); d <= last; d = addDays(d, 1)) {
        const entry = counts.get(+d) || { n: 0, colors: [] };
        entry.n++;
        if (entry.colors.length < 3 && !entry.colors.includes(item.colors[0])) entry.colors.push(item.colors[0]);
        counts.set(+d, entry);
      }
    }
    const grid = h('div', { class: 'year' });
    for (let m = 0; m < 12; m++) {
      const monthStart = addMonths(start, m);
      grid.append(miniMonth(monthStart, ctx, {
        onPick: (d) => ctx.goto('day', d),
        decorate: (cell, d) => {
          const c = counts.get(+d);
          if (!c) return;
          cell.classList.add('has-events');
          cell.title = `${c.n} event${c.n === 1 ? '' : 's'}`;
          cell.append(h('span', { class: 'dots' }, c.colors.map((color) => h('span', { class: 'dot', style: { background: color } }))));
        },
        heading: (d) => h('button', { type: 'button', class: 'mini-title linkish', onclick: () => ctx.goto('month', d) }, fmt(d, { month: 'long' })),
      }));
    }
    root.append(grid);
  },
};

// Mini month grid, used by the year view and the sidebar navigator.
export function miniMonth(monthStart, ctx, { onPick, decorate, heading, selected } = {}) {
  const first = startOfWeek(startOfMonth(monthStart), ctx.weekStart);
  const today = new Date();
  const table = h('div', { class: 'mini' });
  table.append(heading ? heading(monthStart) : h('div', { class: 'mini-title' }, fmt(monthStart, { month: 'long', year: 'numeric' })));
  const grid = h('div', { class: 'mini-grid', role: 'grid' });
  for (let i = 0; i < 7; i++) grid.append(h('div', { class: 'mini-wd' }, fmt(addDays(first, i), { weekday: 'narrow' })));
  for (let i = 0; i < 42; i++) {
    const d = addDays(first, i);
    if (i >= 35 && d.getMonth() !== monthStart.getMonth()) break;
    const cell = h('button', {
      type: 'button',
      class: `mini-day${d.getMonth() !== monthStart.getMonth() ? ' other-month' : ''}${sameDay(d, today) ? ' today' : ''}${selected && d >= selected.start && d < selected.end ? ' selected' : ''}`,
      onclick: () => onPick(d),
      'aria-label': fmt(d, { weekday: 'long', month: 'long', day: 'numeric' }),
    }, h('span', {}, d.getDate()));
    decorate?.(cell, d);
    grid.append(cell);
  }
  table.append(grid);
  return table;
}
