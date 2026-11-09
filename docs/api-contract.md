# MyFiles API contract (v1)

Base URL: the Worker URL (`https://myfiles-api.<subdomain>.workers.dev`). All bodies are JSON.
Admin routes need `Authorization: Bearer <Supabase access token>`. Public routes need no login.

## Response envelope
```json
{ "success": true,  "data": { }, "error": null }
{ "success": false, "data": null, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": null } }
```
Create endpoints return HTTP 201. Dates are ISO 8601 UTC strings. Show times to the user in Africa/Nairobi; send `publish_at` / `unpublish_at` as UTC ISO.

## Error codes
| HTTP | code | meaning |
|---|---|---|
| 400 | VALIDATION_ERROR | bad input (message says which field) |
| 401 | UNAUTHENTICATED / INVALID_TOKEN | missing, invalid or expired session |
| 403 | NOT_ADMIN | signed in, but not an active admin |
| 404 | NOT_FOUND, EVENT_NOT_FOUND, FOLDER_NOT_FOUND, FILE_NOT_FOUND, SESSION_NOT_FOUND | |
| 404 | EVENT_UNAVAILABLE | public link not usable. `details.reason` = `not_found`, `unpublished` or `deleted` |
| 409 | CONFLICT | duplicate (e.g. folder name already used at that level) |
| 409 | EVENT_DELETED | event is pending deletion; restore first |
| 409 | RECOVERY_EXPIRED / NOT_DELETED | restore not possible |
| 409 | UPLOAD_INCOMPLETE | `details.missing_parts` lists part numbers to (re)upload |
| 409 | SIZE_MISMATCH | stored size differs from declared size; upload again |
| 410 | UPLOAD_EXPIRED | session older than 24 h |
| 413 | FILE_TOO_LARGE | image over 20 MB, video over 800 MB |
| 415 | UNSUPPORTED_MEDIA | not a photo or video (SVG is refused) |
| 429 | RATE_LIMITED | see `Retry-After` header |

## Public share links
`https://<pages-site>/e/<TOKEN>`. Cloudflare Pages `_redirects` serves `event.html` for every `/e/*`; the page reads the token from `location.pathname.split('/')[2]`.

## Public endpoints
### POST /event/validate  `{ "token": "..." }`
```json
{ "event": { "title": "Wedding", "event_date": "2026-05-01", "description": null, "location": "Kisumu",
    "cover": { "file_id": "uuid", "media_type": "photo", "thumbnail_url": "https://..." } } }
```
`cover` can be null (no media yet) and `thumbnail_url` can be null (no thumbnail).

### GET /event/:token/folders?parent_id=
```json
{ "current": { "id": "uuid", "name": "Ceremony", "parent_id": null },
  "breadcrumbs": [ { "id": "uuid", "name": "Ceremony" } ],
  "folders": [ { "id": "uuid", "name": "Rings", "parent_id": "uuid", "file_count": 12,
     "cover": { "file_id": "uuid", "media_type": "photo", "thumbnail_url": "..." },
     "previews": [ { "file_id": "uuid", "media_type": "photo", "thumbnail_url": "..." } ], "created_at": "..." } ] }
```
Empty folders are never returned. `file_count` includes subfolders. `previews` has up to 2 recent files (never the cover). Omit `parent_id` for the top level. When `folders` is empty at the top level, show the files directly.

### GET /event/:token/files?folder_id=&q=&type=&sort=&limit=&offset=&scope=
`type` = `photo|video` (omit for all). `sort` = `newest|oldest|filename`. `limit` 1-100 (default 60). `scope=event` with `q` searches the whole event instead of one folder. Omit `folder_id` for files placed directly on the event.
```json
{ "items": [ { "id": "uuid", "folder_id": null, "filename": "IMG_0001.jpg", "media_type": "photo", "mime_type": "image/jpeg",
    "size_bytes": 5000, "width": 400, "height": 300, "duration_seconds": null, "created_at": "...", "thumbnail_url": "..." } ],
  "total": 3, "limit": 60, "offset": 0, "has_more": false }
```
Pagination: request the next page with `offset += limit` while `has_more` is true (a "Load more" button or scroll trigger on the same page).

### POST /event/:token/download  `{ "file_ids": ["uuid", ...up to 25], "disposition": "attachment" | "inline" }`
```json
{ "items": [ { "file_id": "uuid", "filename": "IMG_0001.jpg", "size_bytes": 5000, "media_type": "photo", "mime_type": "image/jpeg",
    "url": "https://<r2-signed-url>", "expires_in": 900 } ], "missing": [] }
```
`attachment` (default) forces a download with the original filename. Use `inline` for the viewer and `<video src>`; R2 supports HTTP Range so seeking works. URLs expire after 15 minutes: request URLs one file at a time just before each download.

### GET /event/:token/manifest?scope=event|folder&folder_id=&recursive=1&limit=&offset=
Files for a download queue (no URLs). `scope=event` = whole event. `scope=folder` includes subfolders unless `recursive=0`. `limit` up to 1000.
```json
{ "items": [ { "id": "uuid", "filename": "a.jpg", "size_bytes": 5000, "media_type": "photo", "folder_id": null } ], "total": 5, "limit": 1000, "offset": 0, "has_more": false }
```

## Admin endpoints
`event` object returned by event routes:
```json
{ "id": "uuid", "title": "", "event_date": "2026-05-01", "description": null, "location": null,
  "state": "unpublished | scheduled | published | pending_deletion",
  "is_published": false, "publish_at": null, "unpublish_at": null,
  "cover_mode": "auto | manual", "cover_file_id": null, "cover_url": null,
  "file_count": 0, "total_bytes": 0, "deleted_at": null, "recovery_deadline": null, "created_at": "", "updated_at": "" }
```
| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /admin/me | | `{ admin: { id, email } }` |
| GET | /admin/events | `?status=deleted` for the recovery list | `{ events: [event] }` |
| POST | /admin/events | `{ title, event_date, description?, location? }` | 201 `{ event, share_url }` |
| GET | /admin/events/:id | | `{ event }` |
| PATCH | /admin/events/:id | any of `title, event_date, description, location, cover_mode, cover_file_id` | `{ event }` |
| POST | /admin/events/:id/publish | `{ published: true\|false }` | `{ event }`. Unpublishing never deletes. A manual change cancels the matching pending schedule |
| POST | /admin/events/:id/schedule | `{ publish_at?, unpublish_at? }` ISO, future. `null` cancels. Missing = unchanged | `{ event }` |
| DELETE | /admin/events/:id | | `{ event }` now `pending_deletion`, `recovery_deadline` = +7 days. Unavailable publicly at once. Publish and schedule are cleared |
| POST | /admin/events/:id/restore | | `{ event }` back as `unpublished`. 409 `RECOVERY_EXPIRED` after the deadline |
| GET | /admin/events/:id/share-link | | `{ url }` same link every time |
| POST | /admin/events/:id/share-link/regenerate | | `{ url }` old link stops working |
| GET | /admin/events/:id/contents | `folder_id, status (ready/uploading/failed/all), q, type, sort, limit, offset, scope` | `{ current, breadcrumbs, folders: [card + cover_mode + cover_file_id], files: { items (+status, event_id), total, limit, offset, has_more } }` includes empty folders |
| POST | /admin/folders | `{ event_id, parent_id?, name }` | 201 `{ folder }` (max depth 12) |
| PATCH | /admin/folders/:id | `name`, `parent_id` (move, null = top), `cover_mode`, `cover_file_id` (must be inside the folder) | `{ folder }` |
| DELETE | /admin/folders/:id | | `{ deleted_folder_id, deleted_files }` removes subfolders, files and R2 objects |
| PATCH | /admin/files/:id | `folder_id` (move, null = event level), `filename` | `{ file }` |
| DELETE | /admin/files/:id | | `{ deleted_file_id }` |
| POST | /admin/files/bulk | `{ action: "move"\|"delete", file_ids (max 200), folder_id? }` | `{ moved }` or `{ deleted }` |
| POST | /admin/files/:id/thumbnail | | `{ upload_url, content_type, key }` PUT a JPEG (max 2 MB). Every call returns a new `key` |
| POST | /admin/files/:id/thumbnail/confirm | `{ key }` | `{ file_id, thumbnail_key }` sets the thumbnail and deletes the one it replaces. Without `key` it confirms the upload's original thumbnail |
| GET | /admin/files/:id/source | | `{ url, media_type }` signed link (1 hour) to the original, used to scrub a video and pick a frame |

Cover rules: `auto` = newest ready file that has a thumbnail. `manual` = the chosen file. If a manual cover is deleted, the cover falls back to auto.

## Upload flow (browser to R2, never through the Worker)
Limits: image 20 MB, video 800 MB. Up to 50 MB: one PUT. Above 50 MB: multipart, 16 MB parts.

1. **POST /admin/upload/authorize** `{ event_id, folder_id?, filename, mime_type, size_bytes, width?, height?, duration_seconds? }` returns 201:
   - single: `{ file_id, session_id, mode: "single", upload_url, content_type, thumbnail_upload_url, thumbnail_content_type: "image/jpeg", expires_at }`
   - multipart: same without `upload_url`, plus `part_size: 16777216, total_parts`
2. **Single:** `PUT upload_url` with the raw file, header `Content-Type` = `content_type`. Do not touch the bytes.
   **Multipart:** `POST /admin/upload/parts { session_id, part_numbers: [1,2,...] (max 50) }` returns `{ parts: [{ part_number, url }] }`. `PUT` each slice `file.slice((n-1)*part_size, n*part_size)`. Every part must be exactly `part_size` bytes except the last. Part URLs last 1 hour; request fresh ones any time.
3. **Thumbnail (optional but recommended):** create a JPEG in the browser (max 2 MB, about 480 px; for video grab a frame with a canvas) and `PUT thumbnail_upload_url` with `Content-Type: image/jpeg`.
4. **POST /admin/upload/complete** `{ session_id }` returns `{ file }` with `status: "ready"`. Safe to repeat. The Worker checks the stored size and, for multipart, assembles the parts itself (no ETags needed from the browser). On 409 `UPLOAD_INCOMPLETE`, upload `details.missing_parts` and call again.
5. **Resume after interruption:** `GET /admin/upload/status?session_id=` returns `{ status, mode, uploaded_parts: [{part_number,size}], total_parts, part_size }` plus fresh `upload_url` (single) and `thumbnail_upload_url`. Upload only the missing parts, then complete. Sessions live 24 h; abandoned ones are cleaned automatically.
6. **Cancel:** `POST /admin/upload/abort { session_id }` removes everything stored so far.

R2 bucket CORS must allow `PUT` and expose `ETag` (see SETUP.md). Photos in HEIC may not display in every browser; the viewer can fall back to the thumbnail.

## Lifecycle
- New events start unpublished. Publish/unpublish is instant or scheduled (checked every minute).
- Delete: public access stops at once; 7-day recovery; after `recovery_deadline` the hourly job removes database rows, originals, thumbnails and unfinished uploads.
- The share link never changes unless the admin regenerates it.
