import { h, addDays, addMonths, startOfMonth, startOfWeek, sameDay, weekdayShort, fmt, dayDiff } from '../dom.js';
import { rowSegments, assignLanes, chip, trackDrag } from './layout.js';

const LANE = 22;
const HEADER = 26;

export const month = {
  range(date, weekStart) {
    const first = startOfWeek(startOfMonth(date), weekStart);
    const last = startOfWeek(addDays(startOfMonth(addMonths(date, 1)), -1), weekStart);
    const weeks = dayDiff(first, last) / 7 + 1;
    return { start: first, end: addDays(first, weeks * 7), weeks };
  },
  title: (date) => fmt(date, { month: 'long', year: 'numeric' }),
  step: (date, dir) => addMonths(date, dir),

  render(root, ctx) {
    const { start, weeks } = this.range(ctx.date, ctx.weekStart);
    const today = new Date();
    const thisMonth = ctx.date.getMonth();

    const head = h('div', { class: 'month-head' });
    for (let i = 0; i < 7; i++) head.append(h('div', { class: 'month-head-cell' }, weekdayShort(addDays(start, i))));

    const grid = h('div', { class: 'month-grid', style: { gridTemplateRows: `repeat(${weeks}, minmax(96px, 1fr))` } });
    root.append(h('div', { class: 'month' }, head, grid));

    const rowEls = [];
    for (let w = 0; w < weeks; w++) {
      const weekStart = addDays(start, w * 7);
      const row = h('div', { class: 'month-row' });
      const cells = h('div', { class: 'month-cells' });
      for (let d = 0; d < 7; d++) {
        const day = addDays(weekStart, d);
        const cell = h('div', {
          class: `month-cell${day.getMonth() !== thisMonth ? ' other-month' : ''}${sameDay(day, today) ? ' today' : ''}${[0, 6].includes(day.getDay()) ? ' weekend' : ''}`,
          dataset: { date: +day },
          onclick: () => ctx.canAdd && ctx.create({ start: day, end: addDays(day, 1), allDay: true }),
        }, h('button', {
          type: 'button',
          class: 'day-number',
          'aria-label': fmt(day, { weekday: 'long', month: 'long', day: 'numeric' }),
          onclick: (e) => {
            e.stopPropagation();
            ctx.goto('day', day);
          },
        }, day.getDate() === 1 ? fmt(day, { month: 'short', day: 'numeric' }) : day.getDate()));
        cells.append(cell);
      }
      row.append(cells);
      grid.append(row);
      rowEls.push({ row, weekStart });
    }

    // Lanes that fit depend on the rendered row height.
    const rowHeight = rowEls[0].row.getBoundingClientRect().height || 110;
    const maxLanes = Math.max(1, Math.floor((rowHeight - HEADER - 4) / LANE));

    for (const { row, weekStart } of rowEls) {
      const segs = rowSegments(ctx.items, weekStart, 7);
      assignLanes(segs);
      const layer = h('div', { class: 'month-events' });
      const hiddenPerDay = new Array(7).fill(0);
      const lanesPerDay = new Array(7).fill(0);
      for (const seg of segs) {
        for (let c = seg.startCol; c < seg.endCol; c++) lanesPerDay[c] = Math.max(lanesPerDay[c], seg.lane + 1);
      }
      for (const seg of segs) {
        // The last visible lane turns into "+N more" on any day that overflows.
        let overflow = seg.lane >= maxLanes;
        if (seg.lane === maxLanes - 1) {
          for (let c = seg.startCol; c < seg.endCol; c++) if (lanesPerDay[c] > maxLanes) overflow = true;
        }
        if (overflow) {
          for (let c = seg.startCol; c < seg.endCol; c++) hiddenPerDay[c]++;
          continue;
        }
        const el = chip(seg, ctx);
        Object.assign(el.style, {
          top: `${HEADER + seg.lane * LANE}px`,
          left: `calc(${(seg.startCol / 7) * 100}% + 2px)`,
          width: `calc(${((seg.endCol - seg.startCol) / 7) * 100}% - 4px)`,
        });
        if (ctx.canMove(seg.item)) el.addEventListener('pointerdown', (e) => dragChip(e, el, seg, ctx, grid, start, weeks));
        layer.append(el);
      }
      hiddenPerDay.forEach((n, c) => {
        if (!n) return;
        const day = addDays(weekStart, c);
        layer.append(h('button', {
          type: 'button',
          class: 'more-link',
          style: { top: `${HEADER + (maxLanes - 1) * LANE}px`, left: `calc(${(c / 7) * 100}% + 2px)`, width: `calc(${100 / 7}% - 4px)` },
          onclick: (e) => {
            e.stopPropagation();
            ctx.goto('day', day);
          },
        }, `+${n} more`));
      });
      row.append(layer);
    }
  },
};

function dragChip(down, el, seg, ctx, grid, gridStart, weeks) {
  if (down.button !== 0) return;
  const rect = grid.getBoundingClientRect();
  const cellAt = (e) => {
    const col = Math.min(6, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * 7)));
    const row = Math.min(weeks - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * weeks)));
    return addDays(gridStart, row * 7 + col);
  };
  const origin = cellAt(down);
  let target = origin;
  let marked = null;
  trackDrag(down, {
    onStart: () => el.classList.add('dragging'),
    onMove: (dx, dy, e) => {
      target = cellAt(e);
      marked?.classList.remove('drop-target');
      marked = grid.querySelector(`[data-date="${+target}"]`);
      marked?.classList.add('drop-target');
    },
    onEnd: (moved, e, cancelled) => {
      el.classList.remove('dragging');
      marked?.classList.remove('drop-target');
      if (!moved) return;
      el.dataset.dragged = '1';
      setTimeout(() => delete el.dataset.dragged, 0);
      const delta = dayDiff(origin, target);
      if (cancelled || !delta) return;
      const { item } = seg;
      ctx.move(item, addDays(item.start, delta), addDays(item.end, delta));
    },
  });
}
