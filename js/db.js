// Adatréteg: Supabase (szinkron) vagy localStorage (helyi mód).
import { CONFIG } from './config.js';

export const isCloud = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

let supabase = null;
if (isCloud) {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}
export { supabase };

const TABLES = ['todos', 'family_events'];
const CACHE_PREFIX = 'csn_cache_';
const LOCAL_PREFIX = 'csn_local_';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function getUser() {
  if (!isCloud) return { id: 'local', email: 'helyi mód' };
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

export function onAuthChange(cb) {
  if (isCloud) supabase.auth.onAuthStateChange((_e, session) => cb(session?.user ?? null));
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/** Szerepel-e a bejelentkezett felhasználó a family_members engedélylistán. */
export async function isFamilyMember() {
  if (!isCloud) return true;
  const { data, error } = await supabase.rpc('is_family_member');
  if (error) throw error;
  return data === true;
}

export async function signOut() {
  await supabase.auth.signOut();
  TABLES.forEach((t) => localStorage.removeItem(CACHE_PREFIX + t));
}

// ---------------------------------------------------------------------------
// Helyi tároló segédfüggvények
// ---------------------------------------------------------------------------

function readLS(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function writeLS(key, rows) {
  try { localStorage.setItem(key, JSON.stringify(rows)); } catch { /* tele / tiltott */ }
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Lista lekérése. Offline esetén az utolsó sikeres lekérés gyorsítótárát adja vissza. */
export async function list(table) {
  if (!isCloud) return readLS(LOCAL_PREFIX + table);
  try {
    const { data, error } = await supabase.from(table).select('*').order('created_at');
    if (error) throw error;
    writeLS(CACHE_PREFIX + table, data);
    return data;
  } catch (err) {
    console.warn(`[db] ${table} offline cache`, err);
    const cached = readLS(CACHE_PREFIX + table);
    if (cached.length) return cached;
    throw err;
  }
}

export async function insert(table, row) {
  if (!isCloud) {
    const rows = readLS(LOCAL_PREFIX + table);
    const rec = { id: uuid(), created_at: new Date().toISOString(), ...row };
    rows.push(rec);
    writeLS(LOCAL_PREFIX + table, rows);
    return rec;
  }
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function update(table, id, patch) {
  if (!isCloud) {
    const rows = readLS(LOCAL_PREFIX + table);
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) rows[i] = { ...rows[i], ...patch };
    writeLS(LOCAL_PREFIX + table, rows);
    return rows[i];
  }
  const { data, error } = await supabase.from(table).update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function remove(table, id) {
  if (!isCloud) {
    writeLS(LOCAL_PREFIX + table, readLS(LOCAL_PREFIX + table).filter((r) => r.id !== id));
    return;
  }
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) throw error;
}

/** Valós idejű szinkron: ha egy másik családtag módosít, frissül a nézet. */
export function subscribeChanges(onChange) {
  if (!isCloud) return () => {};
  const ch = supabase
    .channel('csaladi-naptar')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'family_events' }, onChange)
    .subscribe();
  return () => supabase.removeChannel(ch);
}

// ---------------------------------------------------------------------------
// Push feliratkozások
// ---------------------------------------------------------------------------

export async function savePushSubscription(sub) {
  const json = sub.toJSON();
  const user = await getUser();
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_id: user?.id,
      user_agent: navigator.userAgent.slice(0, 250),
    },
    { onConflict: 'endpoint' },
  );
  if (error) throw error;
}

export async function deletePushSubscription(endpoint) {
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) throw error;
}
