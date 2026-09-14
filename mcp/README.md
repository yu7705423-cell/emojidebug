# Yoww MCP 接口

给接了 MCP 的 AI 前端（Cherry Studio / Chatbox / LobeChat / SillyTavern 之类）用的。
用户不用再「从 Yoww 导出、再导入到那边」，直接跟 AI 说「找几个笑死的表情」，
AI 自己来站里按描述词搜，拿到图片直链发出来。

这是一个**跟主站完全分开**的 Worker。分开部署是故意的 ——
这边挂了、被打了、被下掉了，yoww2026.cn 一点事没有。

## 上线要做的三件事

1. **跑 SQL。** 把 `mcp_tokens.sql` 整份贴进 Supabase 的 SQL Editor 跑一遍（可以重复跑）。
   不跑的话站里那个「MCP 接口」页会显示「还没开通」，其余功能不受影响。

2. **部署 Worker。** 在这个目录里：

   ```
   npx wrangler deploy
   ```

   没有任何依赖，不用 `npm install`。

3. **绑域名。** Cloudflare 后台 → Workers → `yoww-mcp` → Settings → Domains & Routes
   → 加一个自定义域名 `mcp.yoww2026.cn`。

绑完访问 `https://mcp.yoww2026.cn/` 会看到一页给用户看的配置说明，
`https://mcp.yoww2026.cn/health` 用来确认活着。

## 用户怎么配

站里「我的 → MCP 接口」生成令牌（**只显示一次**），然后在 AI 前端里加一个
MCP 服务，类型选 **Streamable HTTP**：

- 地址 `https://mcp.yoww2026.cn/mcp`
- 请求头 `Authorization: Bearer <令牌>`

有些前端只能填地址加不了请求头，那就填 `https://mcp.yoww2026.cn/mcp/<令牌>`。

## 安全上的两条底线

改这些文件的时候别破坏这两条：

1. **这个 Worker 手上没有任何特权凭证。** 只有一把 anon key，那把 key 本来就写在
   index.html 里人人可见。真正的校验在数据库里 —— 每个内容函数第一个参数就是用户令牌，
   光有 anon key 什么都读不到。**永远不要**把 `service_role` 放进来。

2. **这套接口能表达的东西只有「站内公开作品」。** 留言、通知、我的仓库、成员名单
   在数据库里没有对应的函数 —— 不是「忘了做权限」，是根本没有这条路。
   就算这个 Worker 整个被人拿走，泄露的也只是任何一个成员本来就看得见的内容。

其余的：令牌库里存的是 sha256，原文只在生成那一次返回；撤销、过期、封号都会让它立刻失效；
每人最多同时留 5 个；接口全部只读，发不了作品也删不了东西。

## 有哪些工具

| 工具 | 干嘛的 |
| --- | --- |
| `search_emojis` | 按描述词搜单张表情图，返回「描述词 + 直链」。最常用的就是它 |
| `search_emoji_packs` | 搜整包，返回标题 / 作者 / 张数 / 使用权限 / 站内链接 |
| `get_emoji_pack` | 按 id 取一个包的全部图，顺序跟站上一致 |
| `list_categories` | 看有哪些分类 |
| `search_fonts` | 搜字体 |
| `whoami` | 验一下令牌通不通 |

每个返回里都带着作者标的 `allow_repost` / `allow_edit` / `other_permission`，
并且在 `instructions` 里明确要求 AI 照实说、不要替作者做主。

## 本地怎么测

`mcp.e2e.mjs` 那套测试直接 import 这个模块，用真的 `Request` / `Response` 打一遍
握手 → tools/list → tools/call，后端指向一个把 Supabase RPC 转成真 SQL 的小转发器。
改完 `src/index.js` 记得重跑。
