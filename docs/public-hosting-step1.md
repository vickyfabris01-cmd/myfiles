# Public hosting - step 1 (core)

## What this step adds
- **Accounts**: public email + password sign-up (Supabase sends the confirmation email). Each account has a status:
  `pending`, `active` or `suspended`. A switch in the super admin dashboard decides whether new accounts start pending (ON) or active (OFF).
- **Roles**: `host` (owns events), `super_admin` (manages the system, has no events, cannot upload).
- **Privacy / isolation**: every host route checks that the event, folder, file, upload session or bin item belongs to the caller
  (`cloudflare/worker/owner.js`). Someone else's item answers 404, exactly like a missing one.
- **Limits**: 2 GB per host (stored files + recycle bin + uploads in progress), 5 active events, 500 MB per video, 20 MB per photo.
  Space is reserved atomically in the database before an upload starts (`reserve_upload`).
- **Recycle bin (2 days)** for events, folders and files, each with its own timer. A folder (with its subfolders and files) is one bin item.
- **Host storage page** (usage bar, per-event usage, delete my account) and **host recycle bin page**.
- **Super admin dashboard**: totals, R2 budget, approval switch, host list (email, status, events, storage), approve / suspend / restore,
  add storage (limited by R2 space left), and in-app **reports**.
- **Public event page**: "Report this event" link, Terms and Privacy pages.
- **Suspension**: suspending a host or an event switches their links off at once; uploads stop at once; data is kept.

## What you must do (in this order)
1. **Supabase > Authentication > Users > Add user**: email `vickyfabris01@gmail.com`, a strong password, tick *Auto Confirm User*.
2. **Supabase > SQL Editor**: paste and run `database/migrations/003_public_hosting.sql`. Then run `select email, role, status from profiles;`
   You should see your old login as `host / active` and vickyfabris01@gmail.com as `super_admin / active`.
3. **Supabase > Authentication > URL Configuration**: set *Site URL* to your Pages address (for example `https://myfiles-8cc.pages.dev/admin/index.html`)
   and add it under *Redirect URLs*. Without this the confirmation email link goes to the wrong place.
4. **Supabase > Authentication > Providers > Email**: keep *Confirm email* ON. Keep *Enable sign ups* ON.
5. **Supabase > Authentication > Rate Limits**: lower the sign-up / sign-in limits if you like. This is the sign-up flood protection until
   Turnstile is added (sign-up goes straight from the browser to Supabase, not through the Worker).
6. Unzip this over the repo, then deploy the Worker (`npx wrangler deploy` as usual) and push the site files to Pages as usual.
7. Sign in as vickyfabris01@gmail.com: you land on the super admin dashboard. Set your **R2 budget** (a number you choose, for example 10 GB).
8. Test with a second email: sign up, confirm, see the "Waiting for approval" screen, approve it from the super admin dashboard.

## Good to know
- Supabase's built-in email sender is heavily rate limited (a few emails per hour). If many people sign up at once, confirmation emails will be delayed
  or refused. That is the moment to connect your own email service (Supabase > Project Settings > Authentication > SMTP Settings).
- The existing hike event (647 MB) stays with your current login. Its share link is unchanged.
- `npm test` runs `tests/unit.mjs` and `tests/isolation.mjs` (offline, no keys needed).
- Not built, by your decision: Turnstile bot check, Google sign-in, email notifications for reports. Placeholders with steps are in `js/admin/signup.js`.
- No password reset page yet (Supabase can send reset emails, but there is no page to set the new password). Worth adding before launch.
- Links to a deleted/suspended event show the same "not available" page; the host list shows hosts by email only.

## How it was tested
- `database/migrations/003_public_hosting.sql` was run on a real PostgreSQL 16 on top of `schema.sql` with sample data. Checked: backfill,
  5-event limit, binned events not counting, restore blocked at 5, quota with bin + pending uploads, host B unable to reserve into host A's event,
  folder bin groups, `bin_items`, same-name folder while one is binned, super views, and that `anon` cannot execute any function.
- `tests/isolation.mjs` runs the real Worker against an in-memory Supabase and R2: 94 checks, including host B attacking every host route
  against host A's event, folder, file, upload session and bin items (all 404, database and R2 unchanged), roles and statuses, quota messages,
  recycle-bin rules, reports, suspension, and account deletion.
- NOT tested here: the live Supabase, R2 and Cloudflare, and the screens in a real browser. Please click through them once (checklist below).

## Click-through checklist after deploying
- [ ] Sign up with a new email, confirm, see "Waiting for approval", approve from super admin, then create an event and upload.
- [ ] As that new host, you cannot see the hike event; your own list only shows your events.
- [ ] Upload a video over 500 MB: refused with a clear message. Create a 6th event: refused with a clear message.
- [ ] Delete a file, a folder, an event: each appears in the Bin with a 2-day timer; restore each; check "Restore the event first".
- [ ] Storage page shows the bar and per-event sizes. Super admin never shows titles.
- [ ] Report an event from its public page; it appears in the super admin dashboard; suspend it; the link stops; undo.
