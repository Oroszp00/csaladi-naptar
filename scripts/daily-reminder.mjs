#!/usr/bin/env node
// Családi Naptár – értesítő script (GitHub Actions futtatja).
//
// Módok (MODE):
//   morning – reggeli összefoglaló (alapértelmezés). A Supabase pg_cron indítja 07:00-kor,
//             tartalékként a GitHub ütemezője is.
//   change  – valaki új teendőt / családi dátumot / napi jegyzetet vett fel → a TÖBBI
//             családtag kap értesítést. A Supabase adatbázis-trigger indítja.
//   start   – időpontos teendő kezdődik → mindenki kap értesítést. A pg_cron percenként
//             ellenőrzi, és ~2 perccel a kezdés előtt indítja (a futás ~1–2 perc).
//
// Környezeti változók (GitHub Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY       – kötelező
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY           – kötelező a push-hoz
//   VAPID_SUBJECT   – kapcsolattartási cím a push szolgáltatóknak (mailto: vagy https:)
//   APP_URL         – pl. https://felhasznalo.github.io/csaladi-naptar/ (opcionális)
//   NTFY_TOPIC, NTFY_SERVER, NTFY_TOKEN           – opcionális (csak a reggeli összefoglaló)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_TO, EMAIL_FROM – opcionális (csak reggel)
// Vezérlés:
//   MODE        – morning | change | start
//   PAYLOAD     – JSON a change/start módhoz (a Supabase küldi)
//   FORCE_SEND  – 'true': időablaktól függetlenül fut, és üres napon is küld (reggeli mód)
//   DRY_RUN     – 'true': csak kiírja, nem küld semmit
//   TODAY       – teszteléshez felülírható dátum (YYYY-MM-DD)

import { writeFileSync } from 'node:fs';
import webpush from 'web-push';
import {
  buildDigest, digestIsEmpty, digestLines, todayInTZ, formatHuDate, formatTime, EVENT_TYPES,
} from '../js/logic.js';

// A secretek elejéről/végéről levágjuk a láthatatlan karaktereket (BOM, szóköz, sortörés),
// amelyek pl. Windows-os vágólapról vagy PowerShellből kerülhetnek bele.
const env = Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/^[\s﻿]+|[\s﻿]+$/g, '') : v]),
);
const TZ = 'Europe/Budapest';
const MODE = env.MODE || 'morning';
const FORCE = env.FORCE_SEND === 'true';
const DRY = env.DRY_RUN === 'true';

function log(...a) { console.log(`[reminder:${MODE}]`, ...a); }
function die(msg) { console.error(`[reminder] HIBA: ${msg}`); process.exit(1); }

// ---------------------------------------------------------------------------
// Supabase REST (service role → RLS megkerülése)
// ---------------------------------------------------------------------------
const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !SERVICE_KEY) die('Hiányzik a SUPABASE_URL vagy a SUPABASE_SERVICE_ROLE_KEY.');

function sbHeaders() {
  const h = { apikey: SERVICE_KEY, 'Content-Type': 'application/json' };
  // A régi (JWT) service_role kulcs Authorization fejlécben is kell; az új sb_secret_ kulcs nem JWT.
  if (!SERVICE_KEY.startsWith('sb_')) h.Authorization = `Bearer ${SERVICE_KEY}`;
  return h;
}

async function sbFetch(base, path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/${base}/${path}`, { ...init, headers: { ...sbHeaders(), ...init.headers } });
  if (!res.ok) throw new Error(`Supabase ${init.method || 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
const sb = (path, init) => sbFetch('rest/v1', path, init);

const appUrl = env.APP_URL || './';
const appLink = (day) => (day ? `${appUrl}${appUrl.includes('?') ? '&' : '?'}day=${day}` : appUrl);

// ---------------------------------------------------------------------------
// Web Push küldés (közös minden módhoz)
// ---------------------------------------------------------------------------
async function sendPush(subs, message) {
  const results = { push: 0, pushFailed: 0, removed: 0 };
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    log('Web Push kihagyva (nincs VAPID kulcs).');
    return results;
  }
  if (!subs.length) {
    log('Web Push kihagyva (nincs címzett eszköz).');
    return results;
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  // A push payload max. ~4 KB – biztonság kedvéért vágjuk.
  const payload = JSON.stringify({ ...message, body: String(message.body || '').slice(0, 1800) });

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: message.ttl ?? 60 * 60 * 12, urgency: message.urgency || 'normal' },
      );
      results.push++;
    } catch (err) {
      results.pushFailed++;
      // 404/410: a feliratkozás megszűnt (app törölve, engedély visszavonva) → takarítás
      if (err.statusCode === 404 || err.statusCode === 410) {
        await sb(`push_subscriptions?id=eq.${s.id}`, { method: 'DELETE' }).catch(() => {});
        results.removed++;
        log(`Lejárt feliratkozás törölve: ${s.endpoint.slice(0, 60)}…`);
      } else {
        console.error(`[reminder] Push hiba (${err.statusCode}): ${err.body || err.message}`);
      }
    }
  }));
  return results;
}

const allFailed = (r) => r.push === 0 && r.pushFailed > 0 && r.pushFailed !== r.removed;

function parsePayload() {
  try {
    return JSON.parse(env.PAYLOAD || '{}');
  } catch {
    die(`Hibás PAYLOAD: ${env.PAYLOAD}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// 1) Reggeli összefoglaló
// ---------------------------------------------------------------------------
// Időablak: a budapesti 07:00–10:59 között küldünk; a napi „már elküldve” jelzőt
// (SENT_MARKER_FILE → Actions cache) a workflow kezeli, így naponta egyszer megy ki.
const WINDOW_START = Number(env.SEND_WINDOW_START || 7);
const WINDOW_END = Number(env.SEND_WINDOW_END || 11); // kizárólagos
const MARKER = env.SENT_MARKER_FILE || '';

function budapestHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(now));
}

function markDone() {
  if (!MARKER || FORCE || DRY) return;
  writeFileSync(MARKER, `${new Date().toISOString()}\n`);
  log('A mai nap feldolgozva, a további reggeli futások kihagyják.');
}

async function runMorning() {
  if (!FORCE) {
    const h = budapestHour();
    if (h < WINDOW_START || h >= WINDOW_END) {
      log(`Budapesti idő ${h} óra – a küldési ablakon (${WINDOW_START}:00–${WINDOW_END}:00) kívül, kihagyva.`);
      return;
    }
  }

  const today = env.TODAY || todayInTZ(TZ);
  log(`Dátum (Budapest): ${today}`);

  const [todos, events, subs, notes] = await Promise.all([
    sb('todos?select=*'),
    sb('family_events?select=*'),
    sb('push_subscriptions?select=id,endpoint,p256dh,auth,user_id'),
    sb(`day_notes?select=day,note&day=eq.${today}`).catch((err) => { log(`day_notes kihagyva: ${err.message}`); return []; }),
  ]);
  log(`Betöltve: ${todos.length} teendő, ${events.length} családi dátum, ${notes.length} mai jegyzet, ${subs.length} push feliratkozás.`);

  const digest = buildDigest(todos, events, today, notes);
  const lines = digestLines(digest);

  if (digestIsEmpty(digest) && !FORCE) {
    log('Ma nincs mit jelezni – nem küldünk értesítést.');
    markDone();
    return;
  }

  const title = digest.events.some((e) => e.daysLeft === 0)
    ? '🎉 Ma ünneplünk!'
    : `☀️ Jó reggelt! – ${formatHuDate(today)}`;
  const body = lines.length ? lines.join('\n') : 'Mára nincs teendő. Szép napot! 🌿';
  const url = appLink(today);

  log(`\n${title}\n${body}\n`);
  if (DRY) { log('DRY_RUN – nem küldünk.'); return; }

  const results = {
    ...(await sendPush(subs, { title, body, url, day: today, tag: `napi-${today}` })),
    ntfy: false,
    email: false,
  };

  // ntfy.sh (opcionális)
  if (env.NTFY_TOPIC) {
    try {
      const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
      const res = await fetch(server, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN}` } : {}),
        },
        body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message: body, tags: ['calendar'], click: env.APP_URL || undefined }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      results.ntfy = true;
    } catch (err) {
      console.error('[reminder] ntfy hiba:', err.message);
    }
  }

  // E-mail (opcionális, SMTP – pl. Gmail alkalmazásjelszóval)
  if (env.SMTP_HOST && env.EMAIL_TO) {
    try {
      const { default: nodemailer } = await import('nodemailer');
      const port = Number(env.SMTP_PORT || 465);
      const transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      });
      const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      await transport.sendMail({
        from: env.EMAIL_FROM || env.SMTP_USER,
        to: env.EMAIL_TO,
        subject: title,
        text: `${body}\n\n${env.APP_URL || ''}`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6">
          <h2 style="margin:0 0 12px">${esc(title)}</h2>
          <ul style="padding-left:18px">${lines.map((l) => `<li>${esc(l)}</li>`).join('') || '<li>Mára nincs teendő.</li>'}</ul>
          ${env.APP_URL ? `<p><a href="${esc(url)}">Megnyitás a Családi Naptárban →</a></p>` : ''}
        </div>`,
      });
      results.email = true;
    } catch (err) {
      console.error('[reminder] E-mail hiba:', err.message);
    }
  }

  log('Eredmény:', JSON.stringify(results));

  const anyChannel = subs.length || env.NTFY_TOPIC || env.SMTP_HOST;
  if (anyChannel && !results.push && !results.ntfy && !results.email && results.pushFailed !== results.removed) {
    // Nem jelöljük késznek → a következő reggeli futás újrapróbálja.
    console.error('[reminder] HIBA: Egyetlen értesítést sem sikerült kiküldeni.');
    process.exitCode = 1;
  } else {
    markDone();
  }
}

// ---------------------------------------------------------------------------
// 2) Új bejegyzés → a többi családtag értesítése
// ---------------------------------------------------------------------------

/** A felhasználó megjelenítendő neve: family_members.name, különben az e-mail cím eleje. */
async function actorName(userId) {
  if (!userId) return 'Valaki';
  try {
    const user = await sbFetch('auth/v1', `admin/users/${userId}`);
    const email = (user?.email || '').toLowerCase();
    if (!email) return 'Valaki';
    const [member] = await sb(`family_members?select=name&email=eq.${encodeURIComponent(email)}`).catch(() => []);
    return member?.name || email.split('@')[0];
  } catch (err) {
    log(`Név lekérdezése sikertelen: ${err.message}`);
    return 'Valaki';
  }
}

const dateWithTime = (iso, time) => `${formatHuDate(iso)}${formatTime(time) ? `, ${formatTime(time)}` : ''}`;

async function runChange() {
  const p = parsePayload(); // { table, op, key, actor }
  log('Payload:', JSON.stringify(p));
  if (!p.table || !p.key) die('Hiányzó table/key a PAYLOAD-ban.');

  let message = null;
  if (p.table === 'todos') {
    const [t] = await sb(`todos?select=*&id=eq.${encodeURIComponent(p.key)}`);
    if (!t) { log('A teendő már nem létezik – nincs értesítés.'); return; }
    const who = await actorName(p.actor);
    const extras = [
      t.recurrence === 'weekly' ? '🔁 hetente' : '',
      t.needs_prep ? `🛒 ${t.prep_days} nappal előre jelez` : '',
    ].filter(Boolean).join(' · ');
    message = {
      title: `➕ ${who} új teendőt vett fel`,
      body: [`${t.title}`, `📅 ${dateWithTime(t.due_date, t.due_time)}`, t.notes ? `💬 ${t.notes}` : '', extras]
        .filter(Boolean).join('\n'),
      url: appLink(t.due_date),
      day: t.due_date,
      tag: `uj-teendo-${t.id}`,
    };
  } else if (p.table === 'family_events') {
    const [e] = await sb(`family_events?select=*&id=eq.${encodeURIComponent(p.key)}`);
    if (!e) { log('Az esemény már nem létezik – nincs értesítés.'); return; }
    const who = await actorName(p.actor);
    const ty = EVENT_TYPES[e.event_type] || EVENT_TYPES.nevnap;
    message = {
      title: `${ty.icon} ${who} új családi dátumot vett fel`,
      body: [`${e.name} ${ty.poss}`, `📅 minden évben: ${formatHuDate(`2000-${String(e.month).padStart(2, '0')}-${String(e.day).padStart(2, '0')}`, false)}`, e.notes ? `💬 ${e.notes}` : '']
        .filter(Boolean).join('\n'),
      url: `${appUrl}${appUrl.includes('?') ? '&' : '?'}tab=family`,
      tag: `uj-esemeny-${e.id}`,
    };
  } else if (p.table === 'day_notes') {
    const [n] = await sb(`day_notes?select=day,note&day=eq.${encodeURIComponent(p.key)}`);
    if (!n) { log('A jegyzet már nem létezik – nincs értesítés.'); return; }
    const who = await actorName(p.actor);
    message = {
      title: `📝 ${who} ${p.op === 'UPDATE' ? 'módosította a jegyzetet' : 'jegyzetet írt'}`,
      body: `${formatHuDate(n.day)}:\n${n.note}`,
      url: appLink(n.day),
      day: n.day,
      tag: `jegyzet-${n.day}`,
    };
  } else {
    die(`Ismeretlen tábla: ${p.table}`);
  }

  // Aki felvette, az nem kap értesítést a saját bejegyzéséről.
  const subs = await sb('push_subscriptions?select=id,endpoint,p256dh,auth,user_id');
  const recipients = subs.filter((s) => !p.actor || s.user_id !== p.actor);
  log(`\n${message.title}\n${message.body}\n→ ${recipients.length} eszköz (${subs.length - recipients.length} kihagyva: a szerző saját eszköze)`);
  if (DRY) { log('DRY_RUN – nem küldünk.'); return; }

  const r = await sendPush(recipients, { ...message, ttl: 60 * 60 * 24 });
  log('Eredmény:', JSON.stringify(r));
  if (allFailed(r)) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 3) Időpontos teendő kezdődik
// ---------------------------------------------------------------------------
async function runStart() {
  const p = parsePayload(); // { ids: [...], date: 'YYYY-MM-DD' }
  log('Payload:', JSON.stringify(p));
  const ids = Array.isArray(p.ids) ? p.ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)) : [];
  if (!ids.length) { log('Nincs kezdődő teendő.'); return; }

  const todos = await sb(`todos?select=*&id=in.(${ids.join(',')})`);
  const date = p.date || todayInTZ(TZ);
  // Biztonsági ellenőrzés: azóta nem pipálták-e ki / nem törölték-e az alkalmat.
  const active = todos.filter((t) => (t.recurrence === 'weekly'
    ? !(t.done_dates || []).includes(date) && !(t.skip_dates || []).includes(date)
    : !t.done));
  if (!active.length) { log('A kezdődő teendők közben elkészültek vagy törlődtek – nincs értesítés.'); return; }

  active.sort((a, b) => String(a.due_time).localeCompare(String(b.due_time)));
  const time = formatTime(active[0].due_time);
  const title = active.length === 1
    ? `⏰ Most kezdődik: ${active[0].title}`
    : `⏰ ${time}-kor kezdődik (${active.length} teendő)`;
  const body = active
    .map((t) => `${formatTime(t.due_time)} ${t.title}${t.notes ? `\n💬 ${t.notes}` : ''}`)
    .join('\n');

  const subs = await sb('push_subscriptions?select=id,endpoint,p256dh,auth,user_id');
  log(`\n${title}\n${body}\n→ ${subs.length} eszköz`);
  if (DRY) { log('DRY_RUN – nem küldünk.'); return; }

  // Rövid élettartam: ha egy telefon órákig offline, ne kapja meg késve a „most kezdődik” üzenetet.
  const r = await sendPush(subs, {
    title, body, url: appLink(date), day: date, tag: `kezdes-${date}-${time}`, ttl: 60 * 30, urgency: 'high',
  });
  log('Eredmény:', JSON.stringify(r));
  if (allFailed(r)) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
const runners = { morning: runMorning, change: runChange, start: runStart };
if (!runners[MODE]) die(`Ismeretlen MODE: ${MODE}`);
await runners[MODE]();
