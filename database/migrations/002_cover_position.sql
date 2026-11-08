-- 002: remember which part of the cover photo to show (0-100 %, 50 = centre)
alter table events        add column if not exists cover_pos_x real not null default 50 check (cover_pos_x between 0 and 100);
alter table events        add column if not exists cover_pos_y real not null default 50 check (cover_pos_y between 0 and 100);
alter table media_folders add column if not exists cover_pos_x real not null default 50 check (cover_pos_x between 0 and 100);
alter table media_folders add column if not exists cover_pos_y real not null default 50 check (cover_pos_y between 0 and 100);
