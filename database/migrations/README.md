# Migrations
001_init.sql is the full initial schema (same as schema.sql).
Every later change goes in a new numbered file (002_*.sql, ...) and schema.sql is updated to match.

## Public hosting (step 1)
`003_public_hosting.sql` turns the single-owner app into a many-host service (accounts, ownership, quotas, recycle bin for
folders and files, suspension, reports). Run it ONCE, after `schema.sql` and `002`. Read the STEPS at the top of the file first.

## Date taken and duplicate warning (zip 2)
`005_date_taken_and_duplicates.sql` adds the date a photo/video was taken, a "sort by date" column, and a photo content hash used
for the duplicate warning. Run it ONCE, after 003 and 004. It does not delete anything.

## Report details (004)
`004_report_details.sql` adds the host's display name and the details a report carries (event title, folder name, file name, how many
times the reported file was opened) and two new report/host list functions. Run it ONCE, after 003.

## Messages (006)
`006_messages.sql` adds `conversations` and `conversation_messages` (the owner's notices and chats with hosts about suspensions)
and `super_suspended_events()`. Run it ONCE, after 005. It does not delete anything and can be re-run safely.
Run order: 003, 004, 005, 006. Then deploy the Worker, then the site.

## Download names (007)
`007_download_names.sql` adds `media_files.name_is_custom` and extends `files_manifest`, so downloads are named `Event_Folder_YYYY-MM-DD-HH-MM-SS.ext` automatically (a file the host renamed by hand keeps that name). Run it ONCE, after 006 and BEFORE deploying the Worker. Run order: 003, 004, 005, 006, 007.
