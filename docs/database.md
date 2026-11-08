# Database contract

All tables are in `public`, RLS enabled with no policies: the browser can never read them. Only the Worker (service key) can.

| Table | Purpose / key columns |
|---|---|
| admins | `user_id` (auth.users), `is_active`. Inserted by SQL only |
| events | `title, event_date, description, location, share_token_hash, share_token_enc, is_published, publish_at, unpublish_at, cover_mode, cover_file_id, deleted_at, purge_after, purge_attempts, purge_last_error` |
| media_folders | `event_id, parent_id (nesting), name, cover_mode, cover_file_id`. Name unique per parent, case-insensitive |
| media_files | `event_id, folder_id (null = directly on event), original_filename, sort_name, object_key, thumbnail_key, media_type (photo\|video), mime_type, size_bytes, width, height, duration_seconds, status (uploading\|ready\|failed)` |
| upload_sessions | `file_id, r2_upload_id (null = single PUT), part_size, status, expires_at` |

Status values: events are public only when `is_published = true AND deleted_at IS NULL`. `deleted_at` set means pending deletion (`purge_after = deleted_at + 7 days`).
Object keys: originals `events/{event_id}/originals/{file_id}`, thumbnails `events/{event_id}/thumbs/{file_id}.jpg`. Filenames never appear in keys, so identical filenames cannot collide.
SQL functions used by the Worker: `event_cover_file, folder_subtree, folder_breadcrumb, folder_cards, files_manifest, admin_events_overview, apply_schedules`. Executable by `service_role` only.
Change rule: any schema change = new numbered file in `database/migrations/` + update `schema.sql` + update this page.
