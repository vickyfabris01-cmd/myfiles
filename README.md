# MyFiles (Dev 1: backend, database, storage, security)
Cloudflare Worker API + Supabase Postgres + private R2 bucket.
Start with SETUP.md. API for the frontend developers: docs/api-contract.md. Schema: docs/database.md.
Tests: `node tests/unit.mjs` (offline) and `node tests/smoke.mjs` (live, see SETUP.md).

## Administrator interface (Dev 2)
See docs/admin-ui.md. Before deploying, put your API URL, Supabase URL and publishable key in js/config.js. The Worker's ALLOWED_ORIGINS must include your Pages URL, and the R2 bucket CORS must allow it (SETUP.md).
