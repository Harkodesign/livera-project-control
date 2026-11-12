-- Project Control: database setup for Supabase.
-- Paste this whole file into the Supabase SQL editor and run it.
-- BEFORE running: put your own email in the last statement of this file.
-- Safe to run more than once.

-- ---------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------

-- Who may sign in, and what they may do.
create table if not exists public.members (
  email text primary key check (email = lower(email)),
  role  text not null check (role in ('owner','editor','contributor','viewer')),
  name  text
);

-- Every piece of project data: one row per document, grouped by collection.
create table if not exists public.records (
  col        text not null,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (col, id)
);

-- ---------------------------------------------------------------
-- 2. Helper functions
-- ---------------------------------------------------------------

-- The signed-in person's role, or null if they are not a member.
create or replace function public.npc_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.members
  where lower(email) = lower(auth.jwt() ->> 'email')
  limit 1
$$;

grant execute on function public.npc_role() to anon, authenticated;

-- Stamp every record with the time and the person who changed it.
create or replace function public.npc_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := lower(auth.jwt() ->> 'email');
  return new;
end
$$;

drop trigger if exists records_touch on public.records;
create trigger records_touch
  before insert or update on public.records
  for each row execute function public.npc_touch();

-- Bytes used in the file bucket (owner and editor only; null for others).
create or replace function public.npc_storage_bytes() returns bigint
language sql stable security definer set search_path = public, storage as $$
  select case when public.npc_role() in ('owner','editor') then
    coalesce((select sum((metadata ->> 'size')::bigint)
              from storage.objects where bucket_id = 'project-files'), 0)
  end
$$;

grant execute on function public.npc_storage_bytes() to authenticated;

-- ---------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------

grant select, insert, update, delete on public.members to authenticated;
grant select, insert, update, delete on public.records to authenticated;

alter table public.members enable row level security;
alter table public.records enable row level security;

-- members: any member can read the list; only the owner can change it.
drop policy if exists members_read   on public.members;
drop policy if exists members_insert on public.members;
drop policy if exists members_update on public.members;
drop policy if exists members_delete on public.members;

create policy members_read on public.members
  for select to authenticated
  using (public.npc_role() is not null);

create policy members_insert on public.members
  for insert to authenticated
  with check (public.npc_role() = 'owner');

create policy members_update on public.members
  for update to authenticated
  using (public.npc_role() = 'owner')
  with check (public.npc_role() = 'owner');

create policy members_delete on public.members
  for delete to authenticated
  using (public.npc_role() = 'owner');

-- records:
--   budget, payments : read and write by owner and editor only
--   meta             : read by any member, write by owner and editor
--   everything else  : read by any member, write by owner, editor, contributor
drop policy if exists records_read   on public.records;
drop policy if exists records_insert on public.records;
drop policy if exists records_update on public.records;
drop policy if exists records_delete on public.records;

create policy records_read on public.records
  for select to authenticated
  using (
    case when col in ('budget','payments')
      then public.npc_role() in ('owner','editor')
      else public.npc_role() is not null
    end
  );

create policy records_insert on public.records
  for insert to authenticated
  with check (
    case when col in ('budget','payments','meta')
      then public.npc_role() in ('owner','editor')
      else public.npc_role() in ('owner','editor','contributor')
    end
  );

create policy records_update on public.records
  for update to authenticated
  using (
    case when col in ('budget','payments','meta')
      then public.npc_role() in ('owner','editor')
      else public.npc_role() in ('owner','editor','contributor')
    end
  )
  with check (
    case when col in ('budget','payments','meta')
      then public.npc_role() in ('owner','editor')
      else public.npc_role() in ('owner','editor','contributor')
    end
  );

create policy records_delete on public.records
  for delete to authenticated
  using (
    case when col in ('budget','payments','meta')
      then public.npc_role() in ('owner','editor')
      else public.npc_role() in ('owner','editor','contributor')
    end
  );

-- ---------------------------------------------------------------
-- 4. File storage: one private bucket, 50 MB per file
-- ---------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('project-files', 'project-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists npc_files_read   on storage.objects;
drop policy if exists npc_files_insert on storage.objects;
drop policy if exists npc_files_delete on storage.objects;

-- Any member can read (through short-lived signed links).
create policy npc_files_read on storage.objects
  for select to authenticated
  using (bucket_id = 'project-files' and public.npc_role() is not null);

-- Owner, editor and contributor can upload. There is no update policy,
-- so an uploaded file can never be overwritten.
create policy npc_files_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'project-files'
              and public.npc_role() in ('owner','editor','contributor'));

-- Only owner and editor can delete.
create policy npc_files_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'project-files'
         and public.npc_role() in ('owner','editor'));

-- ---------------------------------------------------------------
-- 5. Live updates
-- ---------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'records'
  ) then
    alter publication supabase_realtime add table public.records;
  end if;
end
$$;

-- ---------------------------------------------------------------
-- 6. The first owner.  CHANGE THIS EMAIL TO YOUR OWN before running.
-- ---------------------------------------------------------------

insert into public.members (email, role, name)
values (lower('owner@example.com'), 'owner', 'Owner')
on conflict (email) do nothing;
