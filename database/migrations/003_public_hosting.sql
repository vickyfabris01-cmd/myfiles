-- 003_public_hosting.sql  -  PUBLIC HOSTING, STEP 1 (core)
-- Run ONCE in the Supabase SQL Editor, on top of schema.sql (001) and 002.
-- Safe to read first: it adds tables/columns, backfills existing accounts, and swaps a few functions.
--
-- >>> STEPS FOR YOU (before you run this file) <<<
--  1. Supabase dashboard > Authentication > Users > "Add user" > "Create new user".
--     Email: vickyfabris01@gmail.com, choose a strong password, tick "Auto Confirm User".
--     This will be the super admin (it never hosts events). Your CURRENT login stays a normal host
--     and keeps its events and the hike share link, so there is no data migration.
--  2. Run this whole file. The last block below makes that account the super admin.
--  3. If the last block says "0 rows", the user in step 1 does not exist yet: create it and run only that block again.

-- ============================================================ accounts
create table if not exists profiles (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  email               text not null,
  role                text not null default 'host'    check (role   in ('host', 'super_admin')),
  status              text not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  extra_storage_bytes bigint not null default 0 check (extra_storage_bytes >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One row of system settings.
create table if not exists app_settings (
  id                  boolean primary key default true check (id),
  approval_required   boolean not null default true,                 -- "New accounts need my approval"
  r2_budget_bytes     bigint  not null default 10737418240,          -- 10 GB. Change it in the super admin dashboard
  default_quota_bytes bigint  not null default 2147483648,           -- 2 GB per host
  updated_at          timestamptz not null default now()
);
insert into app_settings (id) values (true) on conflict do nothing;

-- Reports from the public "Report" link. No event title or link is ever returned to the super admin.
create table if not exists reports (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events(id) on delete cascade,
  reason        text not null check (char_length(reason) between 1 and 1000),
  status        text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  reporter_hash text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists reports_open_idx on reports (created_at desc) where status = 'open';
create index if not exists reports_event_idx on reports (event_id);

-- Backfill: every existing admin becomes an active host (suspended if they were inactive).
insert into profiles (user_id, email, role, status)
select a.user_id, coalesce(u.email, ''), 'host', case when a.is_active then 'active' else 'suspended' end
from admins a join auth.users u on u.id = a.user_id
on conflict (user_id) do nothing;

-- Events and upload sessions are now owned by a profile (any host), not only by the old admins table.
alter table events          drop constraint if exists events_created_by_fkey;
alter table events          add  constraint events_created_by_fkey foreign key (created_by) references profiles(user_id);
alter table upload_sessions drop constraint if exists upload_sessions_created_by_fkey;
alter table upload_sessions add  constraint upload_sessions_created_by_fkey foreign key (created_by) references profiles(user_id);
create index if not exists events_owner_idx on events (created_by, deleted_at);

-- ============================================================ suspension and recycle bin columns
alter table events add column if not exists suspended_at   timestamptz;
alter table events add column if not exists suspend_reason text;

-- A deleted file or folder goes to the bin with its own timer (purge_after).
-- bin_group: when a FOLDER is deleted, the folder, its subfolders and its files get bin_group = that folder's id,
-- so the whole thing is one bin item and is restored as a whole. Items binned earlier keep their own timer.
alter table media_files   add column if not exists deleted_at  timestamptz;
alter table media_files   add column if not exists purge_after timestamptz;
alter table media_files   add column if not exists bin_group   uuid;
alter table media_folders add column if not exists deleted_at  timestamptz;
alter table media_folders add column if not exists purge_after timestamptz;
alter table media_folders add column if not exists bin_group   uuid;
alter table media_files   add constraint files_bin_check   check ((deleted_at is null) = (purge_after is null));
alter table media_folders add constraint folders_bin_check check ((deleted_at is null) = (purge_after is null));
create index if not exists files_purge_due_idx   on media_files   (purge_after) where deleted_at is not null;
create index if not exists folders_purge_due_idx on media_folders (purge_after) where deleted_at is not null;
create index if not exists files_bin_group_idx   on media_files   (bin_group)   where bin_group is not null;
create index if not exists folders_bin_group_idx on media_folders (bin_group)   where bin_group is not null;

-- A binned folder must not block creating a new folder with the same name.
drop index if exists folders_unique_name;
create unique index folders_unique_name
  on media_folders (event_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  where deleted_at is null;

-- ============================================================ functions that must now ignore binned items
create or replace function event_cover_file(p_event uuid) returns uuid
language sql stable set search_path = public as $$
  select coalesce(
    (select f.id from events e
       join media_files f on f.id = e.cover_file_id and f.event_id = e.id and f.status = 'ready' and f.deleted_at is null
      where e.id = p_event and e.cover_mode = 'manual'),
    (select id from media_files where event_id = p_event and status = 'ready' and deleted_at is null
      order by (thumbnail_key is not null) desc, created_at desc limit 1)
  )
$$;

create or replace function folder_cards(p_event uuid, p_parent uuid, p_hide_empty boolean)
returns table (id uuid, name text, parent_id uuid, cover_mode text, cover_file_id uuid,
               resolved_cover_id uuid, file_count bigint, recent_file_ids uuid[], created_at timestamptz)
language sql stable set search_path = public as $$
  with recursive tree as (
    select f.id as root_id, f.id as node_id from media_folders f
     where f.event_id = p_event and f.parent_id is not distinct from p_parent and f.deleted_at is null
    union all
    select t.root_id, c.id from tree t join media_folders c on c.parent_id = t.node_id and c.deleted_at is null
  ),
  files as (
    select t.root_id, m.id, m.created_at, m.thumbnail_key
      from tree t join media_files m on m.folder_id = t.node_id and m.status = 'ready' and m.deleted_at is null
  ),
  agg as (
    select root_id, count(*) as cnt,
           (array_agg(id order by (thumbnail_key is not null) desc, created_at desc))[1:3] as recent
      from files group by root_id
  )
  select f.id, f.name, f.parent_id, f.cover_mode, f.cover_file_id,
         case when f.cover_mode = 'manual'
                   and exists (select 1 from media_files m where m.id = f.cover_file_id and m.status = 'ready' and m.deleted_at is null)
              then f.cover_file_id else a.recent[1] end,
         coalesce(a.cnt, 0), coalesce(a.recent, '{}'::uuid[]), f.created_at
    from media_folders f
    left join agg a on a.root_id = f.id
   where f.event_id = p_event and f.parent_id is not distinct from p_parent and f.deleted_at is null
     and (not p_hide_empty or a.cnt > 0)
   order by f.name
$$;

create or replace function files_manifest(p_event uuid, p_folder uuid, p_recursive boolean, p_limit int, p_offset int)
returns table (id uuid, original_filename text, size_bytes bigint, media_type text, folder_id uuid, total bigint)
language sql stable set search_path = public as $$
  select m.id, m.original_filename, m.size_bytes, m.media_type, m.folder_id, count(*) over ()
    from media_files m
   where m.event_id = p_event and m.status = 'ready' and m.deleted_at is null
     and (
       (p_folder is null and (p_recursive or m.folder_id is null))
       or (p_folder is not null and (
            (p_recursive and m.folder_id in (select folder_subtree(p_folder)))
            or (not p_recursive and m.folder_id = p_folder)))
     )
   order by m.created_at, m.id
   limit p_limit offset p_offset
$$;

-- Host-scoped overview (a host only ever gets their own events). Binned files are not counted here.
drop function if exists admin_events_overview(boolean, uuid);
create or replace function admin_events_overview(p_owner uuid, p_deleted boolean, p_id uuid default null)
returns table (id uuid, title text, event_date date, description text, location text,
               is_published boolean, publish_at timestamptz, unpublish_at timestamptz,
               cover_mode text, cover_file_id uuid, resolved_cover_id uuid,
               deleted_at timestamptz, purge_after timestamptz,
               created_at timestamptz, updated_at timestamptz,
               file_count bigint, total_bytes bigint, suspended_at timestamptz)
language sql stable set search_path = public as $$
  select e.id, e.title, e.event_date, e.description, e.location,
         e.is_published, e.publish_at, e.unpublish_at,
         e.cover_mode, e.cover_file_id, event_cover_file(e.id),
         e.deleted_at, e.purge_after, e.created_at, e.updated_at,
         coalesce(s.cnt, 0), coalesce(s.bytes, 0), e.suspended_at
    from events e
    left join lateral (
      select count(*) as cnt, sum(m.size_bytes)::bigint as bytes
        from media_files m where m.event_id = e.id and m.status = 'ready' and m.deleted_at is null
    ) s on true
   where e.created_by = p_owner
     and ((p_id is not null and e.id = p_id)
       or (p_id is null and (e.deleted_at is not null) = p_deleted))
   order by e.event_date desc, e.created_at desc
$$;

-- A suspended event must never be re-published by the schedule.
create or replace function apply_schedules() returns jsonb
language plpgsql set search_path = public as $$
declare n_pub int; n_unpub int;
begin
  with x as (
    update events set is_published = true, publish_at = null
     where deleted_at is null and suspended_at is null and publish_at is not null and publish_at <= now()
    returning id) select count(*) into n_pub from x;
  with y as (
    update events set is_published = false, unpublish_at = null
     where deleted_at is null and unpublish_at is not null and unpublish_at <= now()
    returning id) select count(*) into n_unpub from y;
  return jsonb_build_object('published', n_pub, 'unpublished', n_unpub);
end $$;

-- ============================================================ quota helpers
-- A host's used space = every stored file (ready) + every upload in progress (uploading),
-- INCLUDING files and events sitting in the recycle bin. Thumbnails are not counted.
create or replace function host_quota(p_user uuid) returns bigint
language sql stable set search_path = public as $$
  select coalesce((select default_quota_bytes from app_settings limit 1), 2147483648)
       + coalesce((select extra_storage_bytes from profiles where user_id = p_user), 0)
$$;

create or replace function host_used_bytes(p_user uuid) returns bigint
language sql stable set search_path = public as $$
  select coalesce(sum(m.size_bytes), 0)::bigint
    from media_files m join events e on e.id = m.event_id
   where e.created_by = p_user and m.status in ('ready', 'uploading')
$$;

create or replace function host_storage_summary(p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  with f as (
    select m.size_bytes, m.media_type, m.status,
           (m.deleted_at is not null or e.deleted_at is not null) as binned
      from media_files m join events e on e.id = m.event_id
     where e.created_by = p_user and m.status in ('ready', 'uploading')
  )
  select jsonb_build_object(
    'quota_bytes',   host_quota(p_user),
    'photos_bytes',  coalesce((select sum(size_bytes) from f where status = 'ready' and not binned and media_type = 'photo'), 0),
    'videos_bytes',  coalesce((select sum(size_bytes) from f where status = 'ready' and not binned and media_type = 'video'), 0),
    'bin_bytes',     coalesce((select sum(size_bytes) from f where status = 'ready' and binned), 0),
    'pending_bytes', coalesce((select sum(size_bytes) from f where status = 'uploading'), 0)
  )
$$;

create or replace function host_event_usage(p_user uuid)
returns table (event_id uuid, title text, deleted boolean, total_bytes bigint, bin_bytes bigint)
language sql stable set search_path = public as $$
  select e.id, e.title, e.deleted_at is not null,
         coalesce(sum(m.size_bytes) filter (where m.status in ('ready', 'uploading')), 0)::bigint,
         coalesce(sum(m.size_bytes) filter (where m.status = 'ready' and m.deleted_at is not null), 0)::bigint
    from events e left join media_files m on m.event_id = e.id
   where e.created_by = p_user
   group by e.id, e.title, e.deleted_at, e.event_date, e.created_at
   order by e.event_date desc, e.created_at desc
$$;

-- ============================================================ guarded writes (atomic: one host row is locked)
create or replace function create_event_guarded(p_user uuid, p_max int, p_per_hour int, p_title text, p_date date,
                                                p_desc text, p_loc text, p_hash text, p_enc text)
returns jsonb language plpgsql set search_path = public as $$
declare v_role text; v_status text; v_n int; v_id uuid;
begin
  select role, status into v_role, v_status from profiles where user_id = p_user for update;
  if not found or v_role <> 'host' or v_status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  select count(*) into v_n from events where created_by = p_user and deleted_at is null;
  if v_n >= p_max then return jsonb_build_object('ok', false, 'reason', 'limit', 'max', p_max); end if;
  select count(*) into v_n from events where created_by = p_user and created_at > now() - interval '1 hour';
  if v_n >= p_per_hour then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  insert into events (title, event_date, description, location, share_token_hash, share_token_enc, created_by)
  values (p_title, p_date, p_desc, p_loc, p_hash, p_enc, p_user) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function restore_event_guarded(p_user uuid, p_event uuid, p_max int)
returns jsonb language plpgsql set search_path = public as $$
declare v_n int; v_del timestamptz; v_purge timestamptz;
begin
  perform 1 from profiles where user_id = p_user for update;
  select deleted_at, purge_after into v_del, v_purge from events where id = p_event and created_by = p_user;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_del is null then return jsonb_build_object('ok', false, 'reason', 'not_deleted'); end if;
  if v_purge is not null and v_purge <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select count(*) into v_n from events where created_by = p_user and deleted_at is null;
  if v_n >= p_max then return jsonb_build_object('ok', false, 'reason', 'limit', 'max', p_max); end if;
  update events set deleted_at = null, purge_after = null where id = p_event;
  return jsonb_build_object('ok', true);
end $$;

-- Reserves space for one upload (creates the media_files row in 'uploading' state) or says why not.
create or replace function reserve_upload(p_user uuid, p_event uuid, p_folder uuid, p_file_id uuid, p_filename text,
                                          p_key text, p_media_type text, p_mime text, p_size bigint,
                                          p_width int, p_height int, p_duration numeric, p_per_minute int)
returns jsonb language plpgsql set search_path = public as $$
declare v_role text; v_status text; v_ev_del timestamptz; v_used bigint; v_quota bigint; v_n int; v_bin bigint;
begin
  select role, status into v_role, v_status from profiles where user_id = p_user for update;
  if not found or v_role <> 'host' or v_status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  select deleted_at into v_ev_del from events where id = p_event and created_by = p_user;
  if not found then return jsonb_build_object('ok', false, 'reason', 'event_not_found'); end if;
  if v_ev_del is not null then return jsonb_build_object('ok', false, 'reason', 'event_deleted'); end if;
  if p_folder is not null and not exists
     (select 1 from media_folders where id = p_folder and event_id = p_event and deleted_at is null) then
    return jsonb_build_object('ok', false, 'reason', 'folder_not_found');
  end if;
  select count(*) into v_n from media_files m join events e on e.id = m.event_id
   where e.created_by = p_user and m.created_at > now() - interval '1 minute';
  if v_n >= p_per_minute then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  v_used := host_used_bytes(p_user);
  v_quota := host_quota(p_user);
  if v_used + p_size > v_quota then
    select coalesce(sum(m.size_bytes), 0) into v_bin
      from media_files m join events e on e.id = m.event_id
     where e.created_by = p_user and m.status = 'ready' and (m.deleted_at is not null or e.deleted_at is not null);
    return jsonb_build_object('ok', false, 'reason', 'quota', 'used', v_used, 'quota', v_quota, 'bin_bytes', v_bin);
  end if;
  insert into media_files (id, event_id, folder_id, original_filename, object_key, media_type, mime_type,
                           size_bytes, width, height, duration_seconds, status)
  values (p_file_id, p_event, p_folder, p_filename, p_key, p_media_type, p_mime, p_size, p_width, p_height, p_duration, 'uploading');
  return jsonb_build_object('ok', true, 'used', v_used + p_size, 'quota', v_quota);
end $$;

-- ============================================================ recycle bin listing (root items only)
-- blocked_by tells the UI why an item cannot be restored yet: 'event' or 'folder' (restore that first).
create or replace function bin_items(p_user uuid)
returns table (kind text, id uuid, name text, event_id uuid, event_title text, blocked_by text,
               size_bytes bigint, file_count bigint, deleted_at timestamptz, purge_after timestamptz)
language sql stable set search_path = public as $$
  select * from (
    select 'event'::text as kind, e.id, e.title as name, e.id as event_id, e.title as event_title, null::text as blocked_by,
           coalesce((select sum(m.size_bytes) from media_files m where m.event_id = e.id and m.status = 'ready'), 0)::bigint as size_bytes,
           (select count(*) from media_files m where m.event_id = e.id and m.status = 'ready') as file_count,
           e.deleted_at, e.purge_after
      from events e where e.created_by = p_user and e.deleted_at is not null
    union all
    select 'folder'::text, f.id, f.name, f.event_id, e.title,
           case when e.deleted_at is not null then 'event'
                when f.parent_id is not null and exists (select 1 from media_folders p where p.id = f.parent_id and p.deleted_at is not null) then 'folder'
           end,
           coalesce((select sum(m.size_bytes) from media_files m where m.bin_group = f.id and m.status = 'ready'), 0)::bigint,
           (select count(*) from media_files m where m.bin_group = f.id and m.status = 'ready'),
           f.deleted_at, f.purge_after
      from media_folders f join events e on e.id = f.event_id
     where e.created_by = p_user and f.deleted_at is not null and f.bin_group = f.id and e.deleted_at is null
    union all
    select 'file'::text, m.id, m.original_filename, m.event_id, e.title,
           case when e.deleted_at is not null then 'event'
                when m.folder_id is not null and exists (select 1 from media_folders p where p.id = m.folder_id and p.deleted_at is not null) then 'folder'
           end,
           m.size_bytes, 1::bigint, m.deleted_at, m.purge_after
      from media_files m join events e on e.id = m.event_id
     where e.created_by = p_user and m.deleted_at is not null and m.bin_group is null and e.deleted_at is null
  ) x order by x.deleted_at desc
$$;

-- ============================================================ super admin views (counts and sizes only, never content)
create or replace function system_totals() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'hosts',   (select count(*) from profiles where role = 'host'),
    'pending', (select count(*) from profiles where role = 'host' and status = 'pending'),
    'events',  (select count(*) from events where deleted_at is null),
    'bytes_used', (select coalesce(sum(size_bytes), 0) from media_files where status in ('ready', 'uploading')))
$$;

create or replace function super_host_list()
returns table (user_id uuid, email text, status text, events bigint, used_bytes bigint, quota_bytes bigint, created_at timestamptz)
language sql stable set search_path = public as $$
  select p.user_id, p.email, p.status,
         (select count(*) from events e where e.created_by = p.user_id and e.deleted_at is null),
         host_used_bytes(p.user_id), host_quota(p.user_id), p.created_at
    from profiles p where p.role = 'host'
   order by (p.status = 'pending') desc, p.created_at desc
$$;

-- Reports: host email, reason, date and how many reports that event has. No title, no files, no link.
create or replace function super_reports_list(p_open_only boolean)
returns table (id uuid, event_id uuid, host_id uuid, host_email text, reason text, status text,
               report_count bigint, event_suspended boolean, created_at timestamptz)
language sql stable set search_path = public as $$
  select r.id, r.event_id, e.created_by, p.email, r.reason, r.status,
         (select count(*) from reports r2 where r2.event_id = r.event_id),
         e.suspended_at is not null, r.created_at
    from reports r join events e on e.id = r.event_id join profiles p on p.user_id = e.created_by
   where (not p_open_only or r.status = 'open')
   order by r.created_at desc limit 200
$$;

-- ============================================================ security
alter table profiles     enable row level security;
alter table app_settings enable row level security;
alter table reports      enable row level security;
revoke all on profiles, app_settings, reports from anon, authenticated;
grant all on profiles, app_settings, reports to service_role;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- ============================================================ SUPER ADMIN (last block)
-- Makes vickyfabris01@gmail.com the super admin. It must already exist in Authentication > Users (see STEPS at the top).
insert into profiles (user_id, email, role, status)
select id, email, 'super_admin', 'active' from auth.users where lower(email) = 'vickyfabris01@gmail.com'
on conflict (user_id) do update set role = 'super_admin', status = 'active';
-- Check: select email, role, status from profiles;  (you should see this email as super_admin, your old login as host)
