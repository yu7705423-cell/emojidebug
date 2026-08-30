# img-proxy —— 让分享卡片能画出外链图片

## 解决什么问题

生成分享卡片用的是 html2canvas，它取每一张图时都会带 `crossOrigin='anonymous'`。
图床只要不返回 `Access-Control-Allow-Origin` 响应头，浏览器就会拦掉这次请求 ——
而且是**静默失败**：不抛异常，只是把那一格画成空白，卡片"生成成功"但没有图。

这是浏览器的安全边界，纯前端绕不过去：

- `fetch()` 同样会被 CORS 拦；
- 不带 `crossOrigin` 加载虽然能显示、也能画上画布，但画布会被标记为"已污染"，
  之后 `toBlob()` / `toDataURL()` 直接抛异常，连导出都做不成，比现在更糟。

所以只能由服务端代取一次，再带上 CORS 头吐回来。

## 部署

```bash
supabase functions deploy img-proxy --no-verify-jwt
```

**`--no-verify-jwt` 是必须的。** 这个地址要被 `<img crossorigin>` 直接加载，
而 `<img>` 标签没办法附带 `Authorization` 请求头，开着 JWT 校验就永远 401。

部署完不用改前端：`index.html` 里的地址是从 `SUPABASE_URL` 拼出来的
（`<SUPABASE_URL>/functions/v1/img-proxy`），部署上去就自动生效。

## 前端怎么用它（重要）

前端**不是**把所有图都塞给代理，而是逐张判断：

1. 先按 html2canvas 的方式试直连。图床本身就允许跨域的，直接用原图，
   **不占用你的代理流量**；
2. 直连不行，才换成代理地址再试；
3. 代理也不行（比如这个函数还没部署），就记一笔"这张画不出来"，
   卡片照常生成，并弹出提示告诉用户有几格是空的。

所以**没部署这个函数也不会让事情变得更糟**——效果就是现在的样子。

## 安全防护

因为必须 `--no-verify-jwt`，这个地址是公开的。一个不加限制的图片代理
= 任何人都能拿你的 Supabase 转发任意流量（烧掉你的流量额度），
甚至用来探测内网。所以下面几道防护一个都不能省：

| 防护 | 作用 |
|---|---|
| **数据库白名单** | 只代理库里真实存在的图片地址（`image_assets.source_url` / `users.avatar_url` / `fonts.bg_image`）。这一条最关键，它让这个接口没法被当成通用代理用 |
| 协议限制 | 只允许 `http` / `https` |
| 私有网段拦截 | 挡掉环回、`10.x`、`172.16-31.x`、`192.168.x`、链路本地（含云厂商元数据地址 `169.254.169.254`）等 |
| 真实 DNS 解析 | 只看域名字面量挡不住 `evil.com` 解析到 `127.0.0.1`，所以会真解析一次再检查 |
| 跳转逐跳校验 | 自己跟跳转、每一跳重新校验。交给 `fetch` 自动跟的话，一个 302 到内网就把前面的检查全绕过去了 |
| 类型 / 体积限制 | 响应必须是 `image/*`，单张上限 8MB |
| 缓存头 | 同一张图会被反复请求，让 CDN 和浏览器扛住，别每次都真去取 |

### 如果你想放宽白名单

白名单靠三次 `select ... limit 1` 实现。如果以后图片来源变多（比如新增了表），
记得在 `isKnownImage()` 里补上对应的查询，否则那些图会返回 403。

反过来，如果你确定要让它代理任意地址，把 `isKnownImage()` 的调用删掉即可 ——
**但那样它就是一个公开的开放代理了**，请先想清楚流量和滥用风险。

## 自检

```bash
# 库里真实存在的图 -> 200，且带 Access-Control-Allow-Origin
curl -sS -D - -o /dev/null "https://<你的项目>.supabase.co/functions/v1/img-proxy?url=<库里的图片地址>"

# 库里没有的地址 -> 403 unknown image
curl -sS "https://<你的项目>.supabase.co/functions/v1/img-proxy?url=https://example.com/a.png"

# 内网地址 -> 400 url not allowed
curl -sS "https://<你的项目>.supabase.co/functions/v1/img-proxy?url=http://127.0.0.1/a.png"
```
