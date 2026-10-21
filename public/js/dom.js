// Small DOM and local-date helpers for the browser UI.

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'indeterminate', 'open']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of [children].flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function toast(message, kind = 'info') {
  let box = document.querySelector('.toasts');
  if (!box) box = document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const t = h('div', { class: `toast toast-${kind}` }, message);
  box.append(t);
  setTimeout(() => t.classList.add('toast-out'), 3500);
  setTimeout(() => t.remove(), 4000);
}

// ---- local dates ----

export const DAY = 86400000;

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

export function addMonths(d, n) {
  const day = d.getDate();
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  r.setDate(Math.min(day, new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate()));
  return r;
}

export function startOfWeek(d, weekStart) {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() - weekStart + 7) % 7));
}

export function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Whole calendar days between two local midnights (DST-safe).
export function dayDiff(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY);
}

export function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}

export function withMinutes(day, minutes) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

// ---- formatting ----

const fmtCache = new Map();
export function fmt(date, options) {
  const k = JSON.stringify(options);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat(undefined, options));
  return fmtCache.get(k).format(date);
}

export const fmtTime = (d) => fmt(d, { hour: 'numeric', minute: '2-digit' });
export const fmtDay = (d) => fmt(d, { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtLongDay = (d) => fmt(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
export const weekdayShort = (d) => fmt(d, { weekday: 'short' });
export const monthName = (d) => fmt(d, { month: 'long' });

export function fmtRange(item) {
  if (item.allDay) {
    const last = addDays(item.end, -1);
    return sameDay(item.start, last) ? 'All day' : `${fmtDay(item.start)} – ${fmtDay(last)}`;
  }
  if (sameDay(item.start, item.end) || +item.end === +startOfDay(item.end) && dayDiff(item.start, item.end) === 1) {
    return `${fmtTime(item.start)} – ${fmtTime(item.end)}`;
  }
  return `${fmtDay(item.start)} ${fmtTime(item.start)} – ${fmtDay(item.end)} ${fmtTime(item.end)}`;
}

export function relativeTime(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return fmt(new Date(iso), { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Background for an event chip: first sub-calendar color, with stripes for the others.
export function eventBackground(colors) {
  if (colors.length <= 1) return colors[0];
  const step = 100 / colors.length;
  const stops = colors.map((c, i) => `${c} ${i * step}%, ${c} ${(i + 1) * step}%`);
  return `linear-gradient(90deg, ${colors[0]} 0, ${colors[0]} calc(100% - ${colors.length * 4}px), ${stops.join(', ')})`;
}

export function storage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}
