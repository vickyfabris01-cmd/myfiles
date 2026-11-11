-- 007_download_names.sql  -  AUTOMATIC DOWNLOAD NAMES
-- Run ONCE in the Supabase SQL Editor, after 006. Safe to re-run. Nothing is deleted or renamed.
--
-- Downloads are now named  <Event>_<Folder>_<YYYY-MM-DD-HH-MM-SS>.<ext>  by the Worker (see cloudflare/worker/names.js).
-- A file the host renames by hand keeps the host's name; that is what name_is_custom records (set by the Worker from now on).
--  * media_files.name_is_custom   true once the host typed a name for the file
--  * files_manifest               now also returns mime_type, taken_at, created_at and name_is_custom
-- Run this BEFORE deploying the new Worker.

alter table media_files add column if not exists name_is_custom boolean not null default false;

drop function if exists files_manifest(uuid, uuid, boolean, int, int);
create function files_manifest(p_event uuid, p_folder uuid, p_recursive boolean, p_limit int, p_offset int)
returns table (id uuid, original_filename text, size_bytes bigint, media_type text, mime_type text, folder_id uuid,
               taken_at timestamptz, created_at timestamptz, name_is_custom boolean, total bigint)
language sql stable set search_path = public as $$
  select m.id, m.original_filename, m.size_bytes, m.media_type, m.mime_type, m.folder_id,
         m.taken_at, m.created_at, m.name_is_custom, count(*) over ()
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

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
