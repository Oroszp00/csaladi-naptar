// Közös, tiszta dátum- és üzleti logika.
// Ezt a modult a böngésző (app) ÉS a Node.js értesítő script is importálja,
// ezért nem használhat DOM-ot vagy böngésző API-t.

export const EVENT_TYPES = {
  nevnap: { label: 'Névnap', poss: 'névnapja', icon: '🌸' },
  szuletesnap: { label: 'Születésnap', poss: 'születésnapja', icon: '🎂' },
  evfordulo: { label: 'Évforduló', poss: 'évfordulója', icon: '💍' },
};

export const HU_MONTHS = [
  'január', 'február', 'március', 'április', 'május', 'június',
  'július', 'augusztus', 'szeptember', 'október', 'november', 'december',
];
export const HU_WEEKDAYS_SHORT = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'];
export const HU_WEEKDAYS = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];

const pad = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD' (helyi idő szerint) */
export function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date (helyi éjfél) */
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** b - a napokban */
export function diffDays(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

/** A mai dátum egy adott időzónában (alapértelmezés: Budapest). */
export function todayInTZ(timeZone = 'Europe/Budapest', now = new Date()) {
  // az en-CA locale YYYY-MM-DD formátumot ad
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function formatHuDate(iso, withWeekday = true) {
  const d = parseISO(iso);
  const base = `${HU_MONTHS[d.getMonth()]} ${d.getDate()}.`;
  return withWeekday ? `${base} (${HU_WEEKDAYS[d.getDay()]})` : base;
}

export function relativeDayLabel(days) {
  if (days === 0) return 'ma';
  if (days === 1) return 'holnap';
  if (days === 2) return 'holnapután';
  return `${days} nap múlva`;
}

// ---------------------------------------------------------------------------
// Teendők
// ---------------------------------------------------------------------------

const isWeekly = (t) => t.recurrence === 'weekly';

/** 'HH:MM:SS' vagy 'HH:MM' -> 'HH:MM' (üres, ha nincs időpont). */
export function formatTime(t) {
  return t ? String(t).slice(0, 5) : '';
}

/** Rendezés időpont szerint: az időponttal rendelkezők elöl, időrendben; az idő nélküliek a végén. */
export function compareByTime(a, b) {
  const ta = formatTime(a.due_time);
  const tb = formatTime(b.due_time);
  if (ta && tb && ta !== tb) return ta.localeCompare(tb);
  if (ta && !tb) return -1;
  if (!ta && tb) return 1;
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

/** Az adott napon esedékes-e a teendő (heti ismétlődést is kezelve). */
export function occursOn(todo, iso) {
  if (!isWeekly(todo)) return todo.due_date === iso;
  if (iso < todo.due_date) return false;
  if (todo.recurrence_end && iso > todo.recurrence_end) return false;
  if ((todo.skip_dates || []).includes(iso)) return false;
  return diffDays(todo.due_date, iso) % 7 === 0;
}

/** Az adott alkalom ki van-e pipálva. */
export function isDoneOn(todo, iso) {
  return isWeekly(todo) ? (todo.done_dates || []).includes(iso) : !!todo.done;
}

/** A teendő összes előfordulása a [from, to] zárt intervallumban. */
export function occurrencesInRange(todo, from, to) {
  if (!isWeekly(todo)) {
    return todo.due_date >= from && todo.due_date <= to ? [todo.due_date] : [];
  }
  const out = [];
  let start = todo.due_date;
  if (start < from) {
    const k = Math.ceil(diffDays(start, from) / 7);
    start = addDays(todo.due_date, k * 7);
  }
  for (let d = start; d <= to; d = addDays(d, 7)) {
    if (occursOn(todo, d)) out.push(d);
  }
  return out;
}

export function todosOn(todos, iso) {
  return todos.filter((t) => occursOn(t, iso));
}

/**
 * Előkészületi emlékeztetők, amelyek az adott napon aktívak:
 * olyan vásárlós/előkészítős teendők, amelyek a következő `prep_days` napban esedékesek.
 */
export function prepRemindersOn(todos, iso) {
  const out = [];
  for (const t of todos) {
    if (!t.needs_prep) continue;
    const days = t.prep_days || 7;
    for (const occ of occurrencesInRange(t, addDays(iso, 1), addDays(iso, days))) {
      if (!isDoneOn(t, occ)) out.push({ todo: t, date: occ, daysLeft: diffDays(iso, occ) });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || compareByTime(a.todo, b.todo));
}

/** Igaz, ha az adott nap egy előkészítési ablak kezdőnapja (naptár-jelöléshez). */
export function isPrepStartDay(todos, iso) {
  return todos.some((t) => {
    if (!t.needs_prep) return false;
    const due = addDays(iso, t.prep_days || 7);
    return occursOn(t, due) && !isDoneOn(t, due);
  });
}

// ---------------------------------------------------------------------------
// Családi események (évszám nélküli, évente ismétlődő)
// ---------------------------------------------------------------------------

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Az esemény dátuma egy adott évben (feb. 29. nem szökőévben -> feb. 28.). */
export function eventDateInYear(ev, year) {
  let day = ev.day;
  if (ev.month === 2 && day === 29 && !isLeap(year)) day = 28;
  return `${year}-${pad(ev.month)}-${pad(day)}`;
}

/** A következő előfordulás (ma vagy később). */
export function nextEventOccurrence(ev, fromIso) {
  const year = Number(fromIso.slice(0, 4));
  const thisYear = eventDateInYear(ev, year);
  return thisYear >= fromIso ? thisYear : eventDateInYear(ev, year + 1);
}

export function eventsOn(events, iso) {
  const year = Number(iso.slice(0, 4));
  return events.filter((e) => eventDateInYear(e, year) === iso);
}

export function upcomingEvents(events, fromIso) {
  return events
    .map((ev) => {
      const date = nextEventOccurrence(ev, fromIso);
      return { event: ev, date, daysLeft: diffDays(fromIso, date) };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

// ---------------------------------------------------------------------------
// Napi összefoglaló (értesítő script és a „Közelgő” panel használja)
// ---------------------------------------------------------------------------

/** @param notes napi jegyzetek ({ day, note }) – opcionális */
export function buildDigest(todos, events, todayIso, notes = []) {
  const today = todosOn(todos, todayIso)
    .filter((t) => !isDoneOn(t, todayIso))
    .sort(compareByTime)
    .map((t) => ({ todo: t, date: todayIso }));

  const prep = prepRemindersOn(todos, todayIso);

  const familyEvents = upcomingEvents(events, todayIso).filter(
    (x) => x.daysLeft <= (x.event.remind_days ?? 3),
  );

  const note = notes.find((n) => n.day === todayIso)?.note || null;

  return { today, prep, events: familyEvents, note };
}

export function digestIsEmpty(d) {
  return d.today.length === 0 && d.prep.length === 0 && d.events.length === 0 && !d.note;
}

/** Ember által olvasható sorok a push/e-mail/ntfy üzenetekhez. */
export function digestLines(d) {
  const lines = [];
  if (d.note) lines.push(`📝 ${d.note}`);
  for (const e of d.events) {
    const t = EVENT_TYPES[e.event.event_type] || EVENT_TYPES.nevnap;
    lines.push(
      e.daysLeft === 0
        ? `${t.icon} MA van ${e.event.name} ${t.poss}!`
        : `${t.icon} ${e.event.name} ${t.poss} ${relativeDayLabel(e.daysLeft)} (${formatHuDate(e.date, false)})`,
    );
  }
  for (const x of d.today) {
    const time = formatTime(x.todo.due_time);
    lines.push(`${x.todo.needs_prep ? '🛒' : '✅'} Ma${time ? ` ${time}` : ''}: ${x.todo.title}`);
  }
  for (const p of d.prep) {
    lines.push(`🛒 Előkészület: ${p.todo.title} – ${relativeDayLabel(p.daysLeft)} (${formatHuDate(p.date, false)})`);
  }
  return lines;
}
