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
begin
  if auth.uid() is null then
    return new;
  end if;
  -- Jegyzet módosításánál csak akkor szólunk, ha a szöveg tényleg változott.
  if tg_table_name = 'day_notes' and tg_op = 'UPDATE' and new.note is not distinct from old.note then
    return new;
  end if;

  k := case when tg_table_name = 'day_notes' then new.day::text else new.id::text end;
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
-- Kezdődő teendők: percenként fut, és a ~2 perc múlva kezdődőket küldi
-- (a GitHub-os futás 1–2 percig tart, így az értesítés nagyjából a kezdésre érkezik).
-- -----------------------------------------------------------------------------
create or replace function public.check_starting_todos()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target timestamp := (now() at time zone 'Europe/Budapest') + interval '2 minutes';
  d date := target::date;
  hm text := to_char(target, 'HH24:MI');
  ids uuid[];
begin
  select array_agg(t.id) into ids
  from public.todos t
  where t.due_time is not null
    and to_char(t.due_time, 'HH24:MI') = hm
    and (
      (t.recurrence = 'none' and t.due_date = d and not t.done)
      or (
        t.recurrence = 'weekly'
        and t.due_date <= d
        and (d - t.due_date) % 7 = 0
        and (t.recurrence_end is null or d <= t.recurrence_end)
        and not (d = any (t.skip_dates))
        and not (d = any (t.done_dates))
      )
    );

  if ids is not null then
    perform public.dispatch_reminder('start', jsonb_build_object('ids', ids, 'date', d));
  end if;
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
