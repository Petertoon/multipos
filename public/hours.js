// Business hours and rental due-back times. Shared by the server and the register screen.
// hours = { sun: null, mon: { open: '08:00', close: '17:00' }, ... }   (null = closed that day)
// With no hours set, rentals count straight clock time (the old behavior).
(function (root) {
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const DAY_NAMES = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

  // Clean up hours from a form. Returns null when no day is open (= no hours set).
  function cleanHours(h) {
    if (!h || typeof h !== 'object') return null;
    const out = {}; let any = false;
    for (const d of DAYS) {
      const v = h[d];
      if (v && TIME.test(v.open) && TIME.test(v.close)) {
        if (v.close <= v.open) throw new Error(`${DAY_NAMES[d]}: closing time must be after opening time`);
        out[d] = { open: v.open, close: v.close }; any = true;
      } else out[d] = null;
    }
    return any ? out : null;
  }

  // Local date/time parts of an instant in a time zone.
  function parts(date, tz) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    const p = {}; for (const x of f.formatToParts(date)) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, wd: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)) };
  }
  // The instant when the wall clock in tz reads y-m-d hh:mm.
  function at(y, m, d, hh, mm, tz) {
    let guess = Date.UTC(y, m - 1, d, hh, mm);
    for (let i = 0; i < 2; i++) {
      const p = parts(new Date(guess), tz);
      const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
      guess += Date.UTC(y, m - 1, d, hh, mm) - shown;
    }
    return new Date(guess);
  }
  const hm = (s) => s.split(':').map(Number);

  // Move forward through open hours. minutes = 0 just finds the next moment the store is open.
  function addOpenTime(start, minutes, hours, tz) {
    let t = new Date(start), left = minutes * 60000;
    for (let i = 0; i < 800; i++) {
      const p = parts(t, tz);
      const win = hours[DAYS[p.wd]];
      const nextDay = () => { const n = new Date(Date.UTC(p.y, p.m - 1, p.d + 1)); t = at(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0, tz); };
      if (!win) { nextDay(); continue; }
      const open = at(p.y, p.m, p.d, ...hm(win.open), tz), close = at(p.y, p.m, p.d, ...hm(win.close), tz);
      if (t >= close) { nextDay(); continue; }
      if (t < open) t = open;
      const avail = close - t;
      if (left <= avail && !(left === 0 && avail === 0)) return new Date(t.getTime() + left);
      left -= avail; t = close;
    }
    return new Date(start.getTime() + minutes * 60000); // hours make no sense; fall back to clock time
  }

  // When a rental is due back.
  // Half day: that many OPEN hours (time while closed does not count).
  // Day / week / month: same time on the due date; if the store is closed then, the next time it opens.
  function rentalDue(start, period, count, halfDayHours, hours, tz) {
    start = new Date(start);
    if (!hours) {
      const d = new Date(start);
      if (period === 'half_day') d.setHours(d.getHours() + halfDayHours);
      else if (period === 'day') d.setDate(d.getDate() + count);
      else if (period === 'week') d.setDate(d.getDate() + 7 * count);
      else d.setMonth(d.getMonth() + count);
      return d;
    }
    tz = tz || 'America/Chicago';
    if (period === 'half_day') return addOpenTime(start, halfDayHours * 60, hours, tz);
    const p = parts(start, tz);
    let y = p.y, m = p.m, d = p.d;
    if (period === 'day') d += count;
    else if (period === 'week') d += 7 * count;
    else { m += count; const last = new Date(Date.UTC(y, m - 1 + 1, 0)).getUTCDate(); if (d > last) d = last; }
    const n = new Date(Date.UTC(y, m - 1, d));
    const due = at(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), p.h, p.min, tz);
    return addOpenTime(due, 0, hours, tz);
  }

  // "Mon–Fri 8:00 AM–5:00 PM · Sat 9:00 AM–1:00 PM" style summary.
  function hoursText(hours) {
    if (!hours) return 'No hours set';
    const t12 = (s) => { const [h, m] = hm(s); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
    const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const groups = [];
    for (const d of order) {
      const v = hours[d], key = v ? v.open + '-' + v.close : null;
      const g = groups[groups.length - 1];
      if (g && g.key === key) g.days.push(d); else groups.push({ key, v, days: [d] });
    }
    const cap = (d) => d[0].toUpperCase() + d.slice(1);
    return groups.filter((g) => g.v).map((g) => `${cap(g.days[0])}${g.days.length > 1 ? '–' + cap(g.days[g.days.length - 1]) : ''} ${t12(g.v.open)}–${t12(g.v.close)}`).join(' · ') || 'Closed every day';
  }

  // Is the store open at this instant?
  function isOpen(date, hours, tz) {
    if (!hours) return true;
    return addOpenTime(date, 0, hours, tz || 'America/Chicago').getTime() === new Date(date).getTime();
  }

  const api = { DAYS, DAY_NAMES, cleanHours, rentalDue, addOpenTime, hoursText, isOpen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Hours = api;
})(this);
