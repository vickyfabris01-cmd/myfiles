-- 004_report_details.sql  -  RICHER REPORTS (Part 1)
-- Run ONCE in the Supabase SQL Editor, after 003. Safe to re-run (everything is "if not exists" or "create or replace").
--
-- What it adds:
--  * profiles.display_name        the host's name (new sign-ups send it; older hosts show their email until they set one)
--  * reports: folder, file, and a SNAPSHOT of the event / folder / file names taken when the report is sent,
--    so renaming or moving things afterwards cannot hide what was reported
--  * reports.media_views          how many times the super admin opened the reported file (an audit trail)
--  * super_reports_list / super_host_list now also return the names

-- ============================================================ columns
alter table profiles add column if not exists display_name text;
alter table profiles drop constraint if exists profiles_display_name_check;
alter table profiles add  constraint profiles_display_name_check
  check (display_name is null or char_length(display_name) between 1 and 80);

alter table reports add column if not exists folder_id              uuid references media_folders(id) on delete set null;
alter table reports add column if not exists file_id                uuid references media_files(id)   on delete set null;
alter table reports add column if not exists event_title            text;
alter table reports add column if not exists folder_name            text;
alter table reports add column if not exists file_name              text;
alter table reports add column if not exists media_views            int  not null default 0;
alter table reports add column if not exists media_last_viewed_at   timestamptz;

-- ============================================================ super admin views
-- The return types change, so the old versions must be dropped first.
drop function if exists super_reports_list(boolean);
create function super_reports_list(p_open_only boolean)
returns table (id uuid, event_id uuid, host_id uuid, host_email text, host_name text, reason text, status text,
               event_title text, folder_name text, file_name text, has_file boolean,
               media_views int, report_count bigint, event_suspended boolean, created_at timestamptz)
language sql stable set search_path = public as $$
  select r.id, r.event_id, e.created_by, p.email, p.display_name, r.reason, r.status,
         coalesce(r.event_title, e.title), r.folder_name, r.file_name,
         (r.file_id is not null and exists (select 1 from media_files m where m.id = r.file_id and m.status = 'ready')),
         r.media_views,
         (select count(*) from reports r2 where r2.event_id = r.event_id),
         e.suspended_at is not null, r.created_at
    from reports r join events e on e.id = r.event_id join profiles p on p.user_id = e.created_by
   where (not p_open_only or r.status = 'open')
   order by r.created_at desc limit 200
$$;

drop function if exists super_host_list();
create function super_host_list()
returns table (user_id uuid, email text, display_name text, status text, events bigint, used_bytes bigint, quota_bytes bigint, created_at timestamptz)
language sql stable set search_path = public as $$
  select p.user_id, p.email, p.display_name, p.status,
         (select count(*) from events e where e.created_by = p.user_id and e.deleted_at is null),
         host_used_bytes(p.user_id), host_quota(p.user_id), p.created_at
    from profiles p where p.role = 'host'
   order by (p.status = 'pending') desc, p.created_at desc
$$;

-- ============================================================ security (same block as 003: new functions must not be callable by anon)
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- Check:  select id, host_name, event_title, folder_name, file_name, has_file from super_reports_list(false);
