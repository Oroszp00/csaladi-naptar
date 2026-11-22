// Service Worker regisztráció és Web Push feliratkozás.
import { CONFIG } from './config.js';
import { isCloud, savePushSubscription, deletePushSubscription } from './db.js';

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.warn('SW regisztráció sikertelen', err);
    return null;
  }
}

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Állapot a Beállítások fülhöz. */
export async function pushStatus() {
  if (!isCloud) return { state: 'local', text: 'Helyi módban a push nem érhető el (állítsd be a Supabase-t).' };
  if (!CONFIG.VAPID_PUBLIC_KEY) return { state: 'novapid', text: 'Hiányzik a VAPID_PUBLIC_KEY a js/config.js-ből.' };
  if (!pushSupported()) {
    if (isIOS() && !isStandalone()) {
      return { state: 'ios-install', text: 'iPhone-on előbb mentsd a Főképernyőre (Megosztás → Főképernyőhöz adás), majd onnan nyisd meg.' };
    }
    return { state: 'unsupported', text: 'Ez a böngésző nem támogatja a push értesítéseket.' };
  }
  if (Notification.permission === 'denied') {
    return { state: 'denied', text: 'Az értesítések le vannak tiltva. Engedélyezd a rendszerbeállításokban.' };
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub
    ? { state: 'on', text: 'Az értesítések be vannak kapcsolva ezen az eszközön.' }
    : { state: 'off', text: 'Az értesítések ki vannak kapcsolva ezen az eszközön.' };
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** Felhasználói gesztusból (gombnyomás) kell hívni – iOS-en ez kötelező. */
export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Az értesítési engedély nem lett megadva.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY),
    });
  }
  await savePushSubscription(sub);
  return sub;
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try { await deletePushSubscription(sub.endpoint); } catch (e) { console.warn(e); }
  await sub.unsubscribe();
}

/** Helyi teszt értesítés (szerver nélkül), hogy lásd, megjelenik-e. */
export async function testLocalNotification() {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('Családi Naptár – teszt', {
    body: 'Ha ezt látod, az értesítések működnek ezen az eszközön. 🎉',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'teszt',
  });
}
