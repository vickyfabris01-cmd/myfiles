# Zip 2: sort by date, duplicate warning, password reset, PWA

## What changed
- **Sort by date** (the only sort). Visitors and hosts see one control, "Date: newest first / oldest first", default newest first.
  The system sorts by the date the photo/video was TAKEN (read in the browser from the photo's EXIF, or the MP4/MOV header).
  Files with no date (for example photos forwarded on WhatsApp) sort by upload time. Files uploaded before this zip have no
  stored date, so they keep sorting by upload time. Downloads ("download all") follow the same order. The old "Filename" sort is gone.
- **Duplicate warning** on the upload page. It only compares with the place the files are going to: the chosen folder, or the event's
  top level when no folder is chosen (subfolders and other folders are not looked at). Quick check: same name and size.
  Photos also get an exact check (SHA-256 of the bytes), so a renamed copy is caught. Videos use the quick check only.
  The host chooses: Skip duplicates / Upload anyway / Cancel. Picking the same file twice in one selection is also flagged.
- **Password reset**: "Forgot your password?" on the sign-in page, then a page to set the new password.
- **PWA**: the site can be installed on phones and computers (icon, full-screen window, "Install app" button in the host header; on iPhone the
  button shows the Add-to-Home-Screen steps). Pages and scripts open offline from a saved copy; the API, Supabase and your files are never saved.
  Uploading still needs a connection. Guests opening a share link are not offered an install.
- **Bug fix from zip 1**: the storage bars (host storage page, dashboard, super admin) set their width with an inline style, which the
  page's content-security policy blocks. They now set it the allowed way.

## What you must do (in this order)
1. **Supabase > SQL Editor**: run `database/migrations/005_date_taken_and_duplicates.sql` once (after 003 and 004).
2. **Supabase > Authentication > URL Configuration > Redirect URLs**: add the reset page address, e.g.
   `https://YOUR-SITE.pages.dev/admin/reset.html`. Without this the reset email link will not open the page.
3. Unzip over the repo, deploy the Worker (`npx wrangler deploy`) and push the site as usual.
4. Hard-refresh once (or close and reopen the tab) so the browser picks up the new service worker.
5. Test the checklist below.

## Good to know
- Reset emails use Supabase's built-in sender, so the same hourly email limit applies as for sign-up confirmation.
- Date taken is read from the first 256 KB of a photo and from the header of an MP4/MOV, so nothing large is read. EXIF times carry no
  time zone unless the camera wrote one; those are treated as East Africa Time (+03:00).
- To make every device throw away saved copies after a big change, bump `VERSION` in `sw.js`.
- The PWA start page is `/admin/` (sign-in or the host's home). Public galleries stay ordinary web pages.

## How it was tested
- `005` was run on PostgreSQL 16 on top of 003: dated and undated files order correctly, a bad hash is rejected, and the old
  `reserve_upload` is replaced by the new one.
- `npm test` (all offline): worker/unit/isolation (now also covering date taken, hash storage and the scoped duplicate check, including
  that another host cannot call it), the EXIF/MP4 date reader on real files, the browser duplicate logic, the reset plumbing, and the
  PWA manifest, icons and the service worker's caching rules (it never intercepts the API, Supabase, R2, private gallery pages or uploads).
- NOT tested here: a real phone or browser (install prompt, offline mode, the dialog screens), and the live Supabase reset email.

## Click-through checklist
- [ ] Gallery (host and public): the only sort is "Date"; newest first by default; the toggle flips it.
- [ ] Upload a photo taken a year ago and a photo taken today: they sort by when they were taken, not when uploaded.
- [ ] Upload the same photo again into the same folder: you get the duplicate dialog. Rename it and try again: still caught (photos).
      Upload it into a different folder, or at the top level: no warning.
- [ ] "Forgot your password?" sends an email; the link opens the new-password page; the new password works to sign in.
- [ ] On a phone: "Install app" (or Add to Home Screen) works; the app opens full screen; turn on airplane mode and open it: the offline page or saved page shows.
