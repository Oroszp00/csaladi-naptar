# 📅 Családi Naptár

Magyar nyelvű, mobilra optimalizált **PWA** a család közös teendőihez, a bevásárlást igénylő előkészületekhez (pl. „gyümölcs az oviba”) és a névnapokhoz, születésnapokhoz, évfordulókhoz.

- **Frontend:** tiszta HTML + modularizált ES modules JS + Tailwind CDN – nincs build lépés, közvetlenül megy GitHub Pages-re
- **Adatok:** Supabase (ingyenes tier), valós idejű szinkron a családtagok között
- **Értesítések:** Web Push (iPhone-on is, Főképernyőre mentve), minden reggel 7:00-kor GitHub Actions-ből; opcionálisan ntfy és e-mail

---

## Funkciók

| | |
|---|---|
| 🗓️ **Havi naptár** | Hétfővel kezdődő hónapnézet, pöttyökkel: 🔵 teendő, 🟠 vásárlós teendő, ⭕ előkészület kezdőnapja, 🩷 családi esemény |
| ✅ **Nap nézet** | Egy napra koppintva: új teendő, pipálás, szerkesztés, törlés |
| 🛒 **Vásárlást / előkészületet igényel** | Kapcsoló; 1 / 3 / 5 / **7** (alapértelmezett) nappal előre jelez – a naptárban, a napi összefoglalóban és push-ban is |
| 🔁 **Heti ismétlődés** | Opcionális záró dátummal; alkalmanként pipálható; törléskor: „csak ez”, „ettől kezdve”, „teljes sorozat” |
| 🎂 **Családi dátumok** | Névnap / Születésnap / Évforduló hónap + nap formában, évente ismétlődik; figyelmeztetés alapból **3 nappal előre + aznap** (0–14 nap állítható); feb. 29. nem szökőévben feb. 28-án jelez |
| ☀️ **Mai összefoglaló + következő 14 nap** | A naptár alatt |
| 🔔 **Reggeli push** | 7:00 (CET/CEST), csak akkor, ha van mit jelezni |
| 📴 **Offline** | Service Worker gyorsítótár + utolsó szinkronizált adatok |
| 🧪 **Helyi mód** | Ha a `js/config.js` üres, az app Supabase nélkül, csak az eszközön (localStorage) működik – kipróbáláshoz ideális |

## Projektstruktúra

```
├── index.html                 # App váz (Tailwind CDN)
├── manifest.json              # PWA manifest
├── sw.js                      # Service Worker: offline cache + push + értesítésre kattintás
├── css/app.css                # Kiegészítő stílusok (naptár, kapcsolók, alsó lap)
├── js/
│   ├── config.js              # ⚙️ Supabase URL, anon kulcs, VAPID publikus kulcs
│   ├── app.js                 # UI: naptár, nap nézet, családi dátumok, beállítások
│   ├── db.js                  # Adatréteg (Supabase vagy localStorage) + auth + realtime
│   ├── push.js                # SW regisztráció, push feliratkozás
│   └── logic.js               # Közös dátumlogika (böngésző + Node script is használja)
├── icons/                     # PNG + SVG ikonok (scripts/generate-icons.mjs generálja)
├── scripts/
│   ├── daily-reminder.mjs     # Napi értesítő (GitHub Actions futtatja)
│   └── generate-icons.mjs     # Ikon generátor (függőség nélkül)
├── supabase/schema.sql        # Teljes adatbázis séma + RLS
├── tests/logic.test.mjs       # Unit tesztek (npm test)
└── .github/workflows/daily-reminder.yml
```

---

## Telepítés lépésről lépésre

### 1. Repó létrehozása

1. Hozz létre egy új GitHub repót (pl. `csaladi-naptar`). Lehet privát is, de **GitHub Pages privát repóból csak fizetős csomaggal** megy – ingyenes fióknál legyen nyilvános. (A repóba csak nyilvános kulcsok kerülnek, a titkos kulcsok GitHub Secretsben vannak.)
2. Töltsd fel a fájlokat:
   ```bash
   git init
   git add .
   git commit -m "Családi Naptár"
   git branch -M main
   git remote add origin https://github.com/<felhasznalonev>/csaladi-naptar.git
   git push -u origin main
   ```

### 2. Supabase projekt

1. Regisztrálj: <https://supabase.com> → **New project**.
   - Region: **Central EU (Frankfurt)** – ez van a legközelebb.
   - Adj meg egy erős adatbázis jelszót (el is mentheted, de az apphoz nem kell).
2. Várd meg, amíg a projekt elkészül (~1-2 perc).

### 3. Táblák létrehozása (SQL)

Supabase Dashboard → **SQL Editor** → **New query** → másold be a [`supabase/schema.sql`](supabase/schema.sql) teljes tartalmát → **Run**.

<details>
<summary>📄 A teljes SQL (kattints a kinyitáshoz)</summary>

```sql
-- =============================================================================
-- Családi Naptár – Supabase séma
-- Futtasd le egyben: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

-- Közös trigger: updated_at frissítése
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- 1) Teendők
-- -----------------------------------------------------------------------------
create table if not exists public.todos (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (char_length(title) between 1 and 200),
  notes          text check (char_length(notes) <= 500),
  due_date       date not null,                         -- egyszeri: a nap; heti: a sorozat első napja
  done           boolean not null default false,        -- egyszeri teendő pipája
  needs_prep     boolean not null default false,        -- „Vásárlást / előkészületet igényel”
  prep_days      smallint not null default 7 check (prep_days between 1 and 30),
  recurrence     text not null default 'none' check (recurrence in ('none', 'weekly')),
  recurrence_end date,                                  -- heti sorozat utolsó napja (opcionális)
  done_dates     date[] not null default '{}',          -- heti sorozat kipipált alkalmai
  skip_dates     date[] not null default '{}',          -- heti sorozat törölt alkalmai
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- Opcionális időpont (v1.5): régebbi telepítésnél is hozzáadja az oszlopot
alter table public.todos add column if not exists due_time time;
create index if not exists todos_due_date_idx on public.todos (due_date);
drop trigger if exists todos_updated_at on public.todos;
create trigger todos_updated_at before update on public.todos
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2) Családi névnapok, születésnapok, évfordulók (évszám nélkül)
-- -----------------------------------------------------------------------------
create table if not exists public.family_events (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 100),
  event_type   text not null default 'nevnap' check (event_type in ('nevnap', 'szuletesnap', 'evfordulo')),
  month        smallint not null check (month between 1 and 12),
  day          smallint not null check (day between 1 and 31),
  remind_days  smallint not null default 3 check (remind_days between 0 and 60),
  notes        text check (char_length(notes) <= 300),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
drop trigger if exists family_events_updated_at on public.family_events;
create trigger family_events_updated_at before update on public.family_events
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3) Web Push feliratkozások (eszközönként egy sor)
-- -----------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  user_agent  text,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 4) Családtagok engedélylistája
-- Csak az itt felsorolt e-mail címmel bejelentkezett felhasználók férnek hozzá
-- az adatokhoz – akkor is, ha valaki valahogy fiókot tudna létrehozni.
-- A listát csak a Supabase Dashboardról (SQL Editor / Table Editor) lehet módosítani,
-- az appból nem.
-- -----------------------------------------------------------------------------
create table if not exists public.family_members (
  email      text primary key check (email = lower(email)),
  name       text,
  created_at timestamptz not null default now()
);

-- Igaz, ha a bejelentkezett felhasználó e-mail címe szerepel a listán.
-- security definer: a family_members táblát a felhasználó közvetlenül nem olvashatja.
create or replace function public.is_family_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.family_members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_family_member() from public, anon;
grant execute on function public.is_family_member() to authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- Kettős védelem:
--   1. Kapcsold KI a regisztrációt (Authentication → Sign In / Providers →
--      „Allow new users to sign up”).
--   2. Az adatokhoz csak a family_members listán szereplők férnek hozzá.
-- -----------------------------------------------------------------------------
alter table public.todos              enable row level security;
alter table public.family_events      enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.family_members     enable row level security;  -- nincs policy → appból elérhetetlen

drop policy if exists "family_all_todos" on public.todos;
create policy "family_all_todos" on public.todos
  for all to authenticated
  using ((select public.is_family_member()))
  with check ((select public.is_family_member()));

drop policy if exists "family_all_events" on public.family_events;
create policy "family_all_events" on public.family_events
  for all to authenticated
  using ((select public.is_family_member()))
  with check ((select public.is_family_member()));

-- Push feliratkozást mindenki csak a sajátját látja/kezeli.
-- (A napi GitHub Actions script service role kulccsal fut, az megkerüli az RLS-t.)
drop policy if exists "own_push_subs" on public.push_subscriptions;
create policy "own_push_subs" on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid() and (select public.is_family_member()))
  with check (user_id = auth.uid() and (select public.is_family_member()));

-- Explicit jogosultságok (a „Grant API access to new tables automatically” kikapcsolva is működjön).
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.todos, public.family_events, public.push_subscriptions to authenticated;
-- A napi értesítő script (GitHub Actions) service_role kulccsal olvas és takarít:
grant select, insert, update, delete on public.todos, public.family_events, public.push_subscriptions, public.family_members to service_role;
revoke all on public.todos, public.family_events, public.push_subscriptions, public.family_members from anon;
revoke all on public.family_members from authenticated;

-- -----------------------------------------------------------------------------
-- ✏️ Családtagok felvétele – írd át a saját e-mail címeitekre, és futtasd le!
-- (Kisbetűvel. Később is futtatható újra, ha valakit fel kell venni.)
-- -----------------------------------------------------------------------------
-- insert into public.family_members (email, name) values
--   ('elso.csaladtag@example.com',   'Apa'),
--   ('masodik.csaladtag@example.com', 'Anya')
-- on conflict (email) do nothing;

-- -----------------------------------------------------------------------------
-- Valós idejű szinkron (ha egy családtag módosít, a többiek appja azonnal frissül)
-- -----------------------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.todos;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.family_events;
  exception when duplicate_object then null;
  end;
end $$;
```
</details>

**Táblák röviden:**

| Tábla | Mire való |
|---|---|
| `todos` | Teendők. Heti ismétlődésnél a `due_date` a sorozat első napja; a kipipált alkalmak a `done_dates`, a törölt alkalmak a `skip_dates` tömbben vannak. |
| `family_events` | Névnapok, születésnapok, évfordulók – csak hónap + nap, évente ismétlődik. |
| `push_subscriptions` | Eszközönként egy Web Push feliratkozás. A lejártakat a napi script automatikusan törli. |
| `family_members` | Engedélylista: csak az itt szereplő e-mail címekkel lehet az adatokhoz hozzáférni. Az appból nem olvasható és nem módosítható. |

**Jogosultságok (RLS) – kettős védelem:**
1. A regisztráció ki van kapcsolva, fiókot csak a Supabase Dashboardon lehet létrehozni.
2. Még ha valaki mégis fiókot szerezne, az adatokat csak a `family_members` listán szereplő e-mail címekkel lehet olvasni és írni. A listán nem szereplő fiókot az app azonnal kijelentkezteti.

A push feliratkozásokat mindenki csak a sajátját kezelheti.

### 4. Családi fiókok létrehozása

1. Supabase → **Authentication → Users → Add user → Create new user**
   - add meg a családtag e-mail címét és jelszavát, pipáld be az **Auto Confirm User** opciót.
   - Ismételd meg minden családtagnak. Érdemes külön fiók, így mindenki telefonja külön kap értesítést.
2. **Vedd fel a családtagokat az engedélylistára** – SQL Editor → New query (a saját címeitekkel, kisbetűvel):
   ```sql
   insert into public.family_members (email, name) values
     ('elso.csaladtag@example.com',   'Apa'),
     ('masodik.csaladtag@example.com', 'Anya')
   on conflict (email) do nothing;
   ```
   Később új családtag felvétele: új fiók (1. pont) + egy új sor ebbe a táblába. Eltávolítás: töröld a sort a **Table Editor → family_members** táblából, és a felhasználót az Authentication → Users alatt.
3. ⚠️ **Kapcsold ki a regisztrációt:**
   **Authentication → Sign In / Providers → „Allow new users to sign up” → KI**.
4. **Authentication → URL Configuration → Site URL:** `https://<felhasznalonev>.github.io/csaladi-naptar/`
5. Használjatok **erős, egyedi jelszót** (pl. jelszókezelővel generálva).

### 5. Supabase kulcsok a frontendbe

Supabase → **Project Settings → API Keys** (vagy **Data API**):

- **Project URL** → pl. `https://abcdxyz.supabase.co`
- **anon / publishable key** → a böngészőbe ez kerül (nyilvános, az RLS védi az adatokat)
- **service_role / secret key** → ⚠️ titkos, CSAK GitHub Secretsbe!

Írd be a [`js/config.js`](js/config.js)-be:

```js
export const CONFIG = {
  SUPABASE_URL: 'https://abcdxyz.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...  vagy  sb_publishable_...',
  VAPID_PUBLIC_KEY: '',   // a következő lépésben töltjük ki
};
```

### 6. VAPID kulcsok generálása (Web Push)

A VAPID kulcspár azonosítja a szerveredet a push szolgáltatók (Apple, Google, Mozilla) felé. Egyszer kell legenerálni (Node.js 18+ kell hozzá):

```bash
npx web-push generate-vapid-keys
```

Kimenet például:

```
=======================================
Public Key:
BNc...hosszú_szöveg...xyz
Private Key:
k3J...rövidebb_szöveg...Q
=======================================
```

- A **Public Key** kerüljön a `js/config.js` → `VAPID_PUBLIC_KEY` mezőbe **és** a GitHub Secretsbe is.
- A **Private Key** CSAK a GitHub Secretsbe kerüljön, sehova máshova!

> ⚠️ Ha később új kulcspárt generálsz, minden eszközön újra be kell kapcsolni az értesítéseket.

Commitold és pushold a módosított `js/config.js`-t.

### 7. GitHub Pages bekapcsolása

Repó → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, mappa: `/ (root)` → **Save**.

Pár perc múlva elérhető: `https://<felhasznalonev>.github.io/csaladi-naptar/`

(A `.nojekyll` fájl miatt a GitHub nem dolgozza fel Jekyll-lel a fájlokat.)

### 8. GitHub Secrets beállítása

Repó → **Settings → Secrets and variables → Actions → New repository secret**

| Secret neve | Kötelező | Érték |
|---|---|---|
| `SUPABASE_URL` | ✅ | `https://abcdxyz.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | service_role (vagy `sb_secret_...`) kulcs |
| `VAPID_PUBLIC_KEY` | ✅ | a generált Public Key |
| `VAPID_PRIVATE_KEY` | ✅ | a generált Private Key |
| `VAPID_SUBJECT` | ✅ | `mailto:te@example.com` – kapcsolattartási cím a push szolgáltatóknak |
| `APP_URL` | ajánlott | `https://<felhasznalonev>.github.io/csaladi-naptar/` – az értesítésre koppintva ez nyílik meg |
| `NTFY_TOPIC` | ➖ | ntfy téma neve (lásd lent) |
| `NTFY_SERVER` | ➖ | saját ntfy szerver (alapértelmezés: `https://ntfy.sh`) |
| `NTFY_TOKEN` | ➖ | ntfy hozzáférési token, ha védett a téma |
| `SMTP_HOST` | ➖ | pl. `smtp.gmail.com` |
| `SMTP_PORT` | ➖ | `465` (SSL) vagy `587` (STARTTLS) |
| `SMTP_USER` | ➖ | pl. `csalad@gmail.com` |
| `SMTP_PASS` | ➖ | Gmailnél **alkalmazásjelszó** (Google fiók → Biztonság → Kétlépcsős azonosítás → Alkalmazásjelszavak) |
| `EMAIL_TO` | ➖ | címzett(ek), vesszővel elválasztva |
| `EMAIL_FROM` | ➖ | feladó (alapértelmezés: `SMTP_USER`) |

### 9. Telepítés iPhone-ra és értesítések bekapcsolása

> iOS / iPadOS **16.4 vagy újabb** kell. A push csak a Főképernyőre mentett appban működik, Safari fülön nem.

1. Nyisd meg az app URL-jét **Safariban**.
2. **Megosztás** gomb (négyzet felfelé mutató nyíllal) → **Főképernyőhöz adás** → Hozzáadás.
3. Indítsd el az appot a **Főképernyő ikonjáról**.
4. Jelentkezz be. (A Főképernyőről indított app külön tárolót használ, ezért itt újra be kell lépni.)
5. **Beállítások** fül → **Értesítések bekapcsolása** → **Engedélyezés**.
6. **Teszt értesítés** gombbal ellenőrizd, hogy megjelenik-e.

Androidon (Chrome) és asztali gépen is ugyanígy működik; ott a böngésző maga ajánlja fel a telepítést.

### 10. A napi értesítő kipróbálása

Repó → **Actions → Napi emlékeztető → Run workflow**

- `force` = ✅ → azonnal küld, akkor is, ha ma nincs semmi (ilyenkor „Mára nincs teendő” üzenet megy)
- `dry_run` = ✅ → semmit nem küld, csak a naplóba írja az üzenetet

Az ütemezett futás minden reggel **7:00-kor** (budapesti idő) történik. Az értesítés csak akkor megy ki, ha:

- van mára nyitott teendő, **vagy**
- van vásárlós teendő a következő 1/3/5/7 napban (amit a teendőnél beállítottál), **vagy**
- egy családi esemény a beállított figyelmeztetési ablakon belül van (alapból 3 nap + aznap).

---

## Opcionális csatornák

### ntfy (egyszerű, fiók nélküli push)

1. Telepítsd az **ntfy** appot (iOS / Android).
2. Válassz egy nehezen kitalálható témanevet, pl. `csaladi-naptar-8f3k2x91`, és iratkozz fel rá az appban.
3. Add meg GitHub Secretként: `NTFY_TOPIC=csaladi-naptar-8f3k2x91`.

> Az ntfy.sh nyilvános szerverén a témanév az egyetlen „jelszó” – ne legyen könnyen kitalálható.

### E-mail

Állítsd be az `SMTP_*`, `EMAIL_TO` secreteket (lásd a táblázatot). Gmailnél kötelező az alkalmazásjelszó.

---

## Helyi fejlesztés

```bash
npm install          # a napi scripthez (web-push, nodemailer)
npm start            # http://localhost:5173 – a Service Worker localhoston is működik
npm test             # dátumlogika unit tesztek
npm run icons        # ikonok újragenerálása
```

A napi script helyi próbája (a változókat a saját értékeidre cseréld):

```bash
SUPABASE_URL=https://abcdxyz.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
DRY_RUN=true FORCE_SEND=true \
node scripts/daily-reminder.mjs

# egy adott nap szimulálása:
TODAY=2026-12-24 DRY_RUN=true ... node scripts/daily-reminder.mjs
```

Ha a `js/config.js` üres, az app **helyi módban** indul (bejelentkezés nélkül, csak az adott böngészőben tárol) – így Supabase nélkül is kipróbálható.

---

## Tudnivalók és hibaelhárítás

**Ütemezés, téli/nyári időszámítás:** a GitHub cron mindig UTC-ben fut, és az ütemezett futásokat terhelés idején késleltetheti vagy ki is hagyhatja. Ezért a workflow reggel negyedóránként elindul (05:03–09:48 UTC). A script csak a budapesti 07:00–10:59 ablakban küld, és egy napi „már elküldve” jelző (Actions cache) biztosítja, hogy naponta csak egy értesítés menjen ki. Ha egy futás kimarad, a következő negyedórás pótolja.

**Késik a reggeli értesítés:** a GitHub ütemezett futásai terhelés esetén 5–30 percet is késhetnek, ilyenkor az értesítés 7:00 helyett pl. 7:20-kor jön. Ez normális. A kézi „Run workflow” (force) futás nem állítja be a napi jelzőt, így a próbák nem akadályozzák a reggeli értesítést.

**Leállt az ütemezés:** nyilvános repóban a GitHub **60 nap inaktivitás** (nincs commit) után automatikusan letiltja az ütemezett workflow-kat, erről e-mailt is küld. Ilyenkor: Actions → Napi emlékeztető → **Enable workflow**. Bármilyen commit is újraindítja a számlálót.

**Supabase szüneteltetés:** az ingyenes projektet a Supabase 7 nap inaktivitás után szüneteltetheti. A napi script minden reggel lekérdezi az adatbázist, ez általában elég aktivitásnak számít. Ha mégis szünetel, a Dashboardon egy kattintással visszaállítható.

**Nem jön push iPhone-ra:**
- Főképernyőről indítod az appot, nem Safariból?
- iOS 16.4 vagy újabb?
- Beállítások (iOS) → Értesítések → Családi Naptár → engedélyezve?
- A `VAPID_PUBLIC_KEY` ugyanaz a `config.js`-ben és a GitHub Secretben?
- Fókusz módban (Ne zavarjanak) az értesítések elnémulhatnak.
- Kapcsold ki, majd be újra az értesítéseket a Beállítások fülön.

**Nem frissül az app a telefonon:** a [`sw.js`](sw.js) elején emeld meg a `VERSION` értékét minden kiadásnál, majd zárd be és nyisd meg újra az appot.

**`401` / `permission denied` a konzolban:** nem futott le az SQL `grant` része, vagy nem vagy bejelentkezve.

**„Ez a fiók nincs a családtagok listáján”:** az e-mail cím nincs a `family_members` táblában, vagy nagybetűvel került be (csak kisbetűs címet fogad el). Lásd 4. lépés, 2. pont.

**Üres a naptár bejelentkezés után, de van adat:** ugyanaz az ok – a listán nem szereplő fiók semmit nem lát.

**Biztonság:**
- A `js/config.js`-ben csak nyilvános értékek vannak (anon kulcs, VAPID publikus kulcs). Az adatokat a Row Level Security védi.
- A `service_role` / `secret` kulcs és a VAPID privát kulcs csak GitHub Secretsben lehet.
- Kettős védelem: kikapcsolt regisztráció + `family_members` engedélylista (4. lépés).
- Az appban nincs regisztráció gomb; fiókot csak a Supabase Dashboardon lehet létrehozni.
