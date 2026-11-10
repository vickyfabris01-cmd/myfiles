-- 005_date_taken_and_duplicates.sql  -  ZIP 2: sort by date taken, duplicate warning
-- Run ONCE in the Supabase SQL Editor, after 003 and 004 (report details). Nothing here deletes data.
--
--  * taken_at     : the date a photo/video was taken (read in the browser when it is uploaded). Empty for older files.
--  * sort_date    : taken_at when known, otherwise the upload time. EVERY gallery and download order now uses this.
--  * content_hash : SHA-256 of a photo's bytes, used only to warn about an exact duplicate in the same folder.
-- Files uploaded before this step have no taken_at, so they keep sorting by upload time exactly as before.

alter table media_files add column if not exists taken_at     timestamptz;
alter table media_files add column if not exists content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$');
alter table media_files add column if not exists sort_date    timestamptz generated always as (coalesce(taken_at, created_at)) stored;

create index if not exists files_sort_date_idx on media_files (event_id, folder_id, sort_date desc, id desc) where status = 'ready' and deleted_at is null;
create index if not exists files_dup_size_idx  on media_files (event_id, folder_id, size_bytes) where deleted_at is null;
create index if not exists files_dup_hash_idx  on media_files (event_id, folder_id, content_hash) where content_hash is not null and deleted_at is null;

-- Download order follows the same date.
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
   order by m.sort_date, m.id
   limit p_limit offset p_offset
$$;

-- reserve_upload gets two more inputs (date taken, photo hash). The old version is replaced.
drop function if exists reserve_upload(uuid, uuid, uuid, uuid, text, text, text, text, bigint, int, int, numeric, int);
create or replace function reserve_upload(p_user uuid, p_event uuid, p_folder uuid, p_file_id uuid, p_filename text,
                                          p_key text, p_media_type text, p_mime text, p_size bigint,
                                          p_width int, p_height int, p_duration numeric, p_per_minute int,
                                          p_taken timestamptz default null, p_hash text default null)
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
                           size_bytes, width, height, duration_seconds, status, taken_at, content_hash)
  values (p_file_id, p_event, p_folder, p_filename, p_key, p_media_type, p_mime, p_size, p_width, p_height, p_duration, 'uploading', p_taken, p_hash);
  return jsonb_build_object('ok', true, 'used', v_used + p_size, 'quota', v_quota);
end $$;


revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
