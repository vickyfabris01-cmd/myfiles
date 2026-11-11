-- 008_stored_names.sql  -  NAMES ARE STORED, NOT ONLY APPLIED AT DOWNLOAD
-- Run ONCE in the Supabase SQL Editor, after 007. Safe to re-run. Nothing is deleted.
--
-- The Worker now writes the convention name (Event_Folder_YYYY-MM-DD-HH-MM-SS.ext) into media_files.original_filename:
-- at upload, when an event or folder is renamed, when files are moved, and when the host presses "Apply to all files".
--  * source_filename   the name the file had when it was uploaded (camera name). Used for the duplicate warning.
--  * name_applied      true once the convention name has been stored for the file
--  * apply_file_names  applies a list of {id, name} to one event's files in a single call (never touches host-named files)
--  * files_manifest    also returns name_applied
-- Run this BEFORE deploying the new Worker.

alter table media_files add column if not exists source_filename text;
alter table media_files add column if not exists name_applied boolean not null default false;
update media_files set source_filename = original_filename where source_filename is null;

create or replace function apply_file_names(p_event uuid, p_updates jsonb)
returns int language sql set search_path = public as $$
  with u as (
    update media_files m
       set original_filename = left(x.name, 255), name_applied = true
      from jsonb_to_recordset(p_updates) as x(id uuid, name text)
     where m.id = x.id and m.event_id = p_event and not m.name_is_custom and x.name is not null and x.name <> ''
    returning 1)
  select count(*)::int from u
$$;

drop function if exists files_manifest(uuid, uuid, boolean, int, int);
create function files_manifest(p_event uuid, p_folder uuid, p_recursive boolean, p_limit int, p_offset int)
returns table (id uuid, original_filename text, size_bytes bigint, media_type text, mime_type text, folder_id uuid,
               taken_at timestamptz, created_at timestamptz, name_is_custom boolean, name_applied boolean, total bigint)
language sql stable set search_path = public as $$
  select m.id, m.original_filename, m.size_bytes, m.media_type, m.mime_type, m.folder_id,
         m.taken_at, m.created_at, m.name_is_custom, m.name_applied, count(*) over ()
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
