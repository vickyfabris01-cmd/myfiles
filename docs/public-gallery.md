# Public gallery (Dev 3)

Visitors open `https://<site>/e/<TOKEN>`. Cloudflare Pages serves `event.html` for every `/e/*` (see `_redirects`). No login, no accounts. For local testing `event.html?t=TOKEN` also works.

## Files
| File | Purpose |
|---|---|
| event.html | Page shell (absolute asset paths because the URL is `/e/TOKEN`) |
| js/public/event.js | Validates the link, shows the hero, handles unavailable / removed / invalid states |
| js/public/gallery.js | Folders, justified photo/video grid, search, filter, sort, lazy loading, pagination, selection |
| js/public/folders.js | Breadcrumbs and folder cards (cover + two recent previews) |
| js/public/viewer.js | Full-screen viewer: next/previous, zoom, pan, pinch, swipe, video playback |
| js/public/downloads.js | Sequential download queue and download panel |
| js/public/api.js | Visitor API client (no auth) |
| css/gallery.css, css/viewer.css | Styling (shares tokens from css/global.css, light and dark) |

## Behaviour
- **Link states:** invalid link, unpublished, and removed events each get a clear message and reveal nothing about the event.
- **Folders:** nested navigation with breadcrumbs, the browser Back button goes up one level, the URL keeps `?f=<folder>` so a folder can be shared. Empty folders never appear. Events without folders show their files directly.
- **Grid:** rows fill the screen width and keep each photo's shape. Thumbnails load lazily. 60 files per page; the next page loads automatically when you scroll near the end (a Load more button is always there too).
- **Search / filter / sort:** filename search covers the whole event; All / Photos / Videos; Newest, Oldest, Filename.
- **Viewer:** the thumbnail appears instantly and the original replaces it when loaded. Zoom with the wheel, pinch, double tap, buttons or `+ - 0`; drag to pan; swipe or arrow keys to move; Esc or Back to close. Videos use the native player with seeking (HTTP Range) and recover if the signed link expires mid-playback. Filename, size, dimensions and a download button are always shown.
- **HEIC and other formats a browser cannot show:** the viewer keeps the preview and offers the original for download.

## Link previews (WhatsApp, Telegram, Slack, iMessage)
Crawlers do not run JavaScript, so `functions/e/[[path]].js` (a Pages Function) serves `event.html` for every `/e/<TOKEN>` with the title, description and image already in `<head>`. It reads them from the Worker route `GET /event/:token/preview`.

The preview image is one 1200x630 collage: the event cover (large, left) plus the two most recent photos stacked on the right. A video uses its thumbnail. With fewer than three usable files the layout becomes cover + one tile, or the cover alone. Files a crawler cannot show (a video or HEIC without a thumbnail) are skipped.

- Built by `GET /event/:token/og.jpg` using the Cloudflare Images binding (`IMAGES` in `wrangler.jsonc`), cached in R2 as `events/<id>/og.jpg` and rebuilt only when the cover or the two newest files change (the `?v=` in the URL changes too, which makes crawlers refetch).
- Without the binding, or if it fails, the cover's small thumbnail is served instead.
- Unpublished, deleted or unknown links get no preview tags at all.
- After deploying, test with `https://<worker>/event/<TOKEN>/og.jpg`. WhatsApp and Facebook cache previews, so for an already-shared link use the Facebook Sharing Debugger ("Scrape again") or add a throwaway `?x=1` to the link.

## Downloads (no ZIP, always one file at a time)
Single file: the browser downloads the original directly.
Selected files, a folder (with subfolders) or the whole event go through the queue, with progress, saved count, remaining count, Cancel and Retry. You can hide the panel and keep browsing; a button at the bottom reopens it.

How each file is saved, best first:
1. **Save to a folder** (desktop Chrome / Edge): streamed to disk with exact progress and no browser prompts.
2. **Tracked download** for files up to 100 MB (all photos, most videos): exact progress; files are saved one after another.
3. **Tap to save** for larger videos without a folder, or if tracked downloading keeps failing: the queue pauses and the browser's own download manager takes over after one tap. This avoids browser restrictions on automatic multiple downloads.
4. **Ask before each file** option for browsers that block multiple downloads.

Expired links are refreshed automatically; network errors retry with backoff. Identical filenames are saved as `name (2).jpg` so nothing is overwritten.

## Requirements
- R2 bucket CORS must allow `GET` and expose `Content-Length` for your Pages URL (already in `r2-cors.json`). Without it tracked downloads fall back to tap to save.
- `_headers` adds a strict Content-Security-Policy and `noindex` for `/e/*`, plus `Referrer-Policy: no-referrer` for the whole site so share-link tokens never leak.
