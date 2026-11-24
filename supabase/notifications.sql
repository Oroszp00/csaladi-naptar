-- =============================================================================
-- Családi Naptár – pontos értesítések (Supabase pg_cron + pg_net → GitHub Actions)
--
-- Mit csinál:
--   • 07:00 (Budapest)       → reggeli összefoglaló        (mode = morning)
--   • időpontos teendő előtt → „Most kezdődik” értesítés   (mode = start)
--   • új teendő / családi dátum / napi jegyzet → a többi családtag értesítése (mode = change)
--
-- Előfeltétel: egy GitHub fine-grained token a Vaultban 'github_dispatch_token' néven
-- (csak a csaladi-naptar repóhoz, Actions: Read and write jogosultsággal) – lásd README.
-- Futtatás: Supabase → SQL Editor → New query → Run. Többször is lefuttatható.
-- =============================================================================

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- GitHub repó és workflow – ha átnevezed a repót, itt is írd át.
create or replace function public.csn_dispatch_url()
returns text language sql immutable as $$
  select 'https://api.github.com/repos/Oroszp00/csaladi-naptar/actions/workflows/daily-reminder.yml/dispatches'
$$;

-- -----------------------------------------------------------------------------
-- Értesítő workflow indítása (aszinkron HTTP hívás, nem lassítja a mentést)
-- -----------------------------------------------------------------------------
create or replace function public.dispatch_reminder(p_mode text, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  tok text;
begin
  select decrypted_secret into tok
  from vault.decrypted_secrets
  where name = 'github_dispatch_token'
  limit 1;

  if tok is null then
    raise warning 'Családi Naptár: hiányzik a github_dispatch_token a Vaultból – értesítés kihagyva';
    return;
  end if;

  perform net.http_post(
    url := public.csn_dispatch_url(),
    body := jsonb_build_object(
      'ref', 'main',
      'inputs', jsonb_build_object(
        'mode', p_mode,
        'payload', p_payload::text,
        'force', 'false',
        'dry_run', 'false'
      )
    ),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'csaladi-naptar-supabase',
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 10000
  );
end;
$$;
revoke all on function public.dispatch_reminder(text, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Új bejegyzés → értesítés a többi családtagnak
-- Csak az appból (bejelentkezett felhasználó) érkező változásra fut, a scriptekre nem.
-- -----------------------------------------------------------------------------
create or replace function public.notify_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text;
  n jsonb := to_jsonb(new);  -- jsonb-n keresztül olvassuk a mezőket, mert nem minden táblában ugyanazok vannak
begin
  if auth.uid() is null then
    return new;
  end if;
  -- Jegyzet módosításánál csak akkor szólunk, ha a szöveg tényleg változott.
  if tg_op = 'UPDATE' and (n ->> 'note') is not distinct from (to_jsonb(old) ->> 'note') then
    return new;
  end if;

  k := coalesce(n ->> 'id', n ->> 'day');
  perform public.dispatch_reminder('change', jsonb_build_object(
    'table', tg_table_name, 'op', tg_op, 'key', k, 'actor', auth.uid()
  ));
  return new;
end;
$$;
revoke all on function public.notify_change() from public, anon, authenticated;

drop trigger if exists todos_notify_change on public.todos;
create trigger todos_notify_change after insert on public.todos
  for each row execute function public.notify_change();

drop trigger if exists family_events_notify_change on public.family_events;
create trigger family_events_notify_change after insert on public.family_events
  for each row execute function public.notify_change();

drop trigger if exists day_notes_notify_change on public.day_notes;
create trigger day_notes_notify_change after insert or update on public.day_notes
  for each row execute function public.notify_change();

-- -----------------------------------------------------------------------------
-- Kezdődő teendők: percenként fut. Azokat küldi, amelyek a következő 2 percben
-- kezdődnek, vagy az előző percben kezdődtek (pl. épp most vették fel) – a GitHub-os
-- futás 1–2 perc, így az értesítés nagyjából a kezdésre érkezik.
-- A start_notifications tábla jegyzi, mire ment már ki értesítés (nincs dupla).
-- -----------------------------------------------------------------------------
create table if not exists public.start_notifications (
  todo_id  uuid not null references public.todos (id) on delete cascade,
  day      date not null,
  sent_at  timestamptz not null default now(),
  primary key (todo_id, day)
);
alter table public.start_notifications enable row level security;  -- nincs policy → appból elérhetetlen
revoke all on public.start_notifications from anon, authenticated;

create or replace function public.check_starting_todos()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  now_local timestamp := now() at time zone 'Europe/Budapest';
  win_from  timestamp := now_local - interval '1 minute';
  win_to    timestamp := now_local + interval '2 minutes';
  rec record;
  ids uuid[] := '{}';
  first_day date;
begin
  for rec in
    select distinct t.id, v.d
    from public.todos t
    cross join (values (win_from::date), (win_to::date)) as v(d)
    where t.due_time is not null
      and (v.d + t.due_time) >= win_from
      and (v.d + t.due_time) <  win_to
      and (
        (t.recurrence = 'none' and t.due_date = v.d and not t.done)
        or (
          t.recurrence = 'weekly'
          and t.due_date <= v.d
          and (v.d - t.due_date) % 7 = 0
          and (t.recurrence_end is null or v.d <= t.recurrence_end)
          and not (v.d = any (t.skip_dates))
          and not (v.d = any (t.done_dates))
        )
      )
      and not exists (
        select 1 from public.start_notifications s where s.todo_id = t.id and s.day = v.d
      )
  loop
    insert into public.start_notifications (todo_id, day) values (rec.id, rec.d) on conflict do nothing;
    ids := ids || rec.id;
    first_day := coalesce(first_day, rec.d);
  end loop;

  if array_length(ids, 1) > 0 then
    perform public.dispatch_reminder('start', jsonb_build_object('ids', ids, 'date', first_day));
  end if;

  -- takarítás: 30 napnál régebbi naplóbejegyzések
  delete from public.start_notifications where day < (now_local::date - 30);
end;
$$;
revoke all on function public.check_starting_todos() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Ütemezések (pg_cron UTC-ben fut)
--   05:00 és 06:00 UTC: a nyári (CEST) ill. téli (CET) 07:00. A script csak a
--   budapesti 07–11 óra között küld, és naponta egyszer → nincs dupla értesítés.
-- -----------------------------------------------------------------------------
select cron.schedule('csn-morning', '0 5,6 * * *', $$select public.dispatch_reminder('morning')$$);
select cron.schedule('csn-start-check', '* * * * *', $$select public.check_starting_todos()$$);

-- Ellenőrzés: select jobname, schedule, active from cron.job;
-- Utolsó futások: select * from cron.job_run_details order by start_time desc limit 10;
-- HTTP válaszok:  select id, status_code, content from net._http_response order by created desc limit 10;
