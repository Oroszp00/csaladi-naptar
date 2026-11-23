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
