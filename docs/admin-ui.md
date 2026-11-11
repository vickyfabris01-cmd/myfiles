# Administrator interface (Dev 2)

Plain HTML, CSS and ES modules. No framework, no build step, no CDN. Uses only the Worker API in `docs/api-contract.md`.

## Pages
| Page | Script | Purpose |
|---|---|---|
| admin/index.html | js/admin/login.js | Sign in (Supabase Auth over REST). Shows why you were signed out |
| admin/events.html | js/admin/dashboard.js | Events overview, create, publish toggle, copy link, recently deleted + restore |
| admin/event-editor.html?id= | js/admin/events.js | Media, Details (cover mode), Publishing (status, schedule, share link, delete) |
| admin/upload.html?event=&folder= | js/admin/upload-page.js | Batch upload with progress, retry, cancel, resume |
| admin/account.html | js/admin/account.js | My account (hosts and the owner): change name, change password (current password asked first) |
| admin/super.html | js/admin/super.js | Owner dashboard: numbers, R2 budget, sign-up switch, links to what needs attention |
| admin/hosts.html | js/admin/hosts.js | Owner: all hosts, search, status filter, approve |
| admin/host.html?id= | js/admin/host.js | Owner: one host. Suspend/restore host, message, add storage, suspend/restore any reported or suspended event, report history, conversations |
| admin/reports.html | js/admin/reports.js | Owner: open reports and history (a dismissed report can still lead to suspending the event again) and all suspended events |
| admin/conversations.html | js/admin/conversations.js | Owner: conversations with hosts, open and history. `?c=<id>` opens one |

## Modules
- `js/config.js` API URL, Supabase URL and public key (the only file to edit).
- `js/supabase.js` sign in, refresh, sign out, session in localStorage, cross-tab sign-out.
- `js/api.js` `get/post/patch/del`, adds the token, refreshes once on 401, throws `ApiError {status, code, message, details}`.
- `js/admin/auth.js` `requireAdmin()` guard (calls `/admin/me`), header, `ROUTES` for page links.
- `js/admin/super-shared.js` actions shared by the owner pages (suspend/restore, messages, add storage, conversation window).
- `js/admin/folders.js` media browser (nested folders, covers, selection, move, delete) and `pickFolder()`.
- `js/admin/uploads.js` `UploadManager` engine and the upload page.
- `js/admin/thumbs.js` browser-made JPEG previews (images and video frames). Originals are never touched.
- `js/ui.js`, `js/util.js`, `js/icons.js` dialogs, toasts, DOM helper (`h()` never uses innerHTML), formatting, SVG icons.

## Behaviour worth knowing
- Backend stays authoritative. The UI only hides controls; every call is checked by the Worker.
- Times: shown and entered in Nairobi time (EAT, UTC+3), sent to the API as UTC.
- Uploads: up to 3 files at once (2 on phones). Photos and videos up to 50 MB go as one PUT, larger videos as 16 MB parts, 3 in parallel. Failed parts retry with backoff; expired URLs are refreshed.
- Resume: the session id of each unfinished upload is remembered in the browser. Pick the same file again (even after a reload) and only the missing parts are sent.
- Previews: HEIC and other formats the browser cannot decode upload without a preview (shown as an icon, noted in the list).
- Covers: select a file in the media browser and choose Set as cover (event or any folder above it). Folders can go back to automatic from the folder menu.
- Delete event: confirmation explains the 7 day recovery. A pending deletion shows a banner with the deadline and a Restore button, and editing is disabled.
- Icons are inline SVG. No emoji.

## Security notes
`_headers` adds a strict Content-Security-Policy for `/admin/*` (scripts and styles only from the site itself; network only to Supabase, workers.dev and R2). If you later use a custom domain for the Worker or R2, add it to `connect-src` and `img-src`. `Referrer-Policy: no-referrer` applies to the whole site so share-link tokens are never sent to other hosts.

## Choosing a video thumbnail
Open a video (tap it, then the file's details) and tap **Choose thumbnail** (or **Change thumbnail**), or select one video and tap **Thumbnail** in the bar. A window plays the video: slide to the moment you want, fine-tune with -1s / -0.1s / +0.1s / +1s, then **Use this frame**. The frame is saved as a JPEG of about 480 px and replaces the old thumbnail everywhere, including the share-link preview. The browser must be able to play the video (MP4 H.264 or WebM works everywhere; HEVC .mov only in some browsers). Needs the R2 bucket CORS from SETUP.md step 2.

Automatic thumbnails at upload now wait for the first real frame, skip black opening frames and allow up to 25 seconds for large videos. If one still cannot be made, the upload list says so and you can choose one by hand afterwards.
