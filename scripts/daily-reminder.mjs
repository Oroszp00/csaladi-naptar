#!/usr/bin/env node
// Napi emlékeztető: lekérdezi a Supabase-t, összeállítja a reggeli összefoglalót,
// és kiküldi Web Push-ként (opcionálisan ntfy-ra és e-mailben is).
//
// Környezeti változók (GitHub Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY       – kötelező
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY           – kötelező a push-hoz
//   VAPID_SUBJECT   – pl. mailto:valaki@example.com (kötelező a push-hoz)
//   APP_URL         – pl. https://felhasznalo.github.io/csaladi-naptar/ (opcionális)
//   NTFY_TOPIC, NTFY_SERVER, NTFY_TOKEN           – opcionális
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_TO, EMAIL_FROM – opcionális
// Vezérlés:
//   SCHEDULE    – a workflow adja át (github.event.schedule), a téli/nyári idő kezeléséhez
//   FORCE_SEND  – 'true': időkaputól függetlenül fut, és üres napon is küld
//   DRY_RUN     – 'true': csak kiírja, nem küld semmit
//   TODAY       – teszteléshez felülírható dátum (YYYY-MM-DD)

import { writeFileSync } from 'node:fs';
import webpush from 'web-push';
import {
  buildDigest, digestIsEmpty, digestLines, todayInTZ, formatHuDate,
} from '../js/logic.js';

// A secretek elejéről/végéről levágjuk a láthatatlan karaktereket (BOM, szóköz, sortörés),
// amelyek pl. Windows-os vágólapról vagy PowerShellből kerülhetnek bele.
const env = Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/^[\s﻿]+|[\s﻿]+$/g, '') : v]),
);
const TZ = 'Europe/Budapest';
const FORCE = env.FORCE_SEND === 'true';
const DRY = env.DRY_RUN === 'true';

function log(...a) { console.log('[reminder]', ...a); }
function die(msg) { console.error(`[reminder] HIBA: ${msg}`); process.exit(1); }

// ---------------------------------------------------------------------------
// 1) Időkapu: a workflow reggel negyedóránként több időpontban is elindul
//    (a GitHub az ütemezett futásokat néha késlelteti vagy kihagyja).
//    Csak a budapesti 07:00–10:59 ablakban küldünk; hogy naponta csak egyszer,
//    azt a workflow egy napi „már elküldve” jelzővel (cache) biztosítja.
//    Ez téli (CET) és nyári (CEST) időszámításban is helyesen működik.
// ---------------------------------------------------------------------------
const WINDOW_START = Number(env.SEND_WINDOW_START || 7);
const WINDOW_END = Number(env.SEND_WINDOW_END || 11); // kizárólagos
const MARKER = env.SENT_MARKER_FILE || '';             // ide írjuk, ha a mai nap kész

function budapestHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(now));
}

if (!FORCE) {
  const h = budapestHour();
  if (h < WINDOW_START || h >= WINDOW_END) {
    log(`Budapesti idő ${h} óra – a küldési ablakon (${WINDOW_START}:00–${WINDOW_END}:00) kívül, kihagyva.`);
    process.exit(0);
  }
}

/** A mai nap feldolgozva (elküldve vagy nem volt mit küldeni) → a későbbi futások kihagyják. */
function markDone() {
  if (!MARKER || FORCE || DRY) return;
  writeFileSync(MARKER, `${new Date().toISOString()}\n`);
  log('A mai nap feldolgozva, a további reggeli futások kihagyják.');
}

// ---------------------------------------------------------------------------
// 2) Supabase REST lekérdezések (service role → RLS megkerülése)
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

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...sbHeaders(), ...init.headers } });
  if (!res.ok) throw new Error(`Supabase ${init.method || 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const today = env.TODAY || todayInTZ(TZ);
  log(`Dátum (Budapest): ${today}`);

  const [todos, events, subs, notes] = await Promise.all([
    sb('todos?select=*'),
    sb('family_events?select=*'),
    sb('push_subscriptions?select=id,endpoint,p256dh,auth'),
    // Napi jegyzet (ha a tábla még nem létezik, ne álljon le az értesítés)
    sb(`day_notes?select=day,note&day=eq.${today}`).catch((err) => { log(`day_notes kihagyva: ${err.message}`); return []; }),
  ]);
  log(`Betöltve: ${todos.length} teendő, ${events.length} családi dátum, ${notes.length} mai jegyzet, ${subs.length} push feliratkozás.`);

  // ---------------------------------------------------------------------------
  // 3) Összefoglaló összeállítása
  // ---------------------------------------------------------------------------
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
  const appUrl = env.APP_URL || './';
  const url = `${appUrl}${appUrl.includes('?') ? '&' : '?'}day=${today}`;

  log(`\n${title}\n${body}\n`);
  if (DRY) { log('DRY_RUN – nem küldünk.'); return; }

  const results = { push: 0, pushFailed: 0, removed: 0, ntfy: false, email: false };

  // ---------------------------------------------------------------------------
  // 4) Web Push
  // ---------------------------------------------------------------------------
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && subs.length) {
    webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    // A push payload max. ~4 KB – biztonság kedvéért vágjuk.
    const payload = JSON.stringify({ title, body: body.slice(0, 1800), url, day: today, tag: `napi-${today}` });

    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 60 * 60 * 12, urgency: 'normal' },
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
  } else {
    log('Web Push kihagyva (nincs VAPID kulcs vagy nincs feliratkozott eszköz).');
  }

  // ---------------------------------------------------------------------------
  // 5) ntfy.sh (opcionális)
  // ---------------------------------------------------------------------------
  if (env.NTFY_TOPIC) {
    try {
      const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
      const res = await fetch(server, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN}` } : {}),
        },
        // JSON publikálás: így az ékezetes cím is gond nélkül megy
        body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message: body, tags: ['calendar'], click: env.APP_URL || undefined }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      results.ntfy = true;
    } catch (err) {
      console.error('[reminder] ntfy hiba:', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // 6) E-mail (opcionális, SMTP – pl. Gmail alkalmazásjelszóval)
  // ---------------------------------------------------------------------------
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

  // Hibával lépjünk ki, ha volt csatorna, de egyik sem sikerült – így a GitHub Actions jelez.
  const anyChannel = subs.length || env.NTFY_TOPIC || env.SMTP_HOST;
  if (anyChannel && !results.push && !results.ntfy && !results.email && results.pushFailed !== results.removed) {
    // Nem jelöljük késznek → a következő reggeli futás újrapróbálja.
    console.error('[reminder] HIBA: Egyetlen értesítést sem sikerült kiküldeni.');
    process.exitCode = 1;
  } else {
    markDone();
  }
}

await main();
