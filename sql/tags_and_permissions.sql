-- 给 collections 表加「标签」和「使用权限」四个字段：
--   tags             jsonb   标签数组，例如 ["猫猫","日常"]
--   allow_repost     boolean 是否允许二传
--   allow_edit       boolean 是否允许二改
--   other_permission text    其他自定义权限说明
--
-- 全部带 DEFAULT，且用 ADD COLUMN IF NOT EXISTS，所以：
--   1. 已发布的旧数据不会因为多出这几列而报错，读到的都是安全默认值
--      （tags=[]、allow_repost=false、allow_edit=false —— 等价于"禁止二传二改"）。
--   2. 这段脚本可以重复执行，不会因为列已存在而报错。
--
-- 用法：登进 Supabase 项目 -> SQL Editor -> 粘贴整段执行一次即可。
--
-- 注意：collections_with_stats 是这个项目里已经建好的视图（给作品列表拼
-- 作者昵称/头像/点赞数用），不在这个仓库里维护。给 collections 表加列不会
-- 自动出现在这个视图里，所以前端（index.html 的 loadCollections）改成了
-- 单独从 collections 原表按 id 查这四列再拼回去，没有改动这个视图，也就
-- 不需要在这里重建它。
-- 如果执行完发现：自己发布的作品能看到标签/权限，但别人发布的看不到
-- （变回了默认值），说明 collections 表上的 SELECT 策略只放行"本人的行"。
-- 这时候把下面这条按需取消注释执行一下即可（跟 emojis / image_assets 这些
-- 表一样，允许所有登录成员读取全部行，是本项目一直以来的策略风格）：
--
-- drop policy if exists "collections: members can read all" on public.collections;
-- create policy "collections: members can read all"
--   on public.collections for select
--   using (true);

alter table public.collections add column if not exists tags jsonb not null default '[]'::jsonb;
alter table public.collections add column if not exists allow_repost boolean not null default false;
alter table public.collections add column if not exists allow_edit boolean not null default false;
alter table public.collections add column if not exists other_permission text not null default '';
