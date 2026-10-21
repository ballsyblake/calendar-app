import { h, addDays, startOfDay, startOfWeek, sameDay, fmt, fmtTime, minutesOfDay, withMinutes, eventBackground, dayDiff } from '../dom.js';
import { rowSegments, assignLanes, chip, columnLayout, trackDrag, tooltip } from './layout.js';
import { isRecurring } from '../model.js';

const HOUR = 48;
const SNAP = 15;
const LANE = 22;
let savedScroll = null;

function makeView(days) {
  return {
    range(date, weekStart) {
      const start = days === 7 ? startOfWeek(date, weekStart) : startOfDay(date);
      return { start, end: addDays(start, days) };
    },
    title(date, weekStart) {
      if (days === 1) return fmt(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const { start } = this.range(date, weekStart);
      const last = addDays(start, 6);
      if (start.getMonth() === last.getMonth()) return `${fmt(start, { month: 'long', day: 'numeric' })} – ${last.getDate()}, ${last.getFullYear()}`;
      return `${fmt(start, { month: 'short', day: 'numeric' })} – ${fmt(last, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    },
    step: (date, dir) => addDays(date, dir * days),
    render(root, ctx) {
      renderGrid(root, ctx, this.range(ctx.date, ctx.weekStart).start, days);
    },
  };
}

export const week = makeView(7);
export const day = makeView(1);

function renderGrid(root, ctx, first, days) {
  const today = new Date();
  const cols = `56px repeat(${days}, minmax(0, 1fr))`;

  const head = h('div', { class: 'tg-head', style: { gridTemplateColumns: cols } }, h('div'));
  for (let d = 0; d < days; d++) {
    const date = addDays(first, d);
    head.append(h('button', {
      type: 'button',
      class: `tg-day-label${sameDay(date, today) ? ' today' : ''}`,
      onclick: () => ctx.goto('day', date),
    }, h('span', { class: 'tg-wd' }, fmt(date, { weekday: 'short' })), h('span', { class: 'tg-dn' }, date.getDate())));
  }

  // All-day row: all-day events and timed events spanning several days.
  const barItems = ctx.items.filter((i) => i.allDay || i.isBar);
  const segs = rowSegments(barItems, first, days);
  const lanes = assignLanes(segs);
  const allDayArea = h('div', { class: 'tg-allday-area', style: { height: `${Math.max(1, lanes) * LANE + 6}px` } });
  for (let d = 0; d < days; d++) {
    const date = addDays(first, d);
    allDayArea.append(h('div', {
      class: 'tg-allday-cell',
      style: { left: `${(d / days) * 100}%`, width: `${100 / days}%` },
      onclick: () => ctx.canAdd && ctx.create({ start: date, end: addDays(date, 1), allDay: true }),
    }));
  }
  for (const seg of segs) {
    const el = chip(seg, ctx);
    Object.assign(el.style, {
      top: `${3 + seg.lane * LANE}px`,
      left: `calc(${(seg.startCol / days) * 100}% + 2px)`,
      width: `calc(${((seg.endCol - seg.startCol) / days) * 100}% - 4px)`,
    });
    allDayArea.append(el);
  }
  const allDay = h('div', { class: 'tg-allday', style: { gridTemplateColumns: '56px 1fr' } }, h('div', { class: 'tg-allday-label' }, 'All day'), allDayArea);

  const body = h('div', { class: 'tg-body', style: { gridTemplateColumns: cols, height: `${24 * HOUR}px` } });
  const gutter = h('div', { class: 'tg-gutter' });
  for (let hr = 1; hr < 24; hr++) {
    gutter.append(h('div', { class: 'tg-hour', style: { top: `${hr * HOUR}px` } }, fmt(new Date(2000, 0, 1, hr), { hour: 'numeric' })));
  }
  body.append(gutter);

  const columns = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(first, d);
    const col = h('div', {
      class: `tg-col${sameDay(date, today) ? ' today' : ''}${[0, 6].includes(date.getDay()) ? ' weekend' : ''}`,
      dataset: { date: +date },
    });
    if (ctx.canAdd) col.addEventListener('pointerdown', (e) => dragCreate(e, col, date, ctx));
    columns.push(col);
    body.append(col);

    const dayEnd = addDays(date, 1);
    const timed = ctx.items.filter((i) => !i.allDay && !i.isBar && i.start < dayEnd && (i.end > date || (+i.start === +i.end && i.start >= date)));
    for (const item of timed) {
      item._top = (Math.max(item.start, date) - date) / 60000 / 60 * HOUR;
      item._bottom = (Math.min(item.end, dayEnd) - date) / 60000 / 60 * HOUR;
    }
    for (const p of columnLayout(timed)) col.append(timedChip(p, ctx, { col, date, columns, first }));

    if (sameDay(date, today)) {
      col.append(h('div', { class: 'now-line', style: { top: `${(minutesOfDay(today) / 60) * HOUR}px` } }));
    }
  }

  const scroller = h('div', { class: 'tg-scroll' }, body);
  scroller.addEventListener('scroll', () => {
    savedScroll = scroller.scrollTop;
  });
  root.append(h('div', { class: `tg tg-${days}` }, head, allDay, scroller));

  if (savedScroll == null) {
    const hasToday = dayDiff(first, today) >= 0 && dayDiff(first, today) < days;
    savedScroll = Math.max(0, ((hasToday ? today.getHours() - 1 : 7) * HOUR));
  }
  scroller.scrollTop = savedScroll;
  // Keep header columns aligned with the scrollbar-narrowed body.
  root.firstChild.style.setProperty('--sbw', `${scroller.offsetWidth - scroller.clientWidth}px`);
}

function timedChip(p, ctx, { col, date, columns, first }) {
  const { item } = p;
  const height = Math.max(p.bottom - p.top, 20);
  const short = height < 40;
  const el = h('button', {
    type: 'button',
    class: `tg-event${short ? ' short' : ''}`,
    title: tooltip(item),
    style: {
      top: `${p.top}px`,
      height: `${height - 2}px`,
      left: `calc(${(p.col / p.cols) * 100}% + 1px)`,
      width: `calc(${(1 / p.cols) * 100}% - 3px)`,
      background: eventBackground(item.colors),
    },
    onclick: (e) => {
      e.stopPropagation();
      if (!el.dataset.dragged) ctx.open(item);
    },
  },
  h('span', { class: 'tg-event-title' }, item.title, isRecurring(item) ? ' ↻' : ''),
  h('span', { class: 'tg-event-time' }, `${fmtTime(item.start)} – ${fmtTime(item.end)}`),
  item.event.location && !short ? h('span', { class: 'tg-event-loc' }, item.event.location) : null);

  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  if (ctx.canMove(item)) {
    const handle = h('span', { class: 'resize-handle', 'aria-hidden': 'true' });
    el.append(handle);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target === handle) resizeEvent(e, el, item, ctx, height);
      else moveEvent(e, el, item, ctx, { col, date, columns, first, top: p.top });
    });
  }
  return el;
}

const snapMinutes = (px) => Math.round((px / HOUR) * 60 / SNAP) * SNAP;

function moveEvent(down, el, item, ctx, { columns, top }) {
  const colWidth = columns[0].getBoundingClientRect().width;
  const startCol = columns.findIndex((c) => c.contains(el));
  let deltaMin = 0;
  let deltaDays = 0;
  trackDrag(down, {
    onStart: () => el.classList.add('dragging'),
    onMove: (dx, dy) => {
      deltaMin = snapMinutes(dy);
      deltaDays = Math.max(-startCol, Math.min(columns.length - 1 - startCol, Math.round(dx / colWidth)));
      el.style.top = `${top + (deltaMin / 60) * HOUR}px`;
      el.style.transform = `translateX(${deltaDays * colWidth}px)`;
    },
    onEnd: (moved, e, cancelled) => {
      el.classList.remove('dragging');
      if (!moved) return;
      el.dataset.dragged = '1';
      setTimeout(() => delete el.dataset.dragged, 0);
      if (cancelled || (!deltaMin && !deltaDays)) {
        el.style.top = `${top}px`;
        el.style.transform = '';
        return;
      }
      const shift = (d) => new Date(addDays(d, deltaDays).getTime() + deltaMin * 60000);
      ctx.move(item, shift(item.start), shift(item.end));
    },
  });
}

function resizeEvent(down, el, item, ctx, height) {
  let deltaMin = 0;
  const minHeight = (SNAP / 60) * HOUR;
  trackDrag(down, {
    onMove: (dx, dy) => {
      deltaMin = snapMinutes(dy);
      el.style.height = `${Math.max(minHeight, height + (deltaMin / 60) * HOUR) - 2}px`;
    },
    onEnd: (moved, e, cancelled) => {
      if (!moved) return;
      el.dataset.dragged = '1';
      setTimeout(() => delete el.dataset.dragged, 0);
      if (cancelled || !deltaMin) {
        el.style.height = `${height - 2}px`;
        return;
      }
      const end = new Date(Math.max(item.end.getTime() + deltaMin * 60000, item.start.getTime() + SNAP * 60000));
      ctx.move(item, item.start, end);
    },
  });
}

function dragCreate(down, col, date, ctx) {
  if (down.button !== 0 || down.target !== col) return;
  const rect = col.getBoundingClientRect();
  const minuteAt = (y) => Math.max(0, Math.min(24 * 60, Math.floor(((y - rect.top) / HOUR) * 60 / SNAP) * SNAP));
  const anchor = minuteAt(down.clientY);
  let from = anchor;
  let to = anchor + 60;
  const ghost = h('div', { class: 'tg-ghost' });
  const paint = () => {
    ghost.style.top = `${(from / 60) * HOUR}px`;
    ghost.style.height = `${((to - from) / 60) * HOUR}px`;
    ghost.textContent = `${fmtTime(withMinutes(date, from))} – ${fmtTime(withMinutes(date, to))}`;
  };
  trackDrag(down, {
    onStart: () => {
      col.append(ghost);
      paint();
    },
    onMove: (dx, dy, e) => {
      const m = minuteAt(e.clientY);
      from = Math.min(anchor, m);
      to = Math.max(anchor + SNAP, m + SNAP);
      to = Math.min(to, 24 * 60);
      paint();
    },
    onEnd: (moved, e, cancelled) => {
      ghost.remove();
      if (cancelled) return;
      if (!moved) {
        from = anchor;
        to = Math.min(anchor + 60, 24 * 60);
      }
      ctx.create({ start: withMinutes(date, from), end: withMinutes(date, to), allDay: false });
    },
  });
}
