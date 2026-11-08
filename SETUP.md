# MyFiles backend setup (Dev 1)

You only replace credentials. Nothing else needs editing except the values in `wrangler.jsonc`.
Everything can be done from the Supabase and Cloudflare dashboards, so Termux is enough for the checks at the end.

## 1. Supabase
1. Create a project. Note: **Project URL**, the **publishable (or anon) key**, and the **secret (or service_role) key** (Project Settings > API).
2. SQL Editor > New query > paste all of `database/schema.sql` > Run.
3. Authentication > Users > Add user > email + password, tick "Auto Confirm User". This is your admin login.
4. SQL Editor, make that user an admin (replace the email):
```sql
insert into admins (user_id) select id from auth.users where email = 'you@example.com';
```
There is no signup. Only users listed in `admins` pass the Worker's check.

## 2. Cloudflare R2
1. R2 > Create bucket, name `myfiles-media`. Leave public access **off**.
2. R2 > Manage API tokens > Create API token > permission **Object Read & Write**, limited to that bucket. Note the **Access Key ID** and **Secret Access Key**.
3. Note your **Account ID** (R2 overview page, right side).
4. Bucket > Settings > CORS policy > add (use your real Pages URL from step 3):
```json
[
  {
    "AllowedOrigins": ["https://YOUR-PAGES-PROJECT.pages.dev", "http://localhost:8788"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```
Without this, browser uploads fail with a CORS error. (`r2-cors.json` is the same rule in the wrangler CLI format.)

## 3. Pages site (to get your URL)
Workers & Pages > Create > Pages > connect your GitHub repo. No build command, output directory `/`. Note the URL (`https://<name>.pages.dev`). The `_redirects` file already maps `/e/*` to `event.html`.

## 4. Edit `wrangler.jsonc` (the `vars` block)
| Var | Value |
|---|---|
| SUPABASE_URL | Project URL |
| SUPABASE_ANON_KEY | publishable / anon key (public by design) |
| R2_ACCOUNT_ID | Cloudflare Account ID |
| R2_BUCKET_NAME | `myfiles-media` |
| PUBLIC_SITE_URL | your Pages URL, no trailing slash |
| ALLOWED_ORIGINS | your Pages URL, plus the `https://*.<name>.pages.dev` pattern for previews |

## 5. Deploy the Worker
**Dashboard way (works from a phone):** Workers & Pages > Create > Import a repository > choose the repo. The Worker name must stay `myfiles-api` (it comes from `wrangler.jsonc`). Deploy command `npx wrangler deploy`. Pushing to the branch redeploys.

Then Worker > Settings > Variables and Secrets > add these four as **Secrets**:
| Secret | Value |
|---|---|
| SUPABASE_SERVICE_KEY | Supabase secret / service_role key |
| R2_ACCESS_KEY_ID | from step 2 |
| R2_SECRET_ACCESS_KEY | from step 2 |
| TOKEN_ENC_KEY | output of `openssl rand -base64 32` (Termux: `pkg install openssl`) |

Keep a private backup of `TOKEN_ENC_KEY`. If it is lost, visitors' links keep working, but you must regenerate links to copy them again.

**CLI way (PC):** `npm install`, `npx wrangler login`, then `npx wrangler secret put SUPABASE_SERVICE_KEY` (and the other three), then `npx wrangler deploy`. Wrangler often does not run on Termux/Android (its runtime has no Android build), so use the dashboard way there.

Check Worker > Settings > Triggers: two cron schedules should be listed (every minute for scheduled publishing, hourly for permanent deletion and upload cleanup).

## 6. Verify (works in Termux, needs Node 18+)
```bash
curl https://myfiles-api.YOUR-SUBDOMAIN.workers.dev/health
node tests/unit.mjs
API_URL=https://myfiles-api.YOUR-SUBDOMAIN.workers.dev \
SUPABASE_URL=https://YOUR-REF.supabase.co SUPABASE_ANON_KEY=... \
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... node tests/smoke.mjs
```
Add `BIG=1` in front of the last command to also test a 60 MB multipart upload. The smoke test creates an event, uploads a file, publishes, downloads it and compares bytes, tests HTTP Range, then deletes the event (it stays in the 7-day recovery list until purged).

## Troubleshooting
- Upload fails in the browser with a CORS error: the R2 CORS origin must exactly match the Pages URL.
- 401 on every admin call: expired session, or wrong `SUPABASE_URL` / `SUPABASE_ANON_KEY`.
- 403 `NOT_ADMIN`: the `insert into admins` step was not run for that user.
- 500 `DB_ERROR`: check Worker logs; usually a wrong `SUPABASE_SERVICE_KEY` or `schema.sql` not fully run.
- 409 `TOKEN_UNRECOVERABLE`: `TOKEN_ENC_KEY` changed. Use the regenerate-link endpoint.
- Rate limiting is best effort (per Worker instance). For a hard limit, add a Cloudflare WAF rate-limiting rule on the Worker URL.
- Never commit keys. If one leaks, rotate it in Supabase or Cloudflare and update the Worker secret.
