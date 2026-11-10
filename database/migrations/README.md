# Migrations
001_init.sql is the full initial schema (same as schema.sql).
Every later change goes in a new numbered file (002_*.sql, ...) and schema.sql is updated to match.

## Public hosting (step 1)
`003_public_hosting.sql` turns the single-owner app into a many-host service (accounts, ownership, quotas, recycle bin for
folders and files, suspension, reports). Run it ONCE, after `schema.sql` and `002`. Read the STEPS at the top of the file first.
