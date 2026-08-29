-- 点赞提醒功能需要的表。
-- 这个仓库里没有其余表的建表脚本（likes / favorites / collections / fonts / users
-- 都是直接在 Supabase 后台建的），所以这里只能照着现有表的常见写法来推测列类型和
-- RLS 策略；如果和你项目里 users / collections / fonts 表的主键类型、策略风格不一致，
-- 照着改一下就行，思路不变：谁登录了都能读自己收到的通知、只能替自己写通知、
-- 只能把自己收到的通知标记已读。
--
-- 用法：登进 Supabase 项目 -> SQL Editor -> 粘贴整段执行一次即可。

create table if not exists public.notifications (
  id           bigint generated always as identity primary key,
  recipient_id uuid not null references public.users(id) on delete cascade,
  actor_id     uuid not null references public.users(id) on delete cascade,
  -- 昵称在点赞那一刻就存一份快照，通知列表就不用再去 join users 表读对方昵称
  -- （其他表也没有专门给"任意用户"用的公开视图，省得再申请一次读权限）。
  actor_nickname text,
  type         text not null default 'like',
  -- collections.id 是 uuid（不是 bigint）——上一版猜错了类型，建表时报了外键
  -- 类型不匹配的错。fonts.id 大概率也是 uuid（跟 users.id 一个套路），如果这行
  -- 也报同样的错，把 uuid 换成 bigint 再跑一次就行。
  collection_id uuid references public.collections(id) on delete cascade,
  font_id       uuid references public.fonts(id) on delete cascade,
  read         boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists notifications_recipient_idx
  on public.notifications (recipient_id, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists "notifications: recipient can read" on public.notifications;
create policy "notifications: recipient can read"
  on public.notifications for select
  using (auth.uid() = recipient_id);

drop policy if exists "notifications: actor can insert" on public.notifications;
create policy "notifications: actor can insert"
  on public.notifications for insert
  with check (auth.uid() = actor_id);

drop policy if exists "notifications: recipient can mark read" on public.notifications;
create policy "notifications: recipient can mark read"
  on public.notifications for update
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);
