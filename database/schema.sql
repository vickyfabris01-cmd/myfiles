-- database/schema.sql
-- MyFiles full schema. Run once in Supabase SQL Editor on a fresh project.

create extension if not exists pg_trgm with schema extensions;

-- ADMINS (rows are inserted manually, see SETUP.md)
create table admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- EVENTS
create table events (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (length(title) between 1 and 200),
  event_date       date not null,
  description      text,
  location         text,
  share_token_hash text not null unique,   -- sha256 hex, used by public lookups
  share_token_enc  text not null,          -- AES-GCM, only decrypted for the admin
  is_published     boolean not null default false,
  publish_at       timestamptz,
  unpublish_at     timestamptz,
  cover_mode       text not null default 'auto' check (cover_mode in ('auto','manual')),
  cover_file_id    uuid,
  cover_pos_x      real not null default 50 check (cover_pos_x between 0 and 100),  -- which part of the cover to show (%)
  cover_pos_y      real not null default 50 check (cover_pos_y between 0 and 100),
  deleted_at       timestamptz,            -- set = pending deletion
  purge_after      timestamptz,            -- deleted_at + 7 days
  purge_attempts   int not null default 0,
  purge_last_error text,
  created_by       uuid not null references admins(user_id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((deleted_at is null) = (purge_after is null))
);
create index events_publish_due   on events (publish_at)   where publish_at is not null;
create index events_unpublish_due on events (unpublish_at) where unpublish_at is not null;
create index events_purge_due     on events (purge_after)  where deleted_at is not null;

-- FOLDERS (nested)
create table media_folders (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events(id) on delete cascade,
  parent_id     uuid references media_folders(id) on delete cascade,
  name          text not null check (length(name) between 1 and 150),
  cover_mode    text not null default 'auto' check (cover_mode in ('auto','manual')),
  cover_file_id uuid,
  cover_pos_x   real not null default 50 check (cover_pos_x between 0 and 100),
  cover_pos_y   real not null default 50 check (cover_pos_y between 0 and 100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index folders_event_parent on media_folders (event_id, parent_id);
create unique index folders_unique_name
  on media_folders (event_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- FILES
create table media_files (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references events(id) on delete cascade,
  folder_id         uuid references media_folders(id) on delete cascade,
  original_filename text not null,
  sort_name         text generated always as (lower(original_filename)) stored,  -- case-insensitive sorting
  object_key        text not null unique,
  thumbnail_key     text,
  media_type        text not null check (media_type in ('photo','video')),
  mime_type         text not null,
  size_bytes        bigint not null check (size_bytes > 0),
  width             int,
  height            int,
  duration_seconds  numeric,
  status            text not null default 'uploading' check (status in ('uploading','ready','failed')),
  created_at        timestamptz not null default now()
);
create index files_event_folder on media_files (event_id, folder_id, created_at desc) where status = 'ready';
create index files_name_trgm on media_files using gin (original_filename extensions.gin_trgm_ops);

alter table events        add constraint events_cover_fk  foreign key (cover_file_id) references media_files(id) on delete set null;
alter table media_folders add constraint folders_cover_fk foreign key (cover_file_id) references media_files(id) on delete set null;

-- UPLOAD SESSIONS (single and multipart)
create table upload_sessions (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references events(id) on delete cascade,
  folder_id         uuid references media_folders(id) on delete cascade,
  file_id           uuid not null unique references media_files(id) on delete cascade,
  r2_upload_id      text,                  -- null for single PUT
  part_size         int,
  original_filename text not null,
  mime_type         text not null,
  size_bytes        bigint not null,
  status            text not null default 'pending'
                    check (status in ('pending','uploading','completed','aborted','expired')),
  expires_at        timestamptz not null,
  created_by        uuid not null references admins(user_id),
  created_at        timestamptz not null default now()
);
create index uploads_cleanup on upload_sessions (expires_at) where status in ('pending','uploading');

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger events_updated  before update on events        for each row execute function set_updated_at();
create trigger folders_updated before update on media_folders for each row execute function set_updated_at();

-- =====================  QUERY FUNCTIONS (called by the Worker)  =====================

create or replace function event_cover_file(p_event uuid) returns uuid
language sql stable set search_path = public as $$
  select coalesce(
    (select f.id from events e
       join media_files f on f.id = e.cover_file_id and f.event_id = e.id and f.status = 'ready'
      where e.id = p_event and e.cover_mode = 'manual'),
    (select id from media_files where event_id = p_event and status = 'ready'
      order by (thumbnail_key is not null) desc, created_at desc limit 1)
  )
$$;

create or replace function folder_subtree(p_folder uuid) returns setof uuid
language sql stable set search_path = public as $$
  with recursive t as (
    select id from media_folders where id = p_folder
    union all
    select c.id from media_folders c join t on c.parent_id = t.id
  ) select id from t
$$;

create or replace function folder_breadcrumb(p_folder uuid)
returns table (id uuid, name text, depth int)
language sql stable set search_path = public as $$
  with recursive up as (
    select f.id, f.name, f.parent_id, 1 as depth from media_folders f where f.id = p_folder
    union all
    select p.id, p.name, p.parent_id, up.depth + 1 from media_folders p join up on p.id = up.parent_id
  ) select id, name, depth from up order by depth desc
$$;

-- Folder cards: cover + 3 newest file ids, counted over the whole subtree.
create or replace function folder_cards(p_event uuid, p_parent uuid, p_hide_empty boolean)
returns table (id uuid, name text, parent_id uuid, cover_mode text, cover_file_id uuid,
               resolved_cover_id uuid, file_count bigint, recent_file_ids uuid[], created_at timestamptz)
language sql stable set search_path = public as $$
  with recursive tree as (
    select f.id as root_id, f.id as node_id from media_folders f
     where f.event_id = p_event and f.parent_id is not distinct from p_parent
    union all
    select t.root_id, c.id from tree t join media_folders c on c.parent_id = t.node_id
  ),
  files as (
    select t.root_id, m.id, m.created_at, m.thumbnail_key
      from tree t join media_files m on m.folder_id = t.node_id and m.status = 'ready'
  ),
  agg as (
    select root_id, count(*) as cnt,
           (array_agg(id order by (thumbnail_key is not null) desc, created_at desc))[1:3] as recent
      from files group by root_id
  )
  select f.id, f.name, f.parent_id, f.cover_mode, f.cover_file_id,
         case when f.cover_mode = 'manual'
                   and exists (select 1 from media_files m where m.id = f.cover_file_id and m.status = 'ready')
              then f.cover_file_id else a.recent[1] end,
         coalesce(a.cnt, 0), coalesce(a.recent, '{}'::uuid[]), f.created_at
    from media_folders f
    left join agg a on a.root_id = f.id
   where f.event_id = p_event and f.parent_id is not distinct from p_parent
     and (not p_hide_empty or a.cnt > 0)
   order by f.name
$$;

-- Download manifest. p_folder null + p_recursive true = whole event.
create or replace function files_manifest(p_event uuid, p_folder uuid, p_recursive boolean, p_limit int, p_offset int)
returns table (id uuid, original_filename text, size_bytes bigint, media_type text, folder_id uuid, total bigint)
language sql stable set search_path = public as $$
  select m.id, m.original_filename, m.size_bytes, m.media_type, m.folder_id, count(*) over ()
    from media_files m
   where m.event_id = p_event and m.status = 'ready'
     and (
       (p_folder is null and (p_recursive or m.folder_id is null))
       or (p_folder is not null and (
            (p_recursive and m.folder_id in (select folder_subtree(p_folder)))
            or (not p_recursive and m.folder_id = p_folder)))
     )
   order by m.created_at, m.id
   limit p_limit offset p_offset
$$;

-- Admin overview: one event (p_id) or the active/deleted lists.
create or replace function admin_events_overview(p_deleted boolean, p_id uuid default null)
returns table (id uuid, title text, event_date date, description text, location text,
               is_published boolean, publish_at timestamptz, unpublish_at timestamptz,
               cover_mode text, cover_file_id uuid, resolved_cover_id uuid,
               deleted_at timestamptz, purge_after timestamptz,
               created_at timestamptz, updated_at timestamptz,
               file_count bigint, total_bytes bigint)
language sql stable set search_path = public as $$
  select e.id, e.title, e.event_date, e.description, e.location,
         e.is_published, e.publish_at, e.unpublish_at,
         e.cover_mode, e.cover_file_id, event_cover_file(e.id),
         e.deleted_at, e.purge_after, e.created_at, e.updated_at,
         coalesce(s.cnt, 0), coalesce(s.bytes, 0)
    from events e
    left join lateral (
      select count(*) as cnt, sum(m.size_bytes)::bigint as bytes
        from media_files m where m.event_id = e.id and m.status = 'ready'
    ) s on true
   where (p_id is not null and e.id = p_id)
      or (p_id is null and (e.deleted_at is not null) = p_deleted)
   order by e.event_date desc, e.created_at desc
$$;

-- Scheduled publish / unpublish. Idempotent, safe to run every minute.
create or replace function apply_schedules() returns jsonb
language plpgsql set search_path = public as $$
declare n_pub int; n_unpub int;
begin
  with x as (
    update events set is_published = true, publish_at = null
     where deleted_at is null and publish_at is not null and publish_at <= now()
    returning id) select count(*) into n_pub from x;
  with y as (
    update events set is_published = false, unpublish_at = null
     where deleted_at is null and unpublish_at is not null and unpublish_at <= now()
    returning id) select count(*) into n_unpub from y;
  return jsonb_build_object('published', n_pub, 'unpublished', n_unpub);
end $$;

-- =====================  SECURITY  =====================
-- RLS on, no policies: anon and authenticated can never read or write.
-- Only the Worker (service role) touches the database.
alter table admins          enable row level security;
alter table events          enable row level security;
alter table media_folders   enable row level security;
alter table media_files     enable row level security;
alter table upload_sessions enable row level security;

revoke all on admins, events, media_folders, media_files, upload_sessions from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
