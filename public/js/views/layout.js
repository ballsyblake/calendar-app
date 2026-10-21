// Layout helpers shared by views.
import { h, addDays, dayDiff, fmtTime, eventBackground, startOfDay } from '../dom.js';
import { isRecurring } from '../model.js';

// Place day-spanning segments into lanes. Each segment: { item, startCol, endCol } (endCol exclusive).
export function assignLanes(segments) {
  const lanes = [];
  for (const seg of segments) {
    let lane = lanes.findIndex((cols) => !cols.some((c) => c >= seg.startCol && c < seg.endCol));
    if (lane === -1) {
      lane = lanes.length;
      lanes.push([]);
    }
    for (let c = seg.startCol; c < seg.endCol; c++) lanes[lane].push(c);
    seg.lane = lane;
  }
  return lanes.length;
}

// Segments of items that intersect the `days` columns starting at `first`.
export function rowSegments(items, first, days, { barsOnly = false } = {}) {
  const last = addDays(first, days);
  const segs = [];
  for (const item of items) {
    if (barsOnly && !item.allDay && !item.isBar) continue;
    if (!(item.end > first && item.start < last) && !(+item.start === +item.end && item.start >= first && item.start < last)) continue;
    const startCol = Math.max(0, dayDiff(first, item.start));
    const endMoment = item.allDay ? item.end : new Date(Math.max(+item.end - 1, +item.start));
    const endCol = Math.min(days, item.allDay ? dayDiff(first, item.end) : dayDiff(first, startOfDay(endMoment)) + 1);
    segs.push({
      item, startCol, endCol: Math.max(endCol, startCol + 1),
      continuesBefore: item.start < first, continuesAfter: item.end > last,
    });
  }
  // Longer bars first so they get the top lanes, then by start.
  segs.sort((a, b) => {
    const aBar = a.item.allDay || a.item.isBar;
    const bBar = b.item.allDay || b.item.isBar;
    if (aBar !== bBar) return aBar ? -1 : 1;
    return a.startCol - b.startCol || (b.endCol - b.startCol) - (a.endCol - a.startCol) || a.item.start - b.item.start;
  });
  return segs;
}

export function chip(seg, ctx, { compact = false } = {}) {
  const { item } = seg;
  const bar = item.allDay || item.isBar;
  const el = h('button', {
    type: 'button',
    class: `chip ${bar ? 'chip-bar' : 'chip-dot'}${seg.continuesBefore ? ' cont-before' : ''}${seg.continuesAfter ? ' cont-after' : ''}`,
    title: tooltip(item),
    dataset: { id: item.id },
    style: bar ? { background: eventBackground(item.colors) } : { '--dot': item.colors[0] },
    onclick: (e) => {
      e.stopPropagation();
      if (!el.dataset.dragged) ctx.open(item);
    },
  });
  if (!bar && !compact) el.append(h('span', { class: 'chip-time' }, fmtTime(item.start)));
  el.append(h('span', { class: 'chip-title' }, item.title));
  if (isRecurring(item)) el.append(h('span', { class: 'chip-icon', 'aria-label': 'Repeats' }, '↻'));
  return el;
}

export function tooltip(item) {
  const ev = item.event;
  const parts = [item.title];
  if (!item.allDay) parts.push(`${fmtTime(item.start)} – ${fmtTime(item.end)}`);
  if (ev.location) parts.push(ev.location);
  if (ev.who) parts.push(`Who: ${ev.who}`);
  return parts.join('\n');
}

// Overlap layout for timed events inside a single day column.
export function columnLayout(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const placed = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const cols = [];
    for (const p of cluster) {
      let c = cols.findIndex((end) => end <= p.top);
      if (c === -1) {
        c = cols.length;
        cols.push(0);
      }
      cols[c] = p.bottom;
      p.col = c;
    }
    for (const p of cluster) p.cols = cols.length;
    placed.push(...cluster);
    cluster = [];
  };
  for (const item of sorted) {
    const p = { item, top: item._top, bottom: Math.max(item._bottom, item._top + 20) };
    if (p.top >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.bottom);
  }
  flush();
  return placed;
}

// Pointer drag helper: calls onMove(dx, dy, ev) after a small threshold and onEnd(moved, ev).
export function trackDrag(downEvent, { onStart, onMove, onEnd }) {
  const x0 = downEvent.clientX;
  const y0 = downEvent.clientY;
  let moved = false;
  const target = downEvent.currentTarget;
  target.setPointerCapture?.(downEvent.pointerId);
  const move = (e) => {
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    if (!moved) {
      moved = true;
      onStart?.(e);
    }
    onMove(dx, dy, e);
  };
  const up = (e) => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    onEnd(moved, e, e.type === 'pointercancel');
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}
