-- 006_messages.sql  -  SUSPENSION NOTICES AND ADMIN-STARTED CHAT
-- Run ONCE in the Supabase SQL Editor, after 005. Safe to re-run.
--
-- A conversation is one thread between the super admin and ONE host (about an event, an account, or anything else).
--  * Only the super admin starts a conversation and only the super admin closes it.
--  * While it is open the host can reply. Once it is closed nobody can add to it, but it is kept for history.
--  * Messages can never be edited or deleted (a database trigger enforces it). The only way they go away is when
--    a host deletes their whole account.

-- ============================================================ tables
create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  host_id         uuid not null references profiles(user_id) on delete cascade,
  event_id        uuid references events(id)  on delete set null,
  event_title     text,                                   -- the title when the conversation started, kept even if the event is renamed
  report_id       uuid references reports(id) on delete set null,
  kind            text not null default 'general' check (kind in ('event_suspended', 'account_suspended', 'general')),
  subject         text not null check (char_length(subject) between 1 and 150),
  status          text not null default 'open' check (status in ('open', 'closed')),
  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,
  last_message_at timestamptz not null default now(),
  last_sender     text check (last_sender in ('super_admin', 'host')),
  last_preview    text,
  host_seen_at    timestamptz,                            -- when the host last opened it (for the "new" marker)
  super_seen_at   timestamptz,
  check ((status = 'closed') = (closed_at is not null))
);
create index if not exists conversations_host_idx on conversations (host_id, last_message_at desc);
create index if not exists conversations_open_idx on conversations (last_message_at desc) where status = 'open';
create index if not exists conversations_event_idx on conversations (event_id) where event_id is not null;

create table if not exists conversation_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender          text not null check (sender in ('super_admin', 'host')),
  body            text not null check (char_length(body) between 1 and 2000),
  created_at      timestamptz not null default now()
);
create index if not exists conversation_messages_idx on conversation_messages (conversation_id, created_at);

-- ============================================================ history is kept
-- No message can be added to a closed conversation, and no message can be edited or deleted.
-- (Deleting a host account removes their conversations, and their messages with them: the parent row is already gone then.)
create or replace function conversation_messages_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from conversations where id = new.conversation_id and status = 'closed') then
      raise exception 'This conversation is closed';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from conversations where id = old.conversation_id) then
    return old;
  end if;
  raise exception 'Messages are kept for history and cannot be changed or deleted';
end $$;

drop trigger if exists conversation_messages_guard on conversation_messages;
create trigger conversation_messages_guard before insert or update or delete on conversation_messages
  for each row execute function conversation_messages_guard();

-- ============================================================ super admin view: events that are currently suspended
-- One row per suspended event, so a suspension can be lifted without hunting for an old report.
drop function if exists super_suspended_events();
create function super_suspended_events()
returns table (event_id uuid, host_id uuid, host_email text, host_name text, event_title text,
               suspended_at timestamptz, suspend_reason text, conversation_id uuid)
language sql stable set search_path = public as $$
  select e.id, e.created_by, p.email, p.display_name, e.title, e.suspended_at, e.suspend_reason,
         (select c.id from conversations c where c.event_id = e.id and c.status = 'open' order by c.opened_at desc limit 1)
    from events e join profiles p on p.user_id = e.created_by
   where e.suspended_at is not null and e.deleted_at is null
   order by e.suspended_at desc
$$;

-- ============================================================ security (same block as 003 / 004)
alter table conversations         enable row level security;
alter table conversation_messages enable row level security;
revoke all on conversations, conversation_messages from anon, authenticated;
grant all on conversations, conversation_messages to service_role;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- Check:  select count(*) from conversations;   select * from super_suspended_events();
