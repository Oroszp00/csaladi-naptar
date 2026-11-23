// Fő alkalmazás: nézetek renderelése és eseménykezelés.
import * as db from './db.js';
import * as push from './push.js';
import {
  EVENT_TYPES, HU_MONTHS, HU_WEEKDAYS_SHORT,
  toISO, parseISO, addDays, diffDays, formatHuDate, relativeDayLabel,
  todosOn, isDoneOn, occursOn, occurrencesInRange, prepRemindersOn, isPrepStartDay,
  eventsOn, upcomingEvents, buildDigest,
} from './logic.js';

// ---------------------------------------------------------------------------
// Állapot
// ---------------------------------------------------------------------------

const state = {
  user: null,
  todos: [],
  events: [],
  tab: 'calendar',
  month: (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(),
  selected: null,       // kiválasztott nap ISO
  editingTodo: null,    // szerkesztett teendő id
  editingEvent: null,   // szerkesztett családi esemény id
  showEventForm: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const today = () => toISO(new Date());
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function setSync(text) { $('#sync-status').textContent = text; }

/** Egyszerű választó dialógus. Visszaadja a választott opció értékét vagy null-t. */
function choose(title, options) {
  return new Promise((resolve) => {
    const dlg = $('#dialog');
    $('#dialog-title').textContent = title;
    const box = $('#dialog-buttons');
    box.innerHTML = '';
    const close = (v) => { dlg.hidden = true; resolve(v); };
    for (const o of [...options, { label: 'Mégse', value: null, cls: 'btn-ghost' }]) {
      const b = document.createElement('button');
      b.className = o.cls || 'btn-soft';
      b.textContent = o.label;
      b.onclick = () => close(o.value);
      box.appendChild(b);
    }
    dlg.onclick = (e) => { if (e.target === dlg) close(null); };
    dlg.hidden = false;
  });
}

async function guard(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (err) {
    console.error(err);
    toast(`Hiba: ${err.message || err}`, 4000);
  }
}

// ---------------------------------------------------------------------------
// Adatbetöltés
// ---------------------------------------------------------------------------

async function loadData() {
  setSync(db.isCloud ? 'szinkronizálás…' : 'helyi mód');
  try {
    const [todos, events] = await Promise.all([db.list('todos'), db.list('family_events')]);
    state.todos = todos;
    state.events = events;
    if (db.isCloud) setSync(navigator.onLine ? '● szinkronban' : 'offline');
  } catch (err) {
    console.error(err);
    setSync('⚠ nincs kapcsolat');
  }
  render();
}

// ---------------------------------------------------------------------------
// Navigáció
// ---------------------------------------------------------------------------

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== tab; });
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  if (state.tab === 'calendar') renderCalendar();
  if (state.tab === 'family') renderFamily();
  if (state.tab === 'settings') renderSettings();
  if (state.selected) renderDay();
}

// ---------------------------------------------------------------------------
// Naptár nézet
// ---------------------------------------------------------------------------

function renderCalendar() {
  const m = state.month;
  const year = m.getFullYear();
  const month = m.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const offset = (m.getDay() + 6) % 7; // hétfő az első nap
  const t = today();

  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<div class="cal-day empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = toISO(new Date(year, month, d));
    const dayTodos = todosOn(state.todos, iso);
    const open = dayTodos.filter((x) => !isDoneOn(x, iso));
    const hasPrep = open.some((x) => x.needs_prep);
    const hasEvent = eventsOn(state.events, iso).length > 0;
    const prepStart = isPrepStartDay(state.todos, iso);
    const weekday = (offset + d - 1) % 7;

    let dots = '';
    if (open.some((x) => !x.needs_prep)) dots += '<span class="dot dot-todo"></span>';
    else if (dayTodos.length && !open.length) dots += '<span class="dot dot-done"></span>';
    if (hasPrep) dots += '<span class="dot dot-prep"></span>';
    if (prepStart) dots += '<span class="dot dot-prepstart"></span>';
    if (hasEvent) dots += '<span class="dot dot-event"></span>';

    const label = [
      formatHuDate(iso),
      open.length ? `${open.length} nyitott teendő` : '',
      hasEvent ? 'családi esemény' : '',
    ].filter(Boolean).join(', ');

    cells += `
      <button class="cal-day ${weekday >= 5 ? 'weekend' : ''} ${iso === t ? 'today' : ''}" data-day="${iso}" aria-label="${esc(label)}">
        ${hasEvent ? '<span class="cal-icon">🎉</span>' : hasPrep ? '<span class="cal-icon">🛒</span>' : ''}
        <span>${d}</span>
        <span class="cal-dots">${dots}</span>
      </button>`;
  }

  const digest = buildDigest(state.todos, state.events, t);

  $('#view-calendar').innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <button class="btn-soft px-3" data-act="prev" aria-label="Előző hónap">‹</button>
      <div class="text-center">
        <div class="font-bold text-lg">${year}. ${HU_MONTHS[month]}</div>
        <button class="text-xs text-indigo-600" data-act="today">Ugrás a mai napra</button>
      </div>
      <button class="btn-soft px-3" data-act="next" aria-label="Következő hónap">›</button>
    </div>

    <div class="cal-grid text-center text-xs font-semibold text-slate-400 mb-1">
      ${HU_WEEKDAYS_SHORT.map((w) => `<div>${w}</div>`).join('')}
    </div>
    <div class="cal-grid">${cells}</div>

    <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 mt-3">
      <span class="flex items-center gap-1"><span class="dot dot-todo"></span>teendő</span>
      <span class="flex items-center gap-1"><span class="dot dot-prep"></span>vásárlós teendő</span>
      <span class="flex items-center gap-1"><span class="dot dot-prepstart"></span>előkészület kezdete</span>
      <span class="flex items-center gap-1"><span class="dot dot-event"></span>családi esemény</span>
    </div>

    <h2 class="font-bold mt-6 mb-2">Mai összefoglaló</h2>
    ${renderDigest(digest)}

    <h2 class="font-bold mt-6 mb-2">Következő 14 nap</h2>
    ${renderUpcoming(t)}
  `;
}

function renderDigest(d) {
  const items = [];
  for (const e of d.events) {
    const ty = EVENT_TYPES[e.event.event_type] || EVENT_TYPES.nevnap;
    items.push(`<li class="flex gap-2"><span>${ty.icon}</span><span><b>${esc(e.event.name)}</b> ${ty.poss} – ${e.daysLeft === 0 ? '<b class="text-pink-600">MA!</b>' : relativeDayLabel(e.daysLeft)}</span></li>`);
  }
  for (const x of d.today) {
    items.push(`<li class="flex gap-2"><span>${x.todo.needs_prep ? '🛒' : '✅'}</span><span>${esc(x.todo.title)}</span></li>`);
  }
  for (const p of d.prep) {
    items.push(`<li class="flex gap-2"><span>🛒</span><span>Készülj: <b>${esc(p.todo.title)}</b> – ${relativeDayLabel(p.daysLeft)} <span class="text-slate-400">(${formatHuDate(p.date, false)})</span></span></li>`);
  }
  if (!items.length) return '<div class="card text-sm text-slate-500">Mára nincs teendő és közelgő esemény. 🌿</div>';
  return `<ul class="card space-y-2 text-sm">${items.join('')}</ul>`;
}

function renderUpcoming(fromIso) {
  const to = addDays(fromIso, 13);
  const rows = [];
  for (const t of state.todos) {
    for (const d of occurrencesInRange(t, addDays(fromIso, 1), to)) {
      if (!isDoneOn(t, d)) rows.push({ date: d, html: `${t.needs_prep ? '🛒' : '•'} ${esc(t.title)}` });
    }
  }
  for (const u of upcomingEvents(state.events, addDays(fromIso, 1))) {
    if (u.date > to) continue;
    const ty = EVENT_TYPES[u.event.event_type] || EVENT_TYPES.nevnap;
    rows.push({ date: u.date, html: `${ty.icon} ${esc(u.event.name)} ${ty.poss}` });
  }
  if (!rows.length) return '<div class="card text-sm text-slate-500">Nincs bejegyzés a következő két hétben.</div>';
  rows.sort((a, b) => a.date.localeCompare(b.date));

  // Napok szerint csoportosítva, a hét napjai szerinti színes sávval.
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.date)) groups.set(r.date, []);
    groups.get(r.date).push(r.html);
  }
  return `<div class="space-y-2">${[...groups].map(([date, items]) => {
    const wd = parseISO(date).getDay(); // 0 = vasárnap
    const rel = diffDays(fromIso, date);
    const relText = rel <= 2 ? relativeDayLabel(rel) : '';
    return `
      <button class="upcoming-day wd-${wd} w-full text-left" data-day="${date}">
        <div class="upcoming-head">
          <span>${formatHuDate(date)}</span>
          ${relText ? `<span class="upcoming-rel">${relText}</span>` : ''}
        </div>
        <ul class="upcoming-items">${items.map((h) => `<li>${h}</li>`).join('')}</ul>
      </button>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Nap nézet (alsó lap)
// ---------------------------------------------------------------------------

function openDay(iso) {
  state.selected = iso;
  state.editingTodo = null;
  $('#day-sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  renderDay();
}

function closeDay() {
  state.selected = null;
  state.editingTodo = null;
  $('#day-sheet').hidden = true;
  document.body.style.overflow = '';
}

function renderDay() {
  const iso = state.selected;
  const dayTodos = todosOn(state.todos, iso)
    .sort((a, b) => Number(isDoneOn(a, iso)) - Number(isDoneOn(b, iso)));
  const dayEvents = eventsOn(state.events, iso);
  const preps = prepRemindersOn(state.todos, iso);
  const editing = state.todos.find((t) => t.id === state.editingTodo) || null;
  const rel = diffDays(today(), iso);
  const relText = rel >= 0 && rel <= 2 ? ` · ${relativeDayLabel(rel)}` : '';

  const todoItems = dayTodos.map((t) => {
    const done = isDoneOn(t, iso);
    return `
      <li class="flex items-start gap-3 py-2">
        <button class="check ${done ? 'on' : ''} mt-0.5" data-act="toggle" data-id="${t.id}" aria-label="${done ? 'Visszavonás' : 'Kész'}">${done ? '✓' : ''}</button>
        <button class="flex-1 text-left" data-act="edit" data-id="${t.id}">
          <div class="${done ? 'line-through text-slate-400' : 'font-medium'}">${esc(t.title)}</div>
          ${t.notes ? `<div class="text-xs text-slate-500">${esc(t.notes)}</div>` : ''}
          <div class="flex gap-1 mt-1 flex-wrap">
            ${t.needs_prep ? `<span class="badge badge-prep">🛒 ${t.prep_days} nappal előre</span>` : ''}
            ${t.recurrence === 'weekly' ? '<span class="badge badge-rec">🔁 hetente</span>' : ''}
          </div>
        </button>
        <button class="text-slate-400 px-2 text-lg" data-act="delete" data-id="${t.id}" aria-label="Törlés">🗑</button>
      </li>`;
  }).join('');

  const prepDays = editing?.prep_days ?? 7;

  $('#day-content').innerHTML = `
    <div class="flex items-start justify-between mb-3">
      <div>
        <h2 id="day-title" class="font-bold text-lg">${formatHuDate(iso)}</h2>
        <div class="text-xs text-slate-500">${iso.slice(0, 4)}${relText}</div>
      </div>
      <button class="btn-ghost px-2 text-xl leading-none" data-act="close" aria-label="Bezárás">✕</button>
    </div>

    ${dayEvents.length ? `<div class="space-y-2 mb-4">${dayEvents.map((e) => {
      const ty = EVENT_TYPES[e.event_type] || EVENT_TYPES.nevnap;
      return `<div class="rounded-xl bg-pink-50 border border-pink-200 px-3 py-2 text-sm">${ty.icon} <b>${esc(e.name)}</b> ${ty.poss}${e.notes ? ` – <span class="text-slate-500">${esc(e.notes)}</span>` : ''}</div>`;
    }).join('')}</div>` : ''}

    ${preps.length ? `<div class="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-sm mb-4">
      <div class="font-semibold text-amber-800 mb-1">🛒 Előkészület a következő napokra</div>
      <ul class="space-y-1">${preps.map((p) => `<li><button class="text-left" data-day="${p.date}"><b>${esc(p.todo.title)}</b> – ${relativeDayLabel(p.daysLeft)} (${formatHuDate(p.date, false)})</button></li>`).join('')}</ul>
    </div>` : ''}

    <h3 class="font-semibold text-sm text-slate-500 uppercase tracking-wide">Teendők</h3>
    ${dayTodos.length ? `<ul class="divide-y divide-slate-100">${todoItems}</ul>` : '<p class="text-sm text-slate-400 py-2">Erre a napra nincs teendő.</p>'}

    <form id="todo-form" class="mt-4 space-y-3 border-t border-slate-100 pt-4">
      <h3 class="font-semibold">${editing ? 'Teendő szerkesztése' : 'Új teendő'}</h3>
      <input name="title" class="input" placeholder="pl. Gyümölcs az oviba" required maxlength="200" value="${esc(editing?.title)}" />
      <input name="notes" class="input" placeholder="Megjegyzés (opcionális)" maxlength="500" value="${esc(editing?.notes)}" />
      <label class="block">
        <span class="label">${editing?.recurrence === 'weekly' ? 'Sorozat kezdőnapja' : 'Dátum'}</span>
        <input name="due_date" type="date" class="input" required value="${editing?.due_date || iso}" />
      </label>

      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="font-medium text-sm">Vásárlást / előkészületet igényel</div>
          <div class="text-xs text-slate-500">Előre jelez, hogy legyen időd beszerezni</div>
        </div>
        <label class="switch"><input type="checkbox" name="needs_prep" ${editing?.needs_prep ? 'checked' : ''} /><span></span></label>
      </div>
      <div id="prep-days" class="flex items-center gap-2 text-sm" ${editing?.needs_prep ? '' : 'hidden'}>
        <span class="text-slate-500">Előrejelzés:</span>
        <div class="seg">
          ${[1, 3, 5, 7].map((n) => `<label><input type="radio" name="prep_days" value="${n}" ${prepDays === n ? 'checked' : ''} /><span>${n} nap</span></label>`).join('')}
        </div>
      </div>

      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="font-medium text-sm">Heti ismétlődés</div>
          <div class="text-xs text-slate-500" id="weekly-hint"></div>
        </div>
        <label class="switch"><input type="checkbox" name="weekly" ${editing?.recurrence === 'weekly' ? 'checked' : ''} /><span></span></label>
      </div>
      <label id="rec-end" class="block" ${editing?.recurrence === 'weekly' ? '' : 'hidden'}>
        <span class="label">Ismétlődés vége (opcionális)</span>
        <input name="recurrence_end" type="date" class="input" value="${editing?.recurrence_end || ''}" />
      </label>

      <div class="flex gap-2">
        <button type="submit" class="btn-primary flex-1">${editing ? 'Mentés' : 'Hozzáadás'}</button>
        ${editing ? '<button type="button" class="btn-soft" data-act="cancel-edit">Mégse</button>' : ''}
      </div>
    </form>
  `;

  const form = $('#todo-form');
  const updateHint = () => {
    const d = form.due_date.value;
    $('#weekly-hint').textContent = d ? `Minden ${['vasárnap', 'hétfőn', 'kedden', 'szerdán', 'csütörtökön', 'pénteken', 'szombaton'][parseISO(d).getDay()]}` : '';
  };
  updateHint();
  form.due_date.addEventListener('change', updateHint);
  form.needs_prep.addEventListener('change', () => { $('#prep-days').hidden = !form.needs_prep.checked; });
  form.weekly.addEventListener('change', () => { $('#rec-end').hidden = !form.weekly.checked; });
  form.addEventListener('submit', onTodoSubmit);
}

async function onTodoSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const weekly = f.weekly.checked;
  const row = {
    title: f.title.value.trim(),
    notes: f.notes.value.trim() || null,
    due_date: f.due_date.value,
    needs_prep: f.needs_prep.checked,
    prep_days: Number(f.querySelector('[name=prep_days]:checked')?.value || 7),
    recurrence: weekly ? 'weekly' : 'none',
    recurrence_end: weekly && f.recurrence_end.value ? f.recurrence_end.value : null,
  };
  if (!row.title) return;
  if (row.recurrence_end && row.recurrence_end < row.due_date) {
    toast('Az ismétlődés vége nem lehet a kezdőnap előtt.');
    return;
  }
  f.querySelector('[type=submit]').disabled = true;
  await guard(async () => {
    if (state.editingTodo) {
      const saved = await db.update('todos', state.editingTodo, row);
      state.todos = state.todos.map((t) => (t.id === saved.id ? saved : t));
    } else {
      const saved = await db.insert('todos', {
        ...row, done: false, done_dates: [], skip_dates: [], created_by: state.user?.id === 'local' ? null : state.user?.id,
      });
      state.todos.push(saved);
    }
    state.editingTodo = null;
    if (!weekly && row.due_date !== state.selected) state.selected = row.due_date;
  }, 'Mentve ✓');
  render();
}

async function toggleTodo(id) {
  const iso = state.selected;
  const t = state.todos.find((x) => x.id === id);
  if (!t) return;
  let patch;
  if (t.recurrence === 'weekly') {
    const set = new Set(t.done_dates || []);
    if (set.has(iso)) set.delete(iso); else set.add(iso);
    patch = { done_dates: [...set].sort() };
  } else {
    patch = { done: !t.done };
  }
  Object.assign(t, patch); // optimista frissítés
  render();
  await guard(async () => {
    const saved = await db.update('todos', id, patch);
    state.todos = state.todos.map((x) => (x.id === id ? saved : x));
  });
}

async function deleteTodo(id) {
  const t = state.todos.find((x) => x.id === id);
  if (!t) return;
  if (t.recurrence === 'weekly') {
    const choice = await choose(`„${t.title}” – ismétlődő teendő törlése`, [
      { label: 'Csak ez az alkalom', value: 'one' },
      { label: 'Ettől kezdve az összes', value: 'future' },
      { label: 'A teljes sorozat', value: 'all', cls: 'btn-danger' },
    ]);
    if (!choice) return;
    await guard(async () => {
      if (choice === 'all' || (choice === 'future' && state.selected <= t.due_date)) {
        await db.remove('todos', id);
        state.todos = state.todos.filter((x) => x.id !== id);
      } else {
        const patch = choice === 'one'
          ? { skip_dates: [...new Set([...(t.skip_dates || []), state.selected])].sort() }
          : { recurrence_end: addDays(state.selected, -1) };
        const saved = await db.update('todos', id, patch);
        state.todos = state.todos.map((x) => (x.id === id ? saved : x));
      }
    }, 'Törölve');
  } else {
    const ok = await choose(`Biztosan törlöd: „${t.title}”?`, [{ label: 'Törlés', value: true, cls: 'btn-danger' }]);
    if (!ok) return;
    await guard(async () => {
      await db.remove('todos', id);
      state.todos = state.todos.filter((x) => x.id !== id);
    }, 'Törölve');
  }
  render();
}

// ---------------------------------------------------------------------------
// Családi dátumok fül
// ---------------------------------------------------------------------------

function renderFamily() {
  const t = today();
  const list = upcomingEvents(state.events, t);
  const editing = state.events.find((e) => e.id === state.editingEvent) || null;
  const showForm = state.showEventForm || !!editing;
  const month = editing?.month || new Date().getMonth() + 1;
  const remind = editing?.remind_days ?? 3;

  $('#view-family').innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <h2 class="font-bold text-lg">Névnapok és fontos dátumok</h2>
      ${showForm ? '' : '<button class="btn-primary text-sm" data-act="new-event">+ Új</button>'}
    </div>

    ${showForm ? `
    <form id="event-form" class="card space-y-3 mb-4">
      <h3 class="font-semibold">${editing ? 'Szerkesztés' : 'Új családi dátum'}</h3>
      <label class="block"><span class="label">Név</span>
        <input name="name" class="input" required maxlength="100" placeholder="pl. Anya / Bence" value="${esc(editing?.name)}" />
      </label>
      <label class="block"><span class="label">Esemény típusa</span>
        <select name="event_type" class="input">
          ${Object.entries(EVENT_TYPES).map(([k, v]) => `<option value="${k}" ${editing?.event_type === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}
        </select>
      </label>
      <div class="grid grid-cols-2 gap-3">
        <label class="block"><span class="label">Hónap</span>
          <select name="month" class="input">
            ${HU_MONTHS.map((m, i) => `<option value="${i + 1}" ${month === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </label>
        <label class="block"><span class="label">Nap</span>
          <select name="day" class="input"></select>
        </label>
      </div>
      <label class="block"><span class="label">Figyelmeztetés</span>
        <select name="remind_days" class="input">
          ${[[0, 'Csak aznap'], [1, '1 nappal előre + aznap'], [3, '3 nappal előre + aznap'], [5, '5 nappal előre + aznap'], [7, '1 héttel előre + aznap'], [14, '2 héttel előre + aznap']]
            .map(([v, l]) => `<option value="${v}" ${remind === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <label class="block"><span class="label">Megjegyzés (opcionális)</span>
        <input name="notes" class="input" maxlength="300" placeholder="pl. kedvenc virága: tulipán" value="${esc(editing?.notes)}" />
      </label>
      <div class="flex gap-2">
        <button type="submit" class="btn-primary flex-1">Mentés</button>
        <button type="button" class="btn-soft" data-act="cancel-event">Mégse</button>
        ${editing ? `<button type="button" class="btn-danger" data-act="delete-event" data-id="${editing.id}">Törlés</button>` : ''}
      </div>
    </form>` : ''}

    ${list.length ? `<ul class="space-y-2">${list.map((u) => {
      const ty = EVENT_TYPES[u.event.event_type] || EVENT_TYPES.nevnap;
      const soon = u.daysLeft <= (u.event.remind_days ?? 3);
      return `<li><button class="card w-full text-left flex items-center gap-3 ${soon ? 'border-pink-300 bg-pink-50' : ''}" data-act="edit-event" data-id="${u.event.id}">
        <span class="text-2xl">${ty.icon}</span>
        <span class="flex-1">
          <span class="block font-semibold">${esc(u.event.name)}</span>
          <span class="block text-xs text-slate-500">${ty.label} · ${HU_MONTHS[u.event.month - 1]} ${u.event.day}.${u.event.notes ? ` · ${esc(u.event.notes)}` : ''}</span>
        </span>
        <span class="text-right text-xs ${u.daysLeft === 0 ? 'text-pink-600 font-bold' : 'text-slate-500'}">${u.daysLeft === 0 ? 'MA 🎉' : relativeDayLabel(u.daysLeft)}</span>
      </button></li>`;
    }).join('')}</ul>`
    : showForm ? '' : `<div class="card text-sm text-slate-500 text-center py-8">
        Még nincs rögzített dátum.<br/>Vedd fel egyszer a családtagok névnapjait és születésnapjait – minden évben automatikusan emlékeztetünk.
      </div>`}
  `;

  const form = $('#event-form');
  if (form) {
    const fillDays = () => {
      const m = Number(form.month.value);
      const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
      const cur = Number(form.day.value) || editing?.day || new Date().getDate();
      form.day.innerHTML = Array.from({ length: max }, (_, i) => i + 1)
        .map((d) => `<option value="${d}" ${d === Math.min(cur, max) ? 'selected' : ''}>${d}.</option>`).join('');
    };
    fillDays();
    form.month.addEventListener('change', fillDays);
    form.addEventListener('submit', onEventSubmit);
    if (!editing) form.name.focus();
  }
}

async function onEventSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const row = {
    name: f.name.value.trim(),
    event_type: f.event_type.value,
    month: Number(f.month.value),
    day: Number(f.day.value),
    remind_days: Number(f.remind_days.value),
    notes: f.notes.value.trim() || null,
  };
  if (!row.name) return;
  await guard(async () => {
    if (state.editingEvent) {
      const saved = await db.update('family_events', state.editingEvent, row);
      state.events = state.events.map((x) => (x.id === saved.id ? saved : x));
    } else {
      state.events.push(await db.insert('family_events', row));
    }
    state.editingEvent = null;
    state.showEventForm = false;
  }, 'Mentve ✓');
  render();
}

async function deleteEvent(id) {
  const ev = state.events.find((x) => x.id === id);
  const ok = await choose(`Törlöd: ${ev?.name}?`, [{ label: 'Törlés', value: true, cls: 'btn-danger' }]);
  if (!ok) return;
  await guard(async () => {
    await db.remove('family_events', id);
    state.events = state.events.filter((x) => x.id !== id);
    state.editingEvent = null;
    state.showEventForm = false;
  }, 'Törölve');
  render();
}

// ---------------------------------------------------------------------------
// Beállítások fül
// ---------------------------------------------------------------------------

async function renderSettings() {
  const el = $('#view-settings');
  const status = await push.pushStatus().catch((e) => ({ state: 'error', text: e.message }));
  if (state.tab !== 'settings') return;
  const ios = push.isIOS();

  el.innerHTML = `
    <h2 class="font-bold text-lg mb-3">Beállítások</h2>

    <div class="card mb-3">
      <h3 class="font-semibold mb-1">Fiók</h3>
      ${db.isCloud
        ? `<p class="text-sm text-slate-600">Bejelentkezve: <b>${esc(state.user?.email)}</b></p>
           <p class="text-xs text-slate-500 mt-1">Az adatok a Supabase-ben vannak, minden családtag eszközén szinkronban.</p>
           <button class="btn-soft mt-3 text-sm" data-act="logout">Kijelentkezés</button>`
        : `<p class="text-sm text-slate-600"><b>Helyi mód</b> – az adatok csak ezen az eszközön tárolódnak.</p>
           <p class="text-xs text-slate-500 mt-1">A családi szinkronhoz és a push értesítésekhez töltsd ki a <code>js/config.js</code> fájlt (lásd README).</p>`}
    </div>

    <div class="card mb-3">
      <h3 class="font-semibold mb-1">🔔 Értesítések</h3>
      <p class="text-sm text-slate-600">${esc(status.text)}</p>
      <p class="text-xs text-slate-500 mt-1">Minden reggel 7:00-kor összefoglalót kapsz a mai teendőkről, a közelgő vásárlásokról és a családi eseményekről.</p>
      <div class="flex flex-wrap gap-2 mt-3">
        ${status.state === 'off' || status.state === 'error' ? '<button class="btn-primary text-sm" data-act="push-on">Értesítések bekapcsolása</button>' : ''}
        ${status.state === 'on' ? '<button class="btn-soft text-sm" data-act="push-test">Teszt értesítés</button><button class="btn-ghost text-sm" data-act="push-off">Kikapcsolás</button>' : ''}
      </div>
    </div>

    ${ios && !push.isStandalone() ? `
    <div class="card mb-3 border-indigo-200 bg-indigo-50">
      <h3 class="font-semibold mb-2">📲 Telepítés iPhone-ra</h3>
      <ol class="list-decimal ml-5 text-sm space-y-1 text-slate-700">
        <li>Nyisd meg ezt az oldalt <b>Safariban</b>.</li>
        <li>Koppints a <b>Megosztás</b> gombra (négyzet felfelé nyíllal).</li>
        <li>Válaszd: <b>Főképernyőhöz adás</b>.</li>
        <li>Indítsd el az appot a Főképernyőről, jelentkezz be, majd itt kapcsold be az értesítéseket.</li>
      </ol>
      <p class="text-xs text-slate-500 mt-2">iOS 16.4 vagy újabb szükséges a push értesítésekhez.</p>
    </div>` : ''}

    <div class="card text-xs text-slate-500">
      <p>Családi Naptár · PWA · ${db.isCloud ? 'Supabase szinkron' : 'helyi mód'}</p>
      <button class="text-indigo-600 mt-2" data-act="reload">Adatok újratöltése</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Eseménykezelés (delegálás)
// ---------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('.tab-btn');
  if (tabBtn) return setTab(tabBtn.dataset.tab);

  const actEl = e.target.closest('[data-act]');
  const dayEl = e.target.closest('[data-day]');
  if (!actEl && dayEl) return openDay(dayEl.dataset.day);
  if (!actEl) {
    if (e.target.id === 'day-sheet') closeDay();
    return;
  }
  const { act, id } = actEl.dataset;

  switch (act) {
    case 'prev': state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); render(); break;
    case 'next': state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); render(); break;
    case 'today': { const d = new Date(); state.month = new Date(d.getFullYear(), d.getMonth(), 1); render(); break; }
    case 'close': closeDay(); break;
    case 'toggle': await toggleTodo(id); break;
    case 'delete': await deleteTodo(id); break;
    case 'edit': state.editingTodo = id; renderDay(); $('#todo-form').scrollIntoView({ behavior: 'smooth' }); break;
    case 'cancel-edit': state.editingTodo = null; renderDay(); break;
    case 'new-event': state.showEventForm = true; state.editingEvent = null; render(); break;
    case 'edit-event': state.editingEvent = id; state.showEventForm = true; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
    case 'cancel-event': state.editingEvent = null; state.showEventForm = false; render(); break;
    case 'delete-event': await deleteEvent(id); break;
    case 'logout': await db.signOut(); location.reload(); break;
    case 'reload': await loadData(); toast('Frissítve'); break;
    case 'push-on':
      actEl.disabled = true;
      await guard(() => push.enablePush(), 'Értesítések bekapcsolva 🔔');
      render();
      break;
    case 'push-off': await guard(() => push.disablePush(), 'Értesítések kikapcsolva'); render(); break;
    case 'push-test': await guard(() => push.testLocalNotification()); break;
    default: break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selected) closeDay();
});

// ---------------------------------------------------------------------------
// Bejelentkezés
// ---------------------------------------------------------------------------

function showLogin(show) {
  $('#login').hidden = !show;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#login-error').textContent = '';
  try {
    await db.signIn(f.email.value.trim(), f.password.value);
  } catch (err) {
    $('#login-error').textContent = err.message === 'Invalid login credentials'
      ? 'Hibás e-mail vagy jelszó.' : err.message;
  }
});

// ---------------------------------------------------------------------------
// Indítás
// ---------------------------------------------------------------------------

let unsubscribe = () => {};

async function start(user) {
  state.user = user;
  if (!user) {
    showLogin(true);
    unsubscribe();
    return;
  }
  // Engedélylista ellenőrzése: idegen fiókkal ne is induljon el az app.
  // (Offline esetén nem tudjuk ellenőrizni – ilyenkor a gyorsítótárból fut tovább.)
  if (navigator.onLine) {
    try {
      if (!(await db.isFamilyMember())) {
        await db.signOut();
        state.user = null;
        showLogin(true);
        $('#login-error').textContent = 'Ez a fiók nincs a családtagok listáján. Kérd meg az adminisztrátort, hogy vegyen fel.';
        return;
      }
    } catch (err) {
      console.warn('Tagság ellenőrzése sikertelen', err);
    }
  }
  showLogin(false);
  await loadData();
  unsubscribe();
  let t;
  unsubscribe = db.subscribeChanges(() => { clearTimeout(t); t = setTimeout(loadData, 300); });
}

// Értesítésből nyitva: ?day=YYYY-MM-DD
function handleDeepLink() {
  const p = new URLSearchParams(location.search);
  const day = p.get('day');
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const d = parseISO(day);
    state.month = new Date(d.getFullYear(), d.getMonth(), 1);
    openDay(day);
  }
  const tab = p.get('tab');
  if (tab && ['calendar', 'family', 'settings'].includes(tab)) setTab(tab);
}

push.registerSW();
setTab('calendar');
db.onAuthChange((user) => { if (user?.id !== state.user?.id) start(user); });
start(await db.getUser()).then(handleDeepLink);

window.addEventListener('online', loadData);
window.addEventListener('offline', () => setSync('offline'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) loadData();
});

// SW üzenet (értesítésre kattintás, ha az app már nyitva van)
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-day' && e.data.day) openDay(e.data.day);
});

// segédfüggvény exportja konzolos hibakereséshez
window.__csn = { state, occursOn };
