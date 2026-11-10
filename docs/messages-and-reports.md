# Reports, suspensions and messages

## Reports (visitor side)
Every event page has a Report link, and the viewer has a flag button. A visitor chooses the whole event, the current folder, or one
photo/video (optional), and writes a reason. Naming a file lets the owner open that one file; the dialog and the Terms/Privacy say so.
`POST /event/:token/report { reason, folder_id?, file_id? }`. Names are copied onto the report when it is sent.

## Reports (owner side)
The dashboard shows: event name, host name and email, folder, file, reason. While a report is open ("Held for review"),
**View file** opens that one file through `GET /super/reports/:id/media` (a 10-minute link). Each opening is counted on the report.
Closed reports cannot open the file.

## Suspension is never silent
Suspending or restoring an event or an account always sends the host a message (the owner can edit the text; a standard text is
used if none). If the notice cannot be saved, the suspension still stands and the dashboard warns the owner.
The owner can lift an event suspension from the **Suspended events** list without needing the old report.

## Conversations
* Only the owner starts (`POST /super/conversations`) and closes (`POST /super/conversations/:id/close`) a conversation.
* The host reads and replies in **Messages** (`/admin/conversations...`), also while suspended or pending.
* A closed conversation is kept as history; the database refuses new messages on it. Limit: 200 messages per conversation.
* No emails are sent; hosts see an unread badge in the menu.

## Deploy order
1. Run `004`, `005`, `006` in the Supabase SQL editor (skip those already run).
2. Deploy the Worker (`cloudflare/worker`).
3. Deploy the site (Cloudflare Pages).
