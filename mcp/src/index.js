/* Yoww MCP 接口
   ------------------------------------------------------------------
   给接了 MCP 的 AI 前端（Cherry Studio / Chatbox / LobeChat 之类）用的：
   用户不用再「从我们这儿导出、再导入到那边」，AI 直接按描述词搜图拿链接。

   这是一个跟主站完全分开的 Worker。分开部署是故意的 ——
   这边挂了、被打了、被下掉了，yoww2026.cn 一点事没有。

   安全上只有两件事要记住：
   1) 这里不存任何特权凭证。手上只有一把 anon key，那把 key 本来就写在
      index.html 里人人可见。真正的校验在数据库里：每个内容函数第一个参数
      就是用户令牌，没令牌什么都读不到。
   2) 这里能问数据库的问题，只有下面 tools 里列的那几个。留言、通知、
      我的仓库、成员名单没有对应的函数 —— 不是"忘了做权限"，是根本没这条路。
      就算这个 Worker 整个被人拿走，能拿到的也只是任何一个成员本来就看得见的东西。 */

const NAME = 'yoww';
// 每次改动都往上加一。线上到底跑的是不是最新的，
// 打开 /health 看这个数字就知道 —— Cloudflare 后台显示的是它自己的版本号，
// 跟提交号对不上，别拿那个判断。
const VERSION = '23';
const SITE = 'https://yoww2026.cn';

// 我们支持的协议版本，新的排前面。客户端报的版本认识就照它的来，
// 不认识就回我们最新的那个 —— 规范要求的就是这个行为。
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id, x-api-key',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
  'access-control-max-age': '86400',
};

/* 浏览器里跑的前端如果用 credentials:'include' 发请求，
   浏览器会直接拒收 allow-origin: * —— 必须原样回显它的 Origin，
   还要带上 allow-credentials。这种失败在控制台之外看不见任何东西，
   表现就是"连不上"，很容易被当成网络问题。
   我们的鉴权靠令牌不靠 cookie，回显 Origin 不带来任何风险。 */
function corsFor(req) {
  const origin = req.headers.get('origin');
  if (!origin) return CORS;
  return Object.assign({}, CORS, {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  });
}

/* ---------------- 工具定义 ----------------
   description 这几段是给模型看的，不是给人看的。写清楚"什么时候该调我"
   比写清楚"我是什么"重要得多。 */
const TOOLS = [
  {
    name: 'load_emoji_set',
    scope: 'emoji',
    title: '一次性载入一批表情备用',
    description:
      '在对话刚开始、或者用户说「用 Yoww 的表情」时，调用这个**一次**，' +
      '把一批表情连同描述词一次性载入。\n' +
      '之后你想发表情，直接从载入的这批里挑一行原样贴出去就行，**不用再调任何工具**——' +
      '就像你本来就带着一套表情一样，随时想发就发，不要因为"要先查一下"而放弃发表情。\n' +
      '不带 query 就是载入站里最新的一批（推荐，最省事）；' +
      '想要某个主题就带上 query（比如「猫」「摸头」）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '想要哪类表情；留空表示载入最新的一批，一般留空就行' },
        limit: { type: 'integer', description: '载入几张，默认 20，最多 40。**别往大了调** —— 有些前端会把每张图都预取一遍，一次给太多它会直接超时，什么都收不到' },
        format: { type: 'string', enum: ['markdown', 'url', 'html', 'both'],
                  description: '出图写法。**默认不要传** —— 服务端已经配好了这个环境认的写法。只有用户明确说「用 xxx 格式发」时才传。' },
      },
    },
  },
  {
    name: 'search_avatars',
    scope: 'avatar',
    title: '搜头像',
    description:
      '搜站里分享的头像，返回可以直接发出去的图。\n' +
      '用户说「找个头像」「有没有好看的情侣头像」「给你换个头像」时用。\n' +
      '情侣头像是一对两张，返回里会标出来（is_pair），两张要一起发，' +
      '并且说清楚哪张给谁 —— 比如「这对情头，左边给你右边给我」。\n' +
      '分类只有两个：普通（单张）、情侣（一对两张）。' +
      '性别、性向、风格这些是标签不是分类，写进 query 里搜' +
      '（比如「男」「BL」「冷白皮」「校园」）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '风格、标签或标题里的词；留空表示不过滤' },
        category: { type: 'string', enum: ['普通', '情侣'],
                    description: '只分单张和一对。想按性别/性向/风格找，写进 query 而不是这里' },
        limit: { type: 'integer', description: '最多返回几个，默认 8，最多 20' },
        format: { type: 'string', enum: ['markdown', 'url', 'html', 'both'],
                  description: '出图写法。**默认不要传** —— 服务端已经配好了这个环境认的写法。' },
      },
    },
  },
  {
    name: 'search_emojis',
    scope: 'emoji',
    title: '按描述词搜表情图',
    description:
      '按关键词在整个 Yoww 站里搜表情图片，返回的每张都带一行拼好的 ![](…)，' +
      '原样贴进回复就能把图发出去。' +
      '用户说「发个笑死的表情」「有没有猫猫无语的图」「来个表情」时就用这个，不要用 search_emoji_packs ——' +
      '那个不返回图片。' +
      '关键词用中文短词效果最好（比如「笑死」「无语」「摸头」），一次一个词，没搜到就换个近义词再试。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的词，比如「笑死」「猫」「摸头」' },
        limit: { type: 'integer', description: '最多返回几张，默认 8，最多 20。发表情一次挑一两张就够，别一次要一堆' },
        format: { type: 'string', enum: ['markdown', 'url', 'html', 'both'],
                  description: '出图写法。**默认不要传** —— 服务端已经配好了这个环境认的写法。只有用户明确说「用 xxx 格式发」时才传。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_emoji_packs',
    scope: 'emoji',
    title: '搜表情包',
    description:
      '按关键词、分类搜整包的表情包（不是单张图）。用户说「有什么猫猫表情包」「最近发了哪些包」' +
      '这种想看有哪些包时用。\n' +
      '返回每个包的标题、作者、张数、分类，并给前几个包附上几张预览图' +
      '（同样是拼好的 ![](…)，可以直接发）。想看某个包的全部图，再用 get_emoji_pack。\n' +
      '如果用户只是想要几张表情、并不关心是哪个包，用 search_emojis 更直接。\n' +
      '不管用哪个，都别拿一个站内链接当答复交出去 —— 用户要的是图。\n' +
      'query 留空就是按时间倒序列最新的。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，可匹配标题、作者、标签和包里的描述词；留空表示不过滤' },
        category: { type: 'string', description: '分类名，可先用 list_categories 看有哪些；留空表示不过滤' },
        limit: { type: 'integer', description: '最多返回几个，默认 20，最多 50' },
        offset: { type: 'integer', description: '翻页用，跳过前几个，默认 0' },
      },
    },
  },
  {
    name: 'get_emoji_pack',
    scope: 'emoji',
    title: '取一个表情包里的图',
    description:
      '按 pack_id 取一个表情包里的图片，顺序跟站上一致，每张都带一行拼好的 ![](…)，' +
      '原样贴进回复就能发出去。' +
      '用户说「把这个包都发出来」「这个包里有什么」时用。' +
      '默认只给前 24 张 —— 一次给太多，有些前端会因为逐张预取而超时，' +
      '那样用户一张都收不到。用户明确说「全都要」再把 limit 调大。' +
      '返回里带了使用权限（allow_repost / allow_edit / other_permission），' +
      '那是给「用户问能不能转载 / 能不能二次修改」时如实回答用的；' +
      '把图发给用户看不受它们限制，照发就行。',
    inputSchema: {
      type: 'object',
      properties: {
        pack_id: { type: 'string', description: 'search_emoji_packs 返回的 id' },
        limit: { type: 'integer', description: '取前几张，默认 24，最多 60。用户没明说「全都要」就别调大' },
        format: { type: 'string', enum: ['markdown', 'url', 'html', 'both'],
                  description: '出图写法。**默认不要传** —— 服务端已经配好了这个环境认的写法。只有用户明确说「用 xxx 格式发」时才传。' },
      },
      required: ['pack_id'],
    },
  },
  {
    name: 'list_categories',
    scope: 'emoji',
    title: '看有哪些分类',
    description: '列出站里所有表情包分类和各自的数量。不知道该往哪个方向搜的时候先调它。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'whoami',
    title: '看看令牌是谁的',
    description: '确认当前令牌有效，返回它属于哪个昵称。配好之后想验一下通不通就调它。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/* ---------------- 数据库 ---------------- */
async function rpc(env, fn, args) {
  let r;
  try {
    r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { ok: false, error: '连不上服务器，等一下再试' };
  }
  if (!r.ok) {
    // 400/404 基本都是数据库那边的 SQL 还没跑。别把原始报错抛给模型，
    // 它会当成"用户做错了什么"然后开始瞎猜。
    return { ok: false, error: r.status === 404 ? '服务端还没开通这个接口' : '服务端出错了（' + r.status + '）' };
  }
  try {
    const j = await r.json();
    return j && typeof j === 'object' ? j : { ok: false, error: '服务端返回了看不懂的内容' };
  } catch (e) {
    return { ok: false, error: '服务端返回了看不懂的内容' };
  }
}

/* 写法现在存在令牌上。地址永远是 /mcp 一个字不变 ——
   有些前端按"MCP 服务配置"算哈希拼进工具名，地址一改哈希就变，
   老对话里的调用记录跟新的对不上，整个对话直接报废。

   每次调用都去问一遍数据库太浪费，isolate 里缓存一分钟。
   改了写法最多一分钟生效，换来的是每次调用少一个来回。 */
const TOKEN_CACHE = new Map();
const TOKEN_TTL = 60000;
async function tokenCfg(env, token) {
  const hit = TOKEN_CACHE.get(token);
  if (hit && hit.at > Date.now() - TOKEN_TTL) return hit.v;
  const v = await rpc(env, 'mcp_token_info', { p_token: token });
  // 连不上时别把失败缓存起来 —— 否则服务器抖一下，这个令牌一分钟内都用不了
  if (v && (v.ok || v.error === 'invalid_token')) {
    if (TOKEN_CACHE.size > 500) TOKEN_CACHE.clear();
    TOKEN_CACHE.set(token, { at: Date.now(), v });
  }
  return v;
}

/* ---------------- 图片中转 ----------------
   站里大半表情图是大家从各家图床贴的链接，那些图床查 Referer ——
   index.html 里 12 处 <img> 都写了 referrerpolicy="no-referrer" 就是在绕这个。
   AI 前端的 Markdown 渲染器不会这么干，图床直接把它挡了，
   用户看到的就是一行 alt 文字加一个加载失败。

   所以图片不直接给原链接，给一条我们自己的地址，由这边去取 ——
   取的时候不带来路，图床就肯给。

   两点考虑：
   · 已经在我们自己图床上的图（新上传的那些）不中转，白费流量。
   · 地址带签名。不签的话这就是一个谁都能白嫖的图片代理，
     免费额度一天就能被刷干净，MCP 跟着一起挂。 */
const b64u = {
  enc: s => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => new TextDecoder().decode(Uint8Array.from(
              atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))),
};

// 密钥导一次就够了。原来每签一个地址都重导一次 —— 一次载入六十张图
// 就是六十次，白烧时间
let SIGN_KEY = null;
async function signKey(env) {
  if (!SIGN_KEY) {
    SIGN_KEY = crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.IMG_SIGN_KEY || 'yoww'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  return SIGN_KEY;
}
async function sign(env, text) {
  const mac = await crypto.subtle.sign('HMAC', await signKey(env), new TextEncoder().encode(text));
  return [...new Uint8Array(mac)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 时间恒定比较。签名校验用 === 会漏时序信息
function sameSig(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function proxyUrl(env, raw, origin) {
  const url = String(raw == null ? '' : raw).trim();
  if (!/^https?:\/\//i.test(url)) return url;
  // 所有图片一律走中转，一张都不直连。
  //
  // 本来为了省流量，自家图床上的图是直接给原链接的。但有些前端拿到 URL 后
  // 会用浏览器 fetch 那张图再转成字节（换头像就是这么干的），
  // 跨域 fetch 要求图片服务器回 CORS 头 —— 第三方图床不会回，
  // 自家桶回不回也要看桶的配置。走中转就一定有（下面 serveImage 里带着），
  // 而且顺带统一了后缀、绕掉了防盗链。省那点流量不值得赌这个。
  const payload = b64u.enc(url);
  // 强制 https：本地跑的时候 origin 可能是 http，那种地址贴进 https 的前端
  // 会被当成混合内容直接拦掉，又是一次"图加载失败"
  const secure = origin.replace(/^http:/, 'https:');
  // 结尾带个扩展名，有些渲染器按扩展名才认它是图。
  // 认不出原后缀时默认 png，不要默认 webp —— 不少前端判断"是不是图片"
  // 用的是老白名单（png|jpe?g|gif），里面根本没有 webp，
  // 一看后缀不认识就当纯文本，什么都不显示。
  // 后缀只是给它看的，真正的类型由我们回的 content-type 决定，所以不会出错。
  const ext = (/\.(png|jpe?g|gif|bmp|avif)(\?|#|$)/i.exec(url) || [, 'png'])[1].toLowerCase();
  return `${secure}/i/${await sign(env, payload)}/${payload}.${ext}`;
}

/* 把图提前烘进边缘缓存。

   光把张数砍下来还不够：前端逐张预取的时候，每一张都还是要我们现去
   第三方图床取一趟，慢的图床一张一两秒。所以在返回工具结果的同时，
   顺手在后台把这几张先取一遍 —— 用的 cf 选项跟 serveImage 里一模一样，
   落的是同一个缓存条目。等前端真来取的时候就直接命中，不用再等上游。

   几条自我约束：
   · 必须挂在 waitUntil 上。不挂，响应一发出去这些请求就被掐了。
   · 有配额。一个请求能发的子请求有上限，烘过头会把正事挤掉，
     所以每个请求最多烘这么多张，多出来的就让它冷着。
   · 必须真的把 body 读完，不然缓存条目写不完整，等于白烘。
   · 全程 catch 到底。烘失败是小事，绝不能影响给模型的那份结果。 */
const WARM_BUDGET = 12;
const WARMED = new WeakMap();
function warm(env, ctx, urls) {
  if (!ctx || typeof ctx.waitUntil !== 'function') return;
  let used = WARMED.get(ctx) || 0;
  for (const raw of urls || []) {
    if (used >= WARM_BUDGET) break;
    const u = String(raw == null ? '' : raw).trim();
    if (!/^https?:\/\//i.test(u)) continue;
    used++;
    try {
      ctx.waitUntil(
        fetch(u, {
          referrer: '', referrerPolicy: 'no-referrer',
          headers: { accept: 'image/*,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; YowwMCP/1.0)' },
          redirect: 'follow',
          signal: AbortSignal.timeout(10000),
          cf: { cacheEverything: true, cacheTtl: 86400 },
        }).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => {})
      );
    } catch (e) { /* ctx 已经关了之类的，烘不成就算了 */ }
  }
  WARMED.set(ctx, used);
}

// 一批图一起换成中转地址，顺手把取不到的丢掉
async function withProxy(env, list, origin, ctx) {
  const out = await Promise.all((list || []).map(async e =>
    Object.assign({}, e, { url: await proxyUrl(env, e.url, origin) })));
  warm(env, ctx, (list || []).map(e => e && e.url));
  return out;
}

async function serveImage(env, url, sig, payload) {
  if (!sameSig(sig, await sign(env, payload))) {
    return new Response('bad signature', { status: 403, headers: CORS });
  }
  let target;
  try { target = new URL(b64u.dec(payload)); } catch (e) { return new Response('bad url', { status: 400, headers: CORS }); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return new Response('bad scheme', { status: 400, headers: CORS });
  }

  let up;
  try {
    up = await fetch(target.toString(), {
      // 关键就是这一行：不带来路，图床才肯给
      referrer: '', referrerPolicy: 'no-referrer',
      headers: { accept: 'image/*,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; YowwMCP/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      cf: { cacheEverything: true, cacheTtl: 86400 },
    });
  } catch (e) {
    return new Response('upstream unreachable', { status: 502, headers: CORS });
  }
  if (!up.ok) return new Response('upstream ' + up.status, { status: 502, headers: CORS });

  const type = up.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) return new Response('not an image', { status: 415, headers: CORS });

  const h = new Headers(CORS);
  h.set('content-type', type);
  // 同一张图的地址是固定的（签名只跟原链接有关），可以放心长缓存
  h.set('cache-control', 'public, max-age=31536000, immutable');
  const len = up.headers.get('content-length');
  if (len) h.set('content-length', len);
  return new Response(up.body, { status: 200, headers: h });
}

/* ---------------- 把结果写成给模型看的样子 ----------------
   模型真正会用的就两样：描述词和 url。所以正文写成一行一条的紧凑格式，
   比塞一坨 JSON 省 token，也更不容易被读错。完整结构放 structuredContent，
   用得上的客户端自己去拿。 */
const trunc = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

// 模型会照抄眼前的东西。所以图片不给裸 URL，直接给一行拼好的 Markdown ——
// 它要做的只是原样贴出去，而不是「先理解、再决定用什么语法发」。
// 这是「AI 发了个网站链接而不是表情图」最管用的一处修法。
const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const altText = s => oneLine(s).replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim() || '表情';

const permLine = p => [p.allow_repost ? '允许二传' : '不允许二传', p.allow_edit ? '允许二改' : '不允许二改']
  .concat(p.other_permission ? ['其他：' + trunc(p.other_permission, 60)] : []).join('、');

/* 不是每个前端都渲染 Markdown 图片。有的（比如自带表情包系统的那类）
   会把外链图片剥掉，或者规定了自己的一套写法。所以出图格式做成可切的：
   在 MCP 地址后面加 ?format=url 之类就能换，不用改代码也不用重新部署。 */
const FORMATS = {
  markdown: { label: 'Markdown 图片', tpl: '![{desc}]({url})' },
  plain:    { label: '描述词 + 链接', tpl: '{desc} {url}' },
  url:      { label: '纯链接',        tpl: '{url}' },
  html:     { label: 'HTML img 标签', tpl: '<img src="{url}" alt="{desc}">' },
  both:     { label: '两种都给',      tpl: '![{desc}]({url})\n{url}' },
};

// 模板里认三个占位符，够用了：{url} 图片直链、{desc} 描述词、{n} 序号
function lineFromTpl(tpl) {
  return (e, i) => String(tpl)
    .replace(/\{url\}/g, e.url)
    .replace(/\{desc\}/g, altText(e.desc))
    .replace(/\{n\}/g, String((i || 0) + 1));
}

/* 预设满足不了的时候，用户可以在地址后面带 ?tpl=… 自己定一行长什么样。
   前端五花八门，与其我这边一个个猜，不如把写法交出去 ——
   /format 那页会帮着拼好整条地址，不用手动 URL 编码。 */
function fmtOf(name, tpl) {
  const custom = String(tpl == null ? '' : tpl).slice(0, 300);
  if (custom.includes('{url}')) {
    return { label: '自定义：' + custom.replace(/\n/g, '⏎'), line: lineFromTpl(custom),
             hint: '↓ 每张图给的是按这个环境认的写法拼好的一行，原样贴进回复就能发出去，' +
                   '一次贴好几行就是好几张。别改写这些行的结构。' };
  }
  const f = FORMATS[name] || FORMATS.markdown;
  const hint = name === 'plain'
    ? '↓ 每行是「描述词 + 一个空格 + 图片直链」。整行原样贴进回复即可，这个前端会按它自己的规矩把链接变成图。别改写这一行的结构。'
    : name === 'url'
    ? '↓ 每张图给的是直链，单独一行原样贴进回复即可，这个前端会自己把它变成图。别改写、别在同一行加说明文字。'
    : name === 'both'
    ? '↓ 每张图给了两种写法。挑你所在环境能显示成图片的那一种贴出去，只贴一种，别两种都贴。'
    : '↓ 下面每一行都是一张图，原样贴进你的回复就能发出去，一次可以发好几张。用户要的是图，不要只回网站链接。';
  return { label: f.label, line: lineFromTpl(f.tpl), hint };
}

function fmtEmojis(list, head, fmt, tpl) {
  if (!list.length) return head + '\n（一张都没搜到，换个近义词再试试）';
  const f = fmtOf(fmt, tpl);
  return head + '\n' + f.hint + '\n\n' + list.map((e, i) =>
    `${i + 1}. ${oneLine(e.desc) || '（没写描述词）'}` +
    (e.pack_title ? `　来自《${oneLine(e.pack_title)}》` : '') +
    `\n${f.line(e, i)}`).join('\n\n');
}

/* 一次返回多少张图，是这个接口最要命的一个数。
   不是因为我们慢 —— 一条数据库查询就取回来了 —— 而是因为前端拿到结果后
   会把每张图都预取一遍（它的报错原文就叫 prefetch loop）。
   每张都要经我们中转去第三方图床取，六十张一起来，它等不及就把整个
   工具调用掐了，用户看到的是"Fetch is aborted"，像是我们挂了。
   一张能过、六十张过不了 —— 所以这些默认值宁可小。
   模型真需要更多，它自己会带 limit 再调一次。 */
const PREVIEW_PACKS = 4;   // 给几个包配预览图
const PREVIEW_EACH  = 2;   // 每个包配几张

function fmtPacks(list, fmt, tpl) {
  if (!list.length) return '没找到符合的表情包。';
  const f = fmtOf(fmt, tpl);
  const anyPreview = list.some(p => p.preview && p.preview.length);
  return `找到 ${list.length} 个表情包。\n` +
    (anyPreview
      ? f.hint + '\n每个包下面附了前几张作预览，想看某个包的全部，再用 get_emoji_pack 取。\n\n'
      : '要发图的话，挑一个包用 get_emoji_pack 取图，或者直接用 search_emojis 按描述词搜单张。\n\n') +
    list.map((p, i) => {
      const tags = Array.isArray(p.tags) && p.tags.length ? `  标签：${p.tags.join(' ')}` : '';
      return `${i + 1}. 《${p.title}》  ${p.emoji_count} 张  by ${p.author || '佚名'}` +
             `\n   id: ${p.id}\n   分类：${p.category || '未分类'}${tags}` +
             `\n   转载/二改条款（只在用户问起时才提）：${permLine(p)}` +
             `\n   站内页面：${p.link}` +
             ((p.preview && p.preview.length)
               ? '\n' + p.preview.map((e, j) => f.line(e, j)).join('\n')
               : '');
    }).join('\n\n');
}

async function runTool(env, token, name, args, origin, fmt, tpl, ctx) {
  // 写法的优先级：模型临时指定 > 地址上的参数 > 令牌上存的 > 默认
  if (!fmt && !tpl) {
    const cfg = await tokenCfg(env, token);
    if (cfg && cfg.ok) { fmt = cfg.fmt || ''; tpl = cfg.tpl || ''; }
  }
  const a = args && typeof args === 'object' ? args : {};
  const num = (v, d) => (Number.isFinite(+v) ? Math.trunc(+v) : d);
  // 用户明说「用 <img> 标签发」之类的时候，模型可以临时换写法。
  // 默认还是走地址里配好的那个 —— 模型并不知道这个前端能渲染什么，不该由它猜
  if (a.format && FORMATS[a.format]) { fmt = a.format; tpl = ''; }

  if (name === 'whoami') {
    const r = await tokenCfg(env, token);
    // 连不上和令牌过期是两回事，别混着报 —— 报错了让人去重办令牌，
    // 结果其实是服务器在抽风，那就白折腾了
    if (!r || !r.ok) return { text: authText(r || {}), err: true };
    const cur = fmtOf(fmt, tpl);
    return { text: `令牌有效，属于「${r.nickname}」，出图写法：${cur.label}。`, data: r };
  }

  if (name === 'search_avatars') {
    const r = await rpc(env, 'mcp_search_avatars', {
      p_token: token,
      p_query: String(a.query == null ? '' : a.query).trim(),
      p_category: String(a.category == null ? '' : a.category).trim(),
      p_limit: Math.min(Math.max(num(a.limit, 8), 1), 20),
    });
    if (!r.ok) return { text: authText(r), err: true };
    const list = r.avatars || [];
    if (!list.length) return { text: '没找到符合的头像，换个词或者换个分类试试。', data: r };

    const f = fmtOf(fmt, tpl);
    // 一对情头要两张一起给，并且标清楚哪张是哪张 ——
    // 不标的话模型只会甩两张图，用户不知道该拿哪张
    const out = [];
    for (const p of list) {
      const one = await withProxy(env, [{ desc: p.title, url: p.url }], origin, ctx);
      const head = `${out.length + 1}. ${oneLine(p.title) || '（没写标题）'}　${p.category || '未分类'}` +
                   (p.author ? `　by ${p.author}` : '') +
                   (Array.isArray(p.tags) && p.tags.length ? `　标签：${p.tags.join(' ')}` : '');
      if (p.is_pair && p.url2) {
        const two = await withProxy(env, [{ desc: p.title + ' 左', url: p.url }, { desc: p.title + ' 右', url: p.url2 }], origin, ctx);
        out.push(head + '　【情侣头像，一对两张，要一起发并说清哪张给谁】\n' +
                 two.map((e, i) => f.line(e, i)).join('\n'));
      } else {
        out.push(head + '\n' + f.line(one[0], 0));
      }
    }
    return {
      text: `找到 ${list.length} 个头像。\n${f.hint}\n\n` + out.join('\n\n'),
      data: r,
    };
  }

  if (name === 'load_emoji_set') {
    const want = Math.min(Math.max(num(a.limit, 20), 5), 40);
    const q = String(a.query == null ? '' : a.query).trim();
    let list = [];

    if (q) {
      const r = await rpc(env, 'mcp_search_emojis', { p_token: token, p_query: q, p_limit: want });
      if (!r.ok) return { text: authText(r), err: true };
      list = r.emojis || [];
    } else {
      // 不挑主题就取最新的一批。
      //
      // 原来这里是一个包一个包整包拉回来再切 —— 本地测试库只有两个包所以
      // 没露馅，线上四十多个包、包里还有上百张，前端等不及直接把请求掐了
      // （Fetch is aborted）。现在数据库那边一条查询就返回最新的 N 张。
      const r = await rpc(env, 'mcp_recent_emojis', { p_token: token, p_limit: want });
      if (!r.ok) return { text: authText(r), err: true };
      list = r.emojis || [];
    }

    if (!list.length) return { text: q ? `没找到「${q}」相关的表情，换个词再试。` : '站里还没有表情。', err: true };

    const withUrls = await withProxy(env, list, origin, ctx);
    const f = fmtOf(fmt, tpl);
    const text =
      `已载入 ${withUrls.length} 张表情${q ? `（主题：${q}）` : ''}。\n\n` +
      `【接下来怎么用】想发表情的时候，从下面这份列表里挑一行，原样贴进你的回复就发出去了，\n` +
      `一次贴好几行就是一次发好几张。**不用再调用任何工具**，这份列表整段对话里一直有效。\n` +
      `挑的依据是每行括号前的描述词。不确定发什么就别硬发，宁可不发。\n` +
      `列表里没有合适的，再用 search_emojis 按词搜。\n\n` +
      withUrls.map((e, i) => f.line(e, i)).join('\n');
    return { text, data: { ok: true, count: withUrls.length, emojis: withUrls } };
  }

  if (name === 'search_emojis') {
    const q = String(a.query == null ? '' : a.query).trim();
    if (!q) return { text: '要搜什么词？', err: true };
    const r = await rpc(env, 'mcp_search_emojis', { p_token: token, p_query: q, p_limit: Math.min(Math.max(num(a.limit, 8), 1), 20) });
    if (!r.ok) return { text: authText(r), err: true };
    const list = await withProxy(env, r.emojis, origin, ctx);
    return { text: fmtEmojis(list, `搜「${q}」找到 ${list.length} 张：`, fmt, tpl), data: { ok: true, emojis: list } };
  }

  if (name === 'search_emoji_packs') {
    const r = await rpc(env, 'mcp_search_packs', {
      p_token: token,
      p_query: String(a.query == null ? '' : a.query).trim(),
      p_category: String(a.category == null ? '' : a.category).trim(),
      p_limit: Math.min(Math.max(num(a.limit, 10), 1), 30), p_offset: num(a.offset, 0),
    });
    if (!r.ok) return { text: authText(r), err: true };
    const packs = r.packs || [];

    // 顺手把前几个包的头几张图取回来。
    // 不这么做的话，模型调完这个工具手上一张图都没有，多半就拿个站内链接交差了 ——
    // 用户要的是表情，不是网址。
    //
    // 一条查询把这几个包的预览一起取回来。原来是每个包各拉一次整包再切前几张，
    // 一个包上百张的话为了四张预览白拉一百张，慢到前端会掐请求。
    // 预览取不到就跳过，不能因为它让整次搜索失败。
    const head = packs.slice(0, PREVIEW_PACKS);
    if (head.length) {
      const pv = await rpc(env, 'mcp_pack_previews', {
        p_token: token, p_ids: head.map(p => p.id), p_each: PREVIEW_EACH,
      });
      if (pv && pv.ok && pv.previews) {
        await Promise.all(head.map(async p => {
          const imgs = pv.previews[p.id];
          if (Array.isArray(imgs) && imgs.length) p.preview = await withProxy(env, imgs, origin, ctx);
        }));
      }
    }

    return { text: fmtPacks(packs, fmt, tpl), data: r };
  }

  if (name === 'get_emoji_pack') {
    const id = String(a.pack_id == null ? '' : a.pack_id).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { text: 'pack_id 不对，要用 search_emoji_packs 返回的那个 id。', err: true };
    }
    const r = await rpc(env, 'mcp_get_pack', { p_token: token, p_id: id });
    if (!r.ok) return { text: r.error === 'not_found' ? '这个表情包找不到了，可能已经被作者删掉。' : authText(r), err: true };
    const p = r.pack || {};
    // 整包一股脑给出去，一百多张的包能把前端的逐张预取拖到超时 ——
    // 那是"一张都收不到"，比"只收到前 24 张"糟得多
    const cap = Math.min(Math.max(num(a.limit, 24), 1), 60);
    const all = r.emojis || [];
    const shown = all.slice(0, cap);
    const more = all.length > shown.length
      ? `　这次先给前 ${shown.length} 张，还有 ${all.length - shown.length} 张。` +
        `用户说「全都要」的话，再调一次这个工具把 limit 调大。`
      : '';
    const head = `《${p.title}》 by ${p.author || '佚名'}  共 ${r.emoji_count} 张${more}\n` +
                 `转载/二改条款（只在用户问起时才提，不影响你现在发图）：${permLine(p)}\n${p.link}\n`;
    const list = await withProxy(env, shown, origin, ctx);
    return { text: fmtEmojis(list, head, fmt, tpl), data: Object.assign({}, r, { emojis: list }) };
  }

  if (name === 'list_categories') {
    const r = await rpc(env, 'mcp_list_categories', { p_token: token });
    if (!r.ok) return { text: authText(r), err: true };
    return { text: '分类：\n' + (r.categories || []).map(c => `· ${c.name}（${c.pack_count}）`).join('\n'), data: r };
  }

  return { text: '没有这个工具：' + name, err: true };
}

function authText(r) {
  return r.error === 'invalid_token'
    ? '令牌无效、已撤销或已过期。到 ' + SITE + ' 的「我的 → MCP 接口」重新生成一个填进来。'
    : (r.error || '出错了');
}

/* ---------------- JSON-RPC ---------------- */
const rpcOk  = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleMessage(env, token, msg, origin, fmt, tpl, ctx) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcErr(msg && msg.id != null ? msg.id : null, -32600, 'Invalid Request');
  }
  const id = msg.id;
  const isNotification = id === undefined || id === null;

  switch (msg.method) {
    case 'initialize': {
      const want = msg.params && msg.params.protocolVersion;
      const ver = PROTOCOLS.includes(want) ? want : PROTOCOLS[0];
      // 配错令牌是最常见的问题。在握手这一步就说清楚，
      // 比等用户问了一句话之后才报错要好得多。
      let note = '';
      if (!token) {
        note = '\n\n注意：没有检测到令牌。请在这个 MCP 服务的地址后面加上你的令牌，' +
               '或者配一个 Authorization: Bearer <令牌> 的请求头。令牌在 ' + SITE + ' 的「我的 → MCP 接口」里生成。';
      } else {
        const who = await tokenCfg(env, token);
        if (!who || !who.ok) {
          note = '\n\n注意：令牌无效、已撤销或已过期，现在什么都搜不到。到 ' + SITE + ' 的「我的 → MCP 接口」重新生成一个。';
        } else {
          const zh = { emoji: '表情包', avatar: '头像' };
          const on = (who.scopes || []).map(x => zh[x] || x).join('、');
          note = `\n\n当前令牌属于「${who.nickname}」，能看的范围：${on || '（没开任何一项）'}。`;
          if (!fmt && !tpl) { fmt = who.fmt || ''; tpl = who.tpl || ''; }
        }
      }
      const f = fmtOf(fmt, tpl);
      return rpcOk(id, {
        protocolVersion: ver,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, title: 'Yoww 表情包', version: VERSION },
        instructions:
          'Yoww 是一个表情包 / 头像分享站。\n' +
          `用户要表情的时候，**直接把图发出来**：工具返回里那几行（当前出图写法：${f.label}）原样贴进你的回复即可，` +
          '一次贴好几行就是一次发好几张，像聊天时甩表情一样。不要只回一个网站链接 —— ' +
          '用户要的是图，不是网页。\n' +
          '**推荐用法**：对话一开始先调一次 load_emoji_set，把一批表情载进来；' +
          '之后整段对话里想发表情就从那批里挑一行贴出去，不用再调工具。' +
          '这样发表情是零成本的，该发就发，别因为"要先查"而放弃。\n' +
          '载入的那批里没有合适的，再用 search_emojis 按词搜单张；' +
          'search_emoji_packs 按包搜、会附预览图；get_emoji_pack 取某个包的全部；' +
          'search_avatars 搜头像。都会出图。\n' +
          'yoww2026.cn/?collection=… 这类站内链接，只在用户明确问「在哪看」「出处是什么」时才给。\n' +
          '关于使用权限，别理解反了：把图发给正在跟你说话的这个用户看，是这个站最正常的用法，' +
          '**不需要任何额外许可，不用犹豫，也不用先问**。整个站的东西本来就是给大家取用的。\n' +
          'allow_repost（二传）/ allow_edit（二改）说的是另一回事 —— 用户拿到之后' +
          '再以自己的名义发布出去、或者改了再发。只有用户明确问起「这个能不能转载/能不能改」时，' +
          '才照这几个字段如实告诉他，别自己替作者做主。它们跟你现在发不发图无关。' + note,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return isNotification ? null : rpcOk(id, {});
    case 'tools/list': {
      // 没开的那一类，工具直接不出现在列表里 —— 模型看不见就不会去调，
      // 也不会拿一句"你没有权限"去烦用户
      const cfg = token ? await tokenCfg(env, token) : null;
      const allow = (cfg && cfg.ok && Array.isArray(cfg.scopes)) ? cfg.scopes : ['emoji', 'avatar'];
      return rpcOk(id, { tools: TOOLS.filter(t => !t.scope || allow.includes(t.scope)) });
    }
    case 'tools/call': {
      const p = msg.params || {};
      if (!token) {
        return rpcOk(id, {
          content: [{ type: 'text', text: '还没配令牌。到 ' + SITE + ' 的「我的 → MCP 接口」生成一个，填进这个 MCP 服务的配置里。' }],
          isError: true,
        });
      }
      const want = TOOLS.find(t => t.name === p.name);
      if (want && want.scope) {
        const cfg = await tokenCfg(env, token);
        const allow = (cfg && cfg.ok && Array.isArray(cfg.scopes)) ? cfg.scopes : null;
        if (allow && !allow.includes(want.scope)) {
          const zh = { emoji: '表情包', avatar: '头像' }[want.scope] || want.scope;
          return rpcOk(id, {
            content: [{ type: 'text', text: `这个令牌没开「${zh}」。令牌的主人可以到 ${SITE} 的「我的 → MCP 接口」里勾上。` }],
            isError: true,
          });
        }
      }
      const out = await runTool(env, token, p.name, p.arguments, origin, fmt, tpl, ctx);
      const res = { content: [{ type: 'text', text: out.text }] };
      if (out.err) res.isError = true;
      if (out.data) res.structuredContent = out.data;
      return rpcOk(id, res);
    }
    // 我们没有 resources / prompts。明确回空比回 method not found 好：
    // 有些客户端见到错误会以为整个服务坏了。
    case 'resources/list':          return rpcOk(id, { resources: [] });
    case 'resources/templates/list':return rpcOk(id, { resourceTemplates: [] });
    case 'prompts/list':            return rpcOk(id, { prompts: [] });
    default:
      return isNotification ? null : rpcErr(id, -32601, 'Method not found: ' + msg.method);
  }
}

/* ---------------- 假装成一个「生图接口」 ----------------
   这一段是整个项目里最绕的一个主意，值得写清楚为什么。

   问题：几乎所有 AI 前端，AI 消息里的图都不是按 Markdown 渲染出来的。
   AI 吐一行 ![](http://…) 出去，前端当纯文本显示，用户看到一串字符。
   这跟权限、跟格式、跟图床都没关系 —— 那条路本来就不存在。

   但是同一个前端，「生图」是能出图的。因为生图走的是另一条路：
   AI 说"我要画一张图"，**前端自己**拿着提示词去调绘图 API，
   拿回来的图由前端自己插进消息里 —— 走的是它原生的图片管线，
   跟头像、跟用户自己发的图同一条路。那条路一直是通的。

   所以：与其求前端渲染我们的链接，不如站到绘图 API 的位置上去。
   AI 说「发个笑死的表情」→ 前端把「笑死」当提示词发给我们 →
   我们不画，我们去站里搜「笑死」，把现成的表情当成"画好的图"返回 →
   前端当成自己画的渲染出来。

   对 AI 来说：它只是在用它本来就会用的生图功能。
   对用户来说：char 自己找表情、自己发出来，不用复制粘贴。
   对前端来说：它根本不知道这张图不是画的。

   我们同时装成三种常见的绘图接口，前端认哪种填哪种：
   · POST …/v1/images/generations   OpenAI 那套，最通用
   · POST …/sdapi/v1/txt2img        Stable Diffusion WebUI 那套
   · GET  /gen?prompt=…             只会拼地址的前端用这个，直接回图片本身

   鉴权跟 MCP 是同一把令牌，权限也是同一套（没开头像就搜不到头像）。 */

// 提示词里这些词是绘图习惯带出来的，跟"要哪张表情"没关系，搜之前先扔掉
const GEN_JUNK = new Set([
  'masterpiece', 'best', 'quality', 'highres', 'high', 'detailed', 'ultra', 'realistic',
  'illustration', 'anime', 'style', 'art', 'artwork', 'drawing', 'render', '4k', '8k',
  'sticker', 'emoji', 'emoticon', 'meme', 'image', 'picture', 'photo', 'png', 'jpg',
  'a', 'an', 'the', 'of', 'in', 'on', 'with', 'and', 'or', 'is', 'to', 'for',
  '表情包', '表情', '一张', '一个', '图片', '图', '发个', '来个', '生成', '画', '绘制',
  '高清', '可爱', '风格', '请', '帮我',
  // 方位词是用来挑情侣头像哪一半的，不是搜索词。
  // 不剔掉的话「情头 右」会拿「右」去搜标题，什么也搜不到
  '左', '右', '左边', '右边', '第一张', '第二张', '另一张', '另一半', '一对', '两张',
]);

// 前端能塞给我们的只有一串提示词 —— 没有额外参数可用。
// 所以「要情侣头像」和「要哪一半」都得从提示词里读出来
const GEN_PAIR_RE = /情头|情侣|couple|matching|cp头像/i;
const GEN_LEFT_RE = /左|第一张|男生?头像|male/i;
const GEN_RIGHT_RE = /右|第二张|另一张|另一半|女生?头像|female/i;
function genWantsPair(prompt) { return GEN_PAIR_RE.test(String(prompt || '')); }
// 返回 '' 表示没指定 —— 那就整对一起给
function genSide(prompt) {
  const p = String(prompt || '');
  if (GEN_RIGHT_RE.test(p)) return 'right';
  if (GEN_LEFT_RE.test(p)) return 'left';
  return '';
}
// 把挑中的条目摊成一张张具体的图。
// 情侣头像在库里是一条记录两个链接，摊开的时候绝不能只取 url 就完事 ——
// 只给左边那张，对面那个人就没得用了，等于这次请求白跑
// expand 只在「用户点名要情头」时才为真。
// 普通「来个头像」也可能搜到情侣记录 —— 那种情况下摊成两张是错的：
// 人家要一个头像，不该塞给他一对情头
function genFlatten(picks, want, side, expand) {
  const out = [];
  for (const p of picks || []) {
    if (out.length >= want) break;
    if (!(p.pair && p.url2)) { out.push({ desc: p.desc, url: p.url }); continue; }
    const label = oneLine(p.desc) || '情侣头像';
    if (side === 'right')    out.push({ desc: label + '（右）', url: p.url2 });
    else if (side || !expand) out.push({ desc: label + '（左）', url: p.url });
    else {
      // 一对不拆。宁可比 n 多给一张，也不能只给半边
      out.push({ desc: label + '（左）', url: p.url });
      out.push({ desc: label + '（右）', url: p.url2 });
    }
  }
  return out;
}

// 「一只很生气」这种，前面的量词和程度词全是白搭的 ——
// 描述词库里存的是「生气」，带着前缀一个字都搜不着。
// 一层层往下剥，剥到剩个实词为止
const GEN_MOD = /^(一只|一个|一张|一位|一条|一名|一幅|这个|那个|这种|一脸|满脸|很|超|好|特别|非常|巨|太|真|有点|有些|略|稍微|极其|十分|十足)/;
function genBare(w) {
  let t = String(w), n = 0;
  // 剥的次数有上限，正则再怎么改也不会在这里空转
  while (n++ < 4) {
    const next = t.replace(GEN_MOD, '');
    if (next === t) break;
    t = next;
  }
  return t;
}

/* 把一句提示词拆成几个候选搜索词，最像"能搜到东西"的排前面。

   为什么要拆：模型写出来的提示词通常是一整句
   （"一只很生气的猫，表情包风格，高清"），拿整句去 ILIKE 一个字都搜不到。
   描述词库里存的是「生气」「猫猫」这种两三个字的短词。

   所以是从长到短一路退：整句 → 逗号分段 → 连续汉字串 → 去掉程度词 →
   按「的」切开 → 最后从最长那串里切两字窗口。
   先长后短是为了准 —— 能搜到「摸头杀」就不要退到「摸头」。 */
function genTerms(prompt) {
  const raw = String(prompt == null ? '' : prompt).trim();
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  const push = s => {
    const t = String(s).trim().replace(/^[\s,，、。.!！?？:：;；"'`()（）\[\]]+|[\s,，、。.!！?？:：;；"'`()（）\[\]]+$/g, '');
    if (!t || t.length > 20 || seen.has(t)) return;
    if (GEN_JUNK.has(t.toLowerCase())) return;
    seen.add(t);
    out.push(t);
  };
  // 一个词连同它去掉程度词之后的样子，一起当候选
  const pushWord = w => {
    push(w);
    const bare = genBare(w);
    if (bare && bare !== w) push(bare);
  };

  // SD 那套的权重写法 (xxx:1.2) / {xxx} / [xxx]，括号本身没意义，去掉留里面的词
  const clean = raw.replace(/[(){}\[\]]/g, ' ').replace(/:\s*[\d.]+/g, ' ');

  // 整句很短的时候，整句本身就是最好的搜索词
  if (clean.trim().length <= 8) pushWord(clean.trim());

  // 按标点和空格切成段，中文段优先（描述词库是中文的）
  const parts = clean.split(/[,，、|\n\r\/]+/).map(s => s.trim()).filter(Boolean);
  const hasCjk = s => /[\u4e00-\u9fa5]/.test(s);
  for (const p of parts.filter(hasCjk)) pushWord(p);

  // 中文段里再抠出连续的汉字串，长的排前面
  const runs = [];
  for (const m of clean.matchAll(/[\u4e00-\u9fa5]{2,10}/g)) runs.push(m[0]);
  runs.sort((a, b) => b.length - a.length);
  for (const r of runs) {
    pushWord(r);
    // 「生气的猫」这种带「的」的，两边分开也各试一次
    if (r.includes('的')) r.split('的').filter(Boolean).forEach(pushWord);
  }

  // 英文段按词再切一遍，标签里偶尔有英文
  for (const p of parts.filter(s => !hasCjk(s))) {
    push(p);
    if (/\s/.test(p)) p.split(/\s+/).forEach(push);
  }

  // 兜底：从最长那串汉字里切两字窗口。
  // 「很生气的样子」→ …「生气」…，库里存的正是这种两字词。
  // 切出来的碎片不少是废的，所以放在最后，前面能搜到就轮不到它
  const longest = runs[0] || '';
  for (let i = 0; i + 2 <= longest.length; i++) push(longest.slice(i, i + 2));

  // 一次调用最多试这么多个词。每个词一次数据库来回，试太多前端会等到超时
  return out.slice(0, 8);
}

/* 按提示词挑图。搜不到就一路退，最后退到"站里最新的一批" ——
   宁可发一张不那么贴切的表情，也不要让前端收到一个错误弹窗。
   生图失败在大多数前端里是一句红字，比发错表情难看得多。 */
async function genFind(env, token, prompt) {
  const cfg = await tokenCfg(env, token);
  if (!cfg || !cfg.ok) return { ok: false, error: authText(cfg || {}) };
  const allow = Array.isArray(cfg.scopes) ? cfg.scopes : ['emoji', 'avatar'];
  const terms = genTerms(prompt);

  // 提示词里点名要头像，就去头像库。注意这是"用户/角色想换头像"的场景，
  // 跟发表情是两回事，搜错库子返回的东西完全用不了
  if (/头像|情头|avatar|profile\s*pic/i.test(String(prompt || '')) && allow.includes('avatar')) {
    const wantPair = genWantsPair(prompt);
    // 点名要情头就只在「情侣」这一类里找。不限分类的话，搜出来很可能是
    // 一个单人头像 —— 对方拿不到配对的那张，等于没解决问题
    const cats = wantPair ? ['情侣', ''] : [''];
    for (const cat of cats) {
      for (const t of terms.concat([''])) {
        const r = await rpc(env, 'mcp_search_avatars', {
          p_token: token, p_query: t, p_category: cat, p_limit: 20,
        });
        if (r.ok && (r.avatars || []).length) {
          const list = r.avatars.map(a => ({
            desc: a.title || '头像',
            url: a.url,
            url2: a.url2 || '',
            pair: !!(a.is_pair && a.url2),
          }));
          // 要情头的时候，只留真的成对的那些；一条都没有再放宽
          const pairs = list.filter(x => x.pair);
          if (wantPair && pairs.length) {
            return { ok: true, term: t, kind: 'avatar', pairMode: true, list: pairs };
          }
          if (!wantPair) {
            // 不限分类搜出来的结果里混着情侣记录。要单人头像就先挑真正的单人，
            // 实在一个都没有才退回用情侣记录里的一张
            const solos = list.filter(x => !x.pair);
            return { ok: true, term: t, kind: 'avatar', pairMode: false,
                     list: solos.length ? solos : list };
          }
        }
      }
    }
    // 找遍了也没有成对的，退回随便给一个头像，总比报错强
    const r = await rpc(env, 'mcp_search_avatars', {
      p_token: token, p_query: '', p_category: '', p_limit: 20,
    });
    if (r.ok && (r.avatars || []).length) {
      return { ok: true, term: '', kind: 'avatar', pairMode: false,
               list: r.avatars.map(a => ({ desc: a.title || '头像', url: a.url,
                                           url2: a.url2 || '', pair: !!(a.is_pair && a.url2) })) };
    }
  }

  if (!allow.includes('emoji')) {
    return { ok: false, error: '这个令牌没开「表情包」。令牌的主人可以到 ' + SITE + ' 的「我的 → MCP 接口」里勾上。' };
  }

  for (const t of terms) {
    const r = await rpc(env, 'mcp_search_emojis', { p_token: token, p_query: t, p_limit: 20 });
    if (!r.ok) return { ok: false, error: authText(r) };
    if ((r.emojis || []).length) return { ok: true, term: t, kind: 'emoji', list: r.emojis };
  }

  const r = await rpc(env, 'mcp_recent_emojis', { p_token: token, p_limit: 30 });
  if (!r.ok) return { ok: false, error: authText(r) };
  if (!(r.emojis || []).length) return { ok: false, error: '站里还没有表情。' };
  return { ok: true, term: '', kind: 'emoji', list: r.emojis };
}

// 从候选里随机挑不重复的几张。随机是故意的 ——
// 同一个词每次都给同一张，聊几轮就穿帮了
function genPick(list, n) {
  const pool = (list || []).slice();
  const out = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

function bytesToB64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  // 一次性 spread 进 fromCharCode 会爆栈，几百 KB 的图就够了
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/* 有些前端只认 base64（SD 那套接口就是强制的），那就得我们自己把图取回来。
   取的时候同样不带来路，否则图床照样挡。 */
async function genBytes(raw) {
  let up;
  try {
    up = await fetch(String(raw), {
      referrer: '', referrerPolicy: 'no-referrer',
      headers: { accept: 'image/*,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; YowwMCP/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      cf: { cacheEverything: true, cacheTtl: 86400 },
    });
  } catch (e) { return null; }
  if (!up.ok) return null;
  const type = up.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) return null;
  const buf = await up.arrayBuffer();
  // 太大的就不转了，base64 会再涨三分之一，塞进 JSON 前端也未必受得住
  if (buf.byteLength > 3 * 1024 * 1024) return null;
  return { b64: bytesToB64(buf), type };
}

// 提示词可能在 prompt / text / input 里，各家叫法不一样
function genPrompt(body, url) {
  const b = body && typeof body === 'object' ? body : {};
  return String(b.prompt || b.text || b.input || b.q ||
                url.searchParams.get('prompt') || url.searchParams.get('q') || '').slice(0, 2000);
}

async function readBody(req) {
  if (req.method !== 'POST' && req.method !== 'PUT') return {};
  try { return await req.json(); } catch (e) { return {}; }
}

/* OpenAI 那套：POST /v1/images/generations
   回 { created, data: [ { url, b64_json, revised_prompt } ] }
   url 和 b64_json 两个都给 —— 各家前端读哪个的都有，给全了省得挨个试。
   前端明确说 response_format: "url" 时就不去取字节了，能省一个来回。 */
async function genOpenAI(env, token, req, url, cors, ctx) {
  const body = await readBody(req);
  const prompt = genPrompt(body, url);
  const n = Math.min(Math.max(parseInt(body.n, 10) || 1, 1), 4);

  const found = await genFind(env, token, prompt);
  if (!found.ok) {
    return json({ error: { message: found.error, type: 'invalid_request_error' } }, 400, {}, cors);
  }
  // 情侣头像一对两张，得按「对」来算要挑几条记录
  const side = genSide(prompt);
  const whole = found.pairMode && !side;
  const need = whole ? Math.max(2, n) : n;
  const shots = genFlatten(genPick(found.list, whole ? Math.ceil(need / 2) : need), need, side, whole);
  const wantB64 = body.response_format !== 'url';

  const data = [];
  for (const p of shots) {
    const link = await proxyUrl(env, p.url, url.origin);
    warm(env, ctx, [p.url]);
    const item = { url: link, revised_prompt: oneLine(p.desc) || prompt };
    if (wantB64) {
      const bytes = await genBytes(p.url);
      if (bytes) item.b64_json = bytes.b64;
    }
    data.push(item);
  }
  return json({ created: Math.floor(Date.now() / 1000), data }, 200, {}, cors);
}

/* SD WebUI 那套：POST /sdapi/v1/txt2img
   这套接口规定了只能回 base64，没得选。 */
async function genSD(env, token, req, url, cors) {
  const body = await readBody(req);
  const prompt = genPrompt(body, url);
  const n = Math.min(Math.max(parseInt(body.batch_size, 10) || parseInt(body.n_iter, 10) || 1, 1), 4);

  const found = await genFind(env, token, prompt);
  if (!found.ok) return json({ error: found.error, detail: found.error }, 400, {}, cors);

  const side = genSide(prompt);
  const whole = found.pairMode && !side;
  const need = whole ? Math.max(2, n) : n;
  const images = [];
  for (const p of genFlatten(genPick(found.list, whole ? Math.ceil(need / 2) : need), need, side, whole)) {
    const bytes = await genBytes(p.url);
    if (bytes) images.push(bytes.b64);
  }
  if (!images.length) return json({ error: '图取不回来', detail: '图取不回来' }, 502, {}, cors);
  return json({
    images,
    parameters: { prompt, batch_size: images.length },
    info: JSON.stringify({ prompt, infotexts: [prompt] }),
  }, 200, {}, cors);
}

/* 只会拼地址的前端：GET /gen?prompt=…  或  GET /gen/笑死.png
   直接把图片本身回过去（转到中转地址上，缓存和防盗链一并解决）。 */
async function genDirect(env, token, req, url, seg, cors) {
  let prompt = url.searchParams.get('prompt') || url.searchParams.get('q') || '';
  if (!prompt && seg.length > 1) {
    try { prompt = decodeURIComponent(seg.slice(1).join('/')); } catch (e) { prompt = seg.slice(1).join('/'); }
    prompt = prompt.replace(/\.(png|jpe?g|gif|webp)$/i, '');
  }
  const found = await genFind(env, token, prompt);
  if (!found.ok) return new Response(found.error, { status: 400, headers: cors });
  const pick = genPick(found.list, 1)[0];
  if (!pick) return new Response('没挑到图', { status: 404, headers: cors });
  // 这个入口是 302 到一张图，结构上没法一次给两张。
  // 情侣头像就靠提示词挑边：「情头 左」/「情头 右」，地址上加 ?side=right 也行。
  // 都没说就给左边那张，另一半让他换个词再要一次
  const side = genSide(prompt) || (url.searchParams.get('side') || '').toLowerCase();
  const shot = genFlatten([pick], 1, side === 'right' ? 'right' : 'left', false)[0] || pick;
  const link = await proxyUrl(env, shot.url, url.origin);
  return new Response(null, {
    status: 302,
    headers: Object.assign({ location: link, 'cache-control': 'no-store' }, cors),
  });
}

/* 前端连上来之前会先探这几个地址，探不到就直接报"连接失败"，
   连让用户点一下生成的机会都没有。回几个最小的假答案让它过关。 */
function genProbe(path, cors) {
  const one = { title: 'yoww', model_name: 'yoww', hash: null, sha256: null, filename: 'yoww', config: null };
  if (path.endsWith('/sd-models')) return json([one], 200, {}, cors);
  if (path.endsWith('/sdapi/v1/options')) return json({ sd_model_checkpoint: 'yoww' }, 200, {}, cors);
  if (path.endsWith('/samplers')) return json([{ name: 'Euler a', aliases: ['k_euler_a'], options: {} }], 200, {}, cors);
  if (path.endsWith('/schedulers')) return json([{ name: 'Automatic', label: 'Automatic' }], 200, {}, cors);
  if (path.endsWith('/upscalers') || path.endsWith('/latent-upscale-modes') || path.endsWith('/loras')) {
    return json([], 200, {}, cors);
  }
  if (path.endsWith('/models')) {
    return json({ object: 'list', data: [
      { id: 'yoww', object: 'model', created: 0, owned_by: 'yoww' },
      { id: 'dall-e-3', object: 'model', created: 0, owned_by: 'yoww' },
    ] }, 200, {}, cors);
  }
  return null;
}

/* ---------------- 油猴脚本 ----------------
   跟 MCP、跟绘图并排的第三条路，面向的是"前端有自己的表情列表"那一类。
   那份列表才是 AI 真正能用的东西：前端把它塞进提示词，模型挑名字，
   前端按名字渲染。往那份列表里导，等于让 char 原生就会发这些表情 ——
   不调工具、不出图、也不会因为一次几十张图把前端拖超时。

   跟另外两条路最大的不同是**只给点赞过的**。站上本来就是「点赞后可下载」，
   这个脚本要是能搜全站，等于开了个绕过点赞的后门。想搜全站的去接 MCP，
   那条路一直开着 —— 门槛在"要会配 MCP"，不在"我们不给"。

   脚本正文用 String.raw 原样嵌进来：里面有 \n 这种转义，普通模板字符串
   会把它当换行吃掉，吐出去的脚本就成了语法错误。地址留了个占位符，
   下发时替换成当前 origin，本地 wrangler dev 才指得回自己。 */
function userScript(origin) {
  return String.raw`// ==UserScript==
// @name         Yoww 表情包
// @namespace    https://yoww2026.cn/
// @version      1.0.0
// @description  在任何 AI 聊天前端里，直接用你在 Yoww 点赞过的表情包：单张插入，或把整批导进前端自己的表情列表
// @author       Yoww
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      mcp.yoww2026.cn
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* 这个脚本只做一件事：把「你点赞过的表情包」搬到你正在用的聊天页面里。

   为什么值得单独做一个脚本，而不是全指望 MCP：
   前端自己的那份表情列表，才是 AI 真正能用的东西 —— 它会把这份列表塞进
   提示词，AI 挑名字，前端按名字渲染。往那份列表里导，等于让 char 原生
   就会发这些表情，不用调任何工具，也不会因为一次返回几十张图而超时。

   为什么只给点赞过的：站上本来就是「点赞后可下载」。脚本要是能搜全站，
   等于开了个绕过点赞的后门，发包的人白干。所以这里能看到什么，跟你在
   站上能下载什么，是同一条线。真想搜全站的，去接 MCP —— 那条路一直开着。

   没装 Tampermonkey 也能跑：GM_* 不在就退回普通 fetch 和 localStorage。
   这不是为了将就，是为了能在普通浏览器里把整个流程测一遍。 */

(function () {
  'use strict';

  var API = '__YOWW_API__';   // 下发时由服务端替换成它自己的地址
  var NS = 'yoww:';

  // ---------- 存取：有油猴用油猴的，没有就用 localStorage ----------
  function getv(k, d) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(k, d);
      var raw = localStorage.getItem(NS + k);
      return raw === null ? d : JSON.parse(raw);
    } catch (e) { return d; }
  }
  function setv(k, v) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; }
      localStorage.setItem(NS + k, JSON.stringify(v));
    } catch (e) { /* 无痕模式之类，存不了就算了，不能因此崩掉 */ }
  }

  // ---------- 请求：油猴的 xhr 能跨域，没有就用 fetch（服务端回了 CORS） ----------
  function ask(path, body) {
    var url = API + path;
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST', url: url,
          headers: { 'content-type': 'application/json' },
          data: JSON.stringify(body),
          timeout: 20000,
          onload: function (r) {
            try { resolve(JSON.parse(r.responseText)); }
            catch (e) { reject(new Error('服务器返回了看不懂的内容')); }
          },
          onerror: function () { reject(new Error('连不上 Yoww')); },
          ontimeout: function () { reject(new Error('等太久了，网络可能不通')); },
        });
        return;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); }).then(resolve).catch(function () {
        reject(new Error('连不上 Yoww'));
      });
    });
  }

  // ---------- 找输入框 ----------
  /* 哪个框才是"聊天输入框"没有统一答案，各家 DOM 千奇百怪。
     与其猜，不如记住你最后点过的那个可输入的地方 —— 你要往哪儿插，
     你自己刚点过。这比任何选择器都准。 */
  var lastBox = null;
  function editable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    var t = el.tagName;
    if (t === 'TEXTAREA') return true;
    if (t === 'INPUT') {
      var ty = (el.getAttribute('type') || 'text').toLowerCase();
      return ty === 'text' || ty === 'search' || ty === '';
    }
    return false;
  }
  document.addEventListener('focusin', function (e) {
    if (editable(e.target) && !inPanel(e.target)) lastBox = e.target;
  }, true);

  /* 往框里塞字，最容易翻车的一步。
     直接改 .value 在 React / Vue 那套受控组件里是没用的 —— 框里看着变了，
     它内部的状态没变，你一发送，发出去的还是原来的空字符串。
     所以要用原型上的 setter 绕过框架的劫持，再手动派发一个 input 事件，
     让框架以为是人敲的。contenteditable 那类走 execCommand，同理。 */
  function insertText(el, text) {
    if (!el) return false;
    el.focus();
    if (el.isContentEditable) {
      var okc = false;
      try { okc = document.execCommand('insertText', false, text); } catch (e) { okc = false; }
      if (!okc) {
        el.textContent = (el.textContent || '') + text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    var start = el.selectionStart, end = el.selectionEnd;
    var cur = el.value || '';
    var next = (start === null || start === undefined)
      ? cur + text
      : cur.slice(0, start) + text + cur.slice(end);
    if (desc && desc.set) desc.set.call(el, next); else el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    try {
      var pos = (start === null || start === undefined ? next.length : start + text.length);
      el.setSelectionRange(pos, pos);
    } catch (e) { /* number 之类的框不支持，无所谓 */ }
    return true;
  }

  // ---------- 导出写法 ----------
  /* 各家前端的表情列表格式不一样，所以给几种常见的让你挑。
     挑错了不会有任何报错，只会导进去一堆没人认的字符串 —— 所以面板里
     一直带着一行预览，导之前先看一眼长什么样。 */
  var FORMATS = [
    { key: 'pipe',  label: '名称|链接',      line: function (e) { return e.desc + '|' + e.url; } },
    { key: 'space', label: '名称 链接',      line: function (e) { return e.desc + ' ' + e.url; } },
    { key: 'md',    label: 'Markdown 图片',  line: function (e) { return '![' + e.desc + '](' + e.url + ')'; } },
    { key: 'url',   label: '只要链接',       line: function (e) { return e.url; } },
    { key: 'json',  label: 'JSON 数组',      whole: function (list) {
        return JSON.stringify(list.map(function (e) { return { name: e.desc, url: e.url }; }), null, 2); } },
  ];
  function fmtOf(key) {
    for (var i = 0; i < FORMATS.length; i++) if (FORMATS[i].key === key) return FORMATS[i];
    return FORMATS[0];
  }
  function build(list, key) {
    var f = fmtOf(key);
    if (f.whole) return f.whole(list);
    return list.map(f.line).join('\n');
  }

  // ---------- 面板 ----------
  /* 整个界面塞进 shadow DOM。宿主页面的 CSS 什么都干得出来 ——
     一条 img{width:100%} 就能让缩略图铺满半个屏幕。隔开最省事。 */
  var host = null, root = null, state = {
    packs: [], picked: {}, emojis: [], loading: false, note: '',
    q: '', open: false, view: 'grid',
  };
  function inPanel(el) { return !!(host && (el === host || host.contains(el))); }

  function css() {
    return '' +
    ':host{all:initial}' +
    // all:initial 把 box-sizing 也一起重置回 content-box 了，
    // 于是 width:340 的面板实际占 366（加内边距和边框），窄屏直接顶出屏幕左边
    '*,*::before,*::after{box-sizing:border-box}' +
    '.wrap{position:fixed;right:18px;bottom:18px;z-index:2147483000;' +
      'font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1b1b1f}' +
    '.fab{width:42px;height:42px;border-radius:50%;border:none;cursor:pointer;' +
      'background:#3b6ef5;color:#fff;box-shadow:0 3px 12px rgba(0,0,0,.28);' +
      'display:flex;align-items:center;justify-content:center;padding:0}' +
    '.fab svg{width:21px;height:21px;display:block}' +
    '.box{position:absolute;right:0;bottom:52px;width:340px;max-width:calc(100vw - 36px);' +
      'max-height:min(520px,calc(100vh - 110px));overflow:auto;background:#fbfaf8;' +
      'border:1px solid #e6e1d9;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.2);padding:12px}' +
    '.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}' +
    '.row+.row{margin-top:8px}' +
    'input,select{flex:1;min-width:0;box-sizing:border-box;padding:7px 9px;font:inherit;' +
      'border:1px solid #ddd8d0;border-radius:8px;background:#fff;color:inherit}' +
    'button.b{padding:7px 12px;font:inherit;border:none;border-radius:8px;background:#3b6ef5;color:#fff;cursor:pointer}' +
    'button.o{padding:6px 10px;font:inherit;border:1px solid #ddd8d0;border-radius:8px;background:#fff;color:inherit;cursor:pointer}' +
    'button.b:disabled,button.o:disabled{opacity:.5;cursor:default}' +
    '.hint{color:#8a8681;font-size:12px;margin:6px 0 0}' +
    '.bad{color:#c0392b}' +
    '.packs{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}' +
    '.chip{padding:4px 9px;border-radius:999px;border:1px solid #ddd8d0;background:#fff;cursor:pointer;font-size:12px}' +
    '.chip.on{background:#3b6ef5;border-color:#3b6ef5;color:#fff}' +
    '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px}' +
    '.cell{border:none;background:none;padding:0;cursor:pointer}' +
    '.cell img{width:100%;aspect-ratio:1;object-fit:contain;border-radius:8px;' +
      'background:#f3f0ea;border:1px solid #e6e1d9;display:block}' +
    '.cell span{display:block;font-size:10px;color:#8a8681;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    'textarea{width:100%;box-sizing:border-box;height:120px;margin-top:8px;padding:8px;' +
      'font:11px/1.5 ui-monospace,Menlo,monospace;border:1px solid #ddd8d0;border-radius:8px;background:#fff;color:inherit}' +
    '.head{display:flex;justify-content:space-between;align-items:center}' +
    '.head b{font-size:14px}' +
    '.x{border:none;background:none;font-size:18px;cursor:pointer;color:#8a8681;line-height:1}';
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'yoww-emoji-host';
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', { text: css() }));
    root.appendChild(el('div', { class: 'wrap' }, [
      el('button', { class: 'fab', title: 'Yoww 表情包', onclick: toggle,
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
              'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<rect x="3" y="3" width="18" height="18" rx="4"/>' +
              '<circle cx="8.8" cy="9.2" r="1.5"/>' +
              '<path d="M21 15.5 16.2 10.7 7 19.9"/></svg>' }),
    ]));
    document.documentElement.appendChild(host);
  }

  function toggle() {
    state.open = !state.open;
    draw();
    if (state.open && !state.packs.length) loadPacks();
  }

  function draw() {
    var wrap = root.querySelector('.wrap');
    var old = root.querySelector('.box');
    if (old) old.remove();
    if (!state.open) return;

    var tok = getv('token', '');
    var box = el('div', { class: 'box' });

    box.appendChild(el('div', { class: 'head' }, [
      el('b', { text: 'Yoww 表情包' }),
      el('button', { class: 'x', text: '×', onclick: toggle }),
    ]));

    // 没填令牌：先只给填令牌这一件事，别把一堆空界面摆在人脸上
    if (!tok) {
      var inp = el('input', { placeholder: '把令牌粘进来（yoww_ 开头）', value: '' });
      box.appendChild(el('div', { class: 'row' }, [inp]));
      box.appendChild(el('div', { class: 'row' }, [
        el('button', { class: 'b', text: '保存', onclick: function () {
          var v = (inp.value || '').trim();
          if (!v) return;
          setv('token', v); fresh();          // 作废上一个令牌还在路上的请求
          state.packs = []; state.emojis = []; state.note = ''; state.loading = false;
          draw(); loadPacks();
        } }),
      ]));
      box.appendChild(el('p', { class: 'hint', text:
        '令牌在 yoww2026.cn 的「我的 → MCP 接口」里生成，跟接 MCP 用的是同一个。' +
        '这里只会出现你点赞过的表情包。' }));
      wrap.appendChild(box);
      return;
    }

    // 搜索 + 刷新
    var q = el('input', { placeholder: '在我点赞的包里搜（留空是全部）', value: state.q });
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.q = q.value; loadEmojis(); } });
    box.appendChild(el('div', { class: 'row' }, [
      q,
      el('button', { class: 'o', text: '搜', onclick: function () { state.q = q.value; loadEmojis(); } }),
    ]));

    // 点赞过的包，当筛选用
    if (state.packs.length) {
      var chips = el('div', { class: 'packs' });
      chips.appendChild(el('button', {
        class: 'chip' + (allPicked() ? ' on' : ''), text: '全部',
        onclick: function () { state.picked = {}; loadEmojis(); },
      }));
      state.packs.forEach(function (p) {
        chips.appendChild(el('button', {
          class: 'chip' + (state.picked[p.id] ? ' on' : ''),
          text: p.title + ' · ' + p.emoji_count,
          onclick: function () {
            if (state.picked[p.id]) delete state.picked[p.id]; else state.picked[p.id] = 1;
            loadEmojis();
          },
        }));
      });
      box.appendChild(chips);
    }

    if (state.loading) box.appendChild(el('p', { class: 'hint', text: '加载中…' }));
    if (state.note) box.appendChild(el('p', { class: 'hint' + (state.noteBad ? ' bad' : ''), text: state.note }));

    if (state.view === 'grid') {
      var grid = el('div', { class: 'grid' });
      state.emojis.slice(0, 60).forEach(function (e) {
        var img = el('img', { src: e.url, alt: '', loading: 'lazy' });
        var cap = el('span', { text: e.desc || '' });
        grid.appendChild(el('button', {
          class: 'cell', title: e.desc || '',
          onclick: function () { pickOne(e); },
        }, [img, cap]));
      });
      box.appendChild(grid);
    }

    // 一次性导入
    var sel = el('select');
    FORMATS.forEach(function (f) {
      var o = el('option', { value: f.key, text: f.label });
      if (f.key === getv('fmt', 'pipe')) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { setv('fmt', sel.value); draw(); });

    box.appendChild(el('div', { class: 'row' }, [
      sel,
      el('button', {
        class: 'b', text: '一次性导入',
        onclick: function () { importAll(); },
      }),
    ]));
    box.appendChild(el('p', { class: 'hint', text:
      '「一次性导入」会把上面这些图按选中的写法，一股脑填进你最后点过的那个输入框 —— ' +
      '通常就是前端「添加表情」的那个大框。没点过框就复制到剪贴板。' }));

    box.appendChild(el('div', { class: 'row' }, [
      el('button', { class: 'o', text: '换令牌', onclick: function () {
        setv('token', ''); fresh();
        state.packs = []; state.emojis = []; state.note = ''; state.loading = false; draw();
      } }),
      el('button', { class: 'o', text: '刷新', onclick: function () { state.packs = []; loadPacks(); } }),
    ]));

    wrap.appendChild(box);
  }

  function allPicked() { return Object.keys(state.picked).length === 0; }

  /* 每次发请求领一个号，回来时号对不上就直接丢掉。

     不加这个会出真事：换令牌的时候，上一个令牌的请求还在路上，
     它晚一步回来就把新的结果盖掉 —— 最难看的一种是令牌已经失效了，
     旧请求的"我的库里 8 张"却把错误提示顶掉，用户以为一切正常，
     实际上什么都用不了。连着点几个包筛选也是同样的毛病。 */
  var seq = 0;
  function fresh() { return ++seq; }
  function stale(my) { return my !== seq; }

  function say(msg, bad) { state.note = msg; state.noteBad = !!bad; draw(); }

  function loadPacks() {
    var tok = getv('token', '');
    if (!tok) return;
    var my = fresh();
    state.loading = true; draw();
    ask('/s/packs', { key: tok }).then(function (r) {
      if (stale(my)) return;
      state.loading = false;
      if (!r || !r.ok) { say((r && r.error) || '拿不到你点赞的包', true); return; }
      state.packs = r.packs || [];
      if (!state.packs.length) {
        say('你还没点赞过任何表情包。去 yoww2026.cn 点几个赞，这里就有了。', true);
        state.emojis = []; draw(); return;
      }
      state.note = ''; loadEmojis();
    }).catch(function (e) { if (stale(my)) return; state.loading = false; say(e.message, true); });
  }

  function loadEmojis() {
    var tok = getv('token', '');
    if (!tok) return;
    var my = fresh();
    state.loading = true; draw();
    var ids = Object.keys(state.picked);
    ask('/s/emojis', { key: tok, ids: ids.length ? ids : null, q: state.q || '', limit: 300 })
      .then(function (r) {
        if (stale(my)) return;
        state.loading = false;
        if (!r || !r.ok) { say((r && r.error) || '拿不到表情', true); return; }
        state.emojis = r.emojis || [];
        var msg = '我的库里 ' + (r.total || 0) + ' 张';
        if (state.q && r.unliked_packs) {
          msg += '。站里还有 ' + r.unliked_packs + ' 个包也有「' + state.q + '」，去点个赞就能用。';
        }
        say(msg, false);
      }).catch(function (e) { if (stale(my)) return; state.loading = false; say(e.message, true); });
  }

  function pickOne(e) {
    // 单张插入一律按图片写法走，不跟着"导入写法"变 ——
    // 这是你自己要发的一条消息，你自己发的消息前端是按 Markdown 渲染的
    var text = '![' + (e.desc || '表情') + '](' + e.url + ')';
    if (lastBox && insertText(lastBox, text)) { say('插好了', false); return; }
    copy(text, '没找到输入框，已复制到剪贴板');
  }

  function importAll() {
    if (!state.emojis.length) { say('没有可导入的图', true); return; }
    var text = build(state.emojis, getv('fmt', 'pipe'));
    if (lastBox && insertText(lastBox, text)) {
      say('已填进你最后点过的那个框，共 ' + state.emojis.length + ' 张', false);
      return;
    }
    copy(text, '没点过输入框，' + state.emojis.length + ' 张已复制到剪贴板');
  }

  function copy(text, msg) {
    try {
      navigator.clipboard.writeText(text).then(
        function () { say(msg, false); },
        function () { fallbackCopy(text, msg); });
    } catch (e) { fallbackCopy(text, msg); }
  }
  function fallbackCopy(text, msg) {
    // 有些页面禁了剪贴板权限。退回老办法：临时塞一个 textarea 再 execCommand
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      say(msg, false);
    } catch (e2) { say('复制不了，手动选一下吧', true); }
  }

  // 有些页面是先渲染一片空白再挂内容的，等一会儿再挂按钮
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  // 给测试用的把手。生产环境里没人会去碰它，但没有它就只能靠点坐标去测
  window.__yoww = {
    state: state, insertText: insertText, build: build, FORMATS: FORMATS,
    mount: mount, toggle: toggle, get box() { return root && root.querySelector('.box'); },
    get root() { return root; },
    setToken: function (t) { setv('token', t); },
  };
})();
`.replace('__YOWW_API__', origin.replace(/^http:/, 'https:'));
}

// uuid 长什么样是定死的。不先筛一遍就往数据库送，一个手写的烂 id
// 就能让整条查询报错 —— 报错信息还会原样漏回给调用方
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function scriptApi(env, req, url, path, cors, ctx) {
  let body = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch (e) { body = {}; } }
  const token = readToken(req, url) || String(body.key || '').trim();
  if (!token) {
    return json({ ok: false, error: '还没填令牌。在脚本面板里粘一个 yoww_ 开头的令牌。' }, 401, {}, cors);
  }

  if (path.endsWith('/packs')) {
    const r = await rpc(env, 'mcp_liked_packs', { p_token: token, p_limit: 200 });
    if (!r.ok) return json({ ok: false, error: authText(r) }, 200, {}, cors);
    return json(r, 200, {}, cors);
  }

  if (path.endsWith('/emojis')) {
    const ids = Array.isArray(body.ids) ? body.ids.filter(x => UUID_RE.test(String(x))) : [];
    const r = await rpc(env, 'mcp_liked_emojis', {
      p_token: token,
      p_ids: ids.length ? ids : null,
      p_query: String(body.q == null ? '' : body.q).trim(),
      p_limit: Math.min(Math.max(parseInt(body.limit, 10) || 300, 1), 500),
      p_offset: Math.max(parseInt(body.offset, 10) || 0, 0),
    });
    if (!r.ok) return json({ ok: false, error: authText(r) }, 200, {}, cors);
    // 图一律走中转：脚本跑在别人的页面上，第三方图床的防盗链和 CORS 都指望不上
    const list = await withProxy(env, r.emojis, url.origin, ctx);
    return json(Object.assign({}, r, { emojis: list }), 200, {}, cors);
  }

  return json({ ok: false, error: '没有这个接口' }, 404, {}, cors);
}

/* ---------------- 令牌从哪来 ----------------
   两种都认：
   · Authorization: Bearer yoww_xxx  —— 更稳妥，令牌不会进浏览器历史和访问日志
   · 地址里直接带           https://mcp.yoww2026.cn/mcp/yoww_xxx
     有些客户端只让填一个地址，那就只能这么来。 */
function readToken(req, url) {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  if (m) return m[1];
  const x = req.headers.get('x-api-key');
  if (x) return x.trim();
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg.length >= 2 && seg[seg.length - 1].startsWith('yoww_')) return seg[seg.length - 1];
  const q = url.searchParams.get('key') || url.searchParams.get('token');
  return q ? q.trim() : '';
}

const json = (body, status = 200, extra = {}, cors = CORS) =>
  new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, cors, extra),
  });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = url.origin;
    const cors = corsFor(req);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const seg = url.pathname.split('/').filter(Boolean);
    const first = seg[0] || '';

    // 图片中转：/i/<签名>/<编码过的原链接>.<扩展名>
    if (first === 'i') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: Object.assign({ allow: 'GET, HEAD' }, cors) });
      }
      if (seg.length < 3) return new Response('bad request', { status: 400, headers: cors });
      const payload = seg.slice(2).join('/').replace(/\.[a-z0-9]+$/i, '');
      return serveImage(env, url, seg[1], payload);
    }

    /* 生图接口。跟 MCP 是两套东西，同一个 Worker、同一把令牌，
       前端认哪套就接哪套，两套一起接也行。
       探测用的那几个地址不查令牌 —— 有些前端先探通不通再让你填 key，
       这时候拦下来，用户看到的就是"连接失败"，压根走不到填 key 那一步。 */
    if (first === 'v1' || first === 'sdapi' || first === 'gen') {
      const path = url.pathname;
      const isGen = path.endsWith('/images/generations') || path.endsWith('/images/generation');
      const isTxt = path.endsWith('/txt2img') || path.endsWith('/img2img');

      if (!isGen && !isTxt && first !== 'gen') {
        const probe = genProbe(path, cors);
        if (probe) return probe;
      }

      const genToken = readToken(req, url);
      if (!genToken) {
        return json({ error: { message: '没带令牌。在这个绘图服务的「API Key / 密钥」那一栏填上 yoww_ 开头的令牌。', type: 'invalid_request_error' } }, 401, {}, cors);
      }
      if (isGen) return genOpenAI(env, genToken, req, url, cors, ctx);
      if (isTxt) return genSD(env, genToken, req, url, cors);
      if (first === 'gen') return genDirect(env, genToken, req, url, seg, cors);
      return json({ error: { message: '这个地址没有。生图用 ' + url.origin + '/v1/images/generations 或 ' + url.origin + '/sdapi/v1/txt2img', type: 'invalid_request_error' } }, 404, {}, cors);
    }

    const isMcp = first === 'mcp' || first === 'sse';

    if (!isMcp) {
      // 脚本本体。后缀必须是 .user.js，油猴才会弹安装框；
      // 类型给 text/javascript，不然有些浏览器直接当文件下载
      if (url.pathname === '/yoww.user.js') {
        return new Response(userScript(url.origin), {
          status: 200,
          headers: Object.assign({
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'public, max-age=300',
          }, cors),
        });
      }
      if (first === 's') return scriptApi(env, req, url, url.pathname, cors, ctx);
      if (url.pathname === '/health') {
        return json({ ok: true, name: NAME, version: VERSION,
          // 有哪些功能，一眼看得出跑的是哪一版
          has: ['selftest', 'list', 'format_page', 'custom_tpl', 'token_format', 'token_scopes', 'avatars', 'load_emoji_set', 'img_proxy', 'image_gen', 'userscript'],
          // 装成绘图接口的那几条路径，前端认哪条填哪条
          image_api: ['/v1/images/generations', '/sdapi/v1/txt2img', '/gen?prompt='],
          tools: TOOLS.map(t => t.name) }, 200, {}, cors);
      }
      if (url.pathname === '/script') {
        return new Response(scriptPage(), {
          status: 200,
          headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, cors),
        });
      }
      if (url.pathname === '/format') {
        return new Response(formatPage(), {
          status: 200,
          headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, cors),
        });
      }
      if (url.pathname === '/list') {
        return new Response(listPage(), {
          status: 200,
          headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, cors),
        });
      }
      if (url.pathname === '/selftest') {
        return new Response(selftest(), {
          status: 200,
          headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, cors),
        });
      }
      return new Response(landing(), {
        status: url.pathname === '/' ? 200 : 404,
        headers: Object.assign({ 'content-type': 'text/html; charset=utf-8' }, cors),
      });
    }

    // 无状态：不发会话 id，也就没有会话可以被劫持。
    // GET（服务器主动推）和 DELETE（关会话）都用不上，按规范回 405。
    if (req.method === 'GET' || req.method === 'DELETE') {
      return new Response(null, { status: 405, headers: Object.assign({ allow: 'POST, OPTIONS' }, cors) });
    }
    if (req.method !== 'POST') {
      return new Response(null, { status: 405, headers: Object.assign({ allow: 'POST, OPTIONS' }, cors) });
    }

    let body;
    try { body = await req.json(); }
    catch (e) { return json(rpcErr(null, -32700, 'Parse error'), 400, {}, cors); }

    const token = readToken(req, url);
    // 出图写法。默认 Markdown；自带表情包系统、或者会剥掉外链图片的前端
    // 可以在地址后面加 ?format=url / ?format=both 换一种
    const fmt = url.searchParams.get('format') || '';
    // 预设不够用时，用户可以自己写一行长什么样。/format 那页会帮着拼地址
    const tpl = url.searchParams.get('tpl') || '';
    const proto = req.headers.get('mcp-protocol-version') || '';
    const extra = proto && PROTOCOLS.includes(proto) ? { 'mcp-protocol-version': proto } : {};

    // 一次可以发一批
    if (Array.isArray(body)) {
      const out = [];
      for (const m of body) {
        const r = await handleMessage(env, token, m, origin, fmt, tpl, ctx);
        if (r) out.push(r);
      }
      return out.length ? json(out, 200, extra, cors) : new Response(null, { status: 202, headers: cors });
    }

    const r = await handleMessage(env, token, body, origin, fmt, tpl, ctx);
    // 通知和响应没有 id，规范说回 202 空body
    if (!r) return new Response(null, { status: 202, headers: cors });
    return json(r, 200, extra, cors);
  },
};

/* ---------------- 自检页 ----------------
   来回排查太累了：AI 发不出图的时候，分不清是我们这边坏了、
   还是那个前端 / 模型的问题。这页不经过任何 AI，自己把
   握手 → 列工具 → 搜图 → 真把图渲染出来 走一遍，
   哪一步断了一眼就看得见。 */
function selftest() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Yoww MCP 自检</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;padding:24px 16px;max-width:680px;margin-inline:auto;
      font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
      color:#1b1b1f;background:#fbfaf8}
 @media (prefers-color-scheme:dark){body{color:#e8e6e3;background:#17171a}
   input,pre,.step{background:#26262b!important;border-color:#3a3a42!important}}
 h1{font-size:20px;margin:0 0 4px} .m{color:#8a8681;font-size:13px;margin:0 0 18px}
 input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:14px;
       border:1px solid #ddd8d0;border-radius:10px;background:#fff;color:inherit}
 button{margin-top:10px;padding:10px 18px;font-size:15px;border:none;border-radius:10px;
        background:#3b6ef5;color:#fff;cursor:pointer}
 button:disabled{opacity:.5}
 .step{margin-top:10px;padding:10px 12px;border:1px solid #e6e1d9;border-radius:10px;background:#fff}
 .step b{font-weight:600} .ok{color:#1f8a4c} .bad{color:#c0392b}
 pre{white-space:pre-wrap;word-break:break-all;font-size:12px;margin:6px 0 0;
     padding:8px;border-radius:8px;background:#f3f0ea;border:1px solid #e6e1d9}
 .grid{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
 .cell{width:104px;font-size:11px;text-align:center;word-break:break-all}
 .cell img{width:104px;height:104px;object-fit:contain;border-radius:8px;
           background:#f3f0ea;border:1px solid #e6e1d9;display:block}
</style>
<h1>Yoww MCP 自检</h1>
<p class="m">这页不经过任何 AI。它会自己走一遍握手、列工具、搜图，把图真的渲染出来，最后再单独试一遍绘图接口 —— 哪一步断了一眼就看得见。</p>
<input id="tok" placeholder="把令牌粘进来（yoww_ 开头）" autocomplete="off" spellcheck="false">
<input id="q" placeholder="搜什么词，默认「笑」" style="margin-top:8px" autocomplete="off">
<button id="go">开始检查</button>
<div id="out"></div>
<script>
const $=id=>document.getElementById(id), out=$('out');
function step(name){ const d=document.createElement('div'); d.className='step';
  d.innerHTML='<b>'+name+'</b> <span class="r">检查中…</span>'; out.appendChild(d); return d; }
function mark(d,ok,msg,extra){ d.querySelector('.r').innerHTML=
  '<span class="'+(ok?'ok':'bad')+'">'+(ok?'通过 · ':'没通过 · ')+msg+'</span>';
  if(extra){ const p=document.createElement('pre'); p.textContent=extra; d.appendChild(p); } }
async function call(tok,body){
  const r=await fetch('/mcp',{method:'POST',headers:{'content-type':'application/json',
    ...(tok?{authorization:'Bearer '+tok}:{})},body:JSON.stringify(body)});
  const t=await r.text();
  return { status:r.status, json:(()=>{ try{ return JSON.parse(t); }catch(e){ return null; } })(), raw:t };
}
$('go').addEventListener('click', async ()=>{
  out.innerHTML=''; $('go').disabled=true;
  const tok=$('tok').value.trim(), q=$('q').value.trim()||'笑';
  try{
    let d=step('1. 服务器活着吗');
    const h=await fetch('/health'); const hj=await h.json().catch(()=>null);
    mark(d,h.ok,h.ok?('在，版本 '+(hj&&hj.version)):'HTTP '+h.status);
    if(!h.ok) return;

    d=step('2. 握手（令牌对不对）');
    const init=await call(tok,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'selftest',version:'1'}}});
    const ins=init.json&&init.json.result&&init.json.result.instructions||'';
    const tokOk=ins.includes('当前令牌属于');
    // 失败时只把那句「注意：」拎出来，别把整段给模型看的说明倒给用户
    const warn=ins.slice(ins.indexOf('注意：'));
    mark(d,tokOk,tokOk?ins.slice(ins.lastIndexOf('当前令牌属于')):'令牌没通过',
         tokOk?'':(warn||('HTTP '+init.status+' '+init.raw.slice(0,200))));
    if(!tokOk) return;

    d=step('3. 工具列表');
    const tl=await call(tok,{jsonrpc:'2.0',id:2,method:'tools/list'});
    const names=((tl.json&&tl.json.result&&tl.json.result.tools)||[]).map(t=>t.name);
    // 工具表是按令牌开的权限过滤过的，所以这里不能写死要有哪几个 ——
    // 只开头像的令牌本来就看不到表情那几个，那是对的，不是错
    const hasEmoji=names.includes('search_emojis'), hasAvatar=names.includes('search_avatars');
    mark(d,hasEmoji||hasAvatar,names.length+' 个：'+names.join('、')
      +(hasEmoji||hasAvatar?'':'　这个令牌一项都没开，去站里勾一下'));
    if(!hasEmoji&&!hasAvatar) return;

    d=step(hasEmoji?'4. 搜表情':'4. 搜头像');
    const toolName=hasEmoji?'search_emojis':'search_avatars';
    const args=hasEmoji?{query:q,limit:8}:{limit:8};
    const cr=await call(tok,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:toolName,arguments:args}});
    const res=cr.json&&cr.json.result;
    const sc=(res&&res.structuredContent)||{};
    // 头像那边情侣是一对两张，两张都要验
    const emo=hasEmoji ? (sc.emojis||[])
      : (sc.avatars||[]).flatMap(a=>[{url:a.url,desc:a.title}].concat(a.url2?[{url:a.url2,desc:a.title+' 右'}]:[]));
    mark(d,!!emo.length,emo.length?('拿到 '+emo.length+' 张'):'一张都没拿到',
         emo.length?'':((res&&res.content&&res.content[0]&&res.content[0].text)||cr.raw).slice(0,300));
    if(!emo.length) return;


    d=step('5. 图片能不能真的加载出来');
    const g=document.createElement('div'); g.className='grid'; d.appendChild(g);
    let good=0, done=0;
    const finish=()=>{ if(done===emo.length) mark(d,good===emo.length,
      good+' / '+emo.length+' 张加载成功'+(good<emo.length?'（失败的那几张下面写了地址，发给我）':'')); };
    emo.forEach(e=>{
      const c=document.createElement('div'); c.className='cell';
      const im=new Image(); im.src=e.url; im.alt='';
      const cap=document.createElement('div'); cap.textContent='加载中…';
      im.onload=()=>{ good++; done++; cap.textContent=(e.desc||'').slice(0,14)||'（无描述）'; finish(); };
      im.onerror=()=>{ done++; cap.innerHTML='<span class="bad">加载失败</span><br>'+e.url; finish(); };
      c.appendChild(im); c.appendChild(cap); g.appendChild(c);
    });

    // 第 6 步查的是另一条路：前端把我们当绘图服务调。
    // 这一步通了，就说明"AI 不用贴链接也能出图"那条路是通的 ——
    // 剩下的只是去前端的绘图设置里填两个框
    const d6=step('6. 绘图接口（前端不认链接时走这条）');
    const gr=await fetch('/v1/images/generations',{method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer '+tok},
      body:JSON.stringify({prompt:q,n:1,response_format:'url'})});
    const gj=await gr.json().catch(()=>null);
    const gurl=gj&&gj.data&&gj.data[0]&&gj.data[0].url;
    if(!gurl){ mark(d6,false,'没返回图',
      String((gj&&gj.error&&gj.error.message)||('HTTP '+gr.status)).slice(0,200)); }
    else{
      const g6=document.createElement('div'); g6.className='grid'; d6.appendChild(g6);
      const c6=document.createElement('div'); c6.className='cell';
      const i6=new Image(); i6.src=gurl; i6.alt='';
      const p6=document.createElement('div'); p6.textContent='加载中…';
      i6.onload=()=>{ mark(d6,true,'通了 —— 把绘图地址填进前端的绘图设置就能用');
        p6.textContent=String(gj.data[0].revised_prompt||'').slice(0,14); };
      i6.onerror=()=>{ mark(d6,false,'返回了地址但图打不开',gurl);
        p6.innerHTML='<span class="bad">加载失败</span>'; };
      c6.appendChild(i6); c6.appendChild(p6); g6.appendChild(c6);
    }
  }catch(err){ const d=step('出错了'); mark(d,false,String(err&&err.message||err)); }
  finally{ $('go').disabled=false; }
});
</script>
</html>`;
}

/* ---------------- 脚本安装页 ----------------
   装浏览器脚本这件事，卡人的从来不是技术，是"我到底该点哪儿"。
   所以这页只讲三步，每步一句话，不解释原理 —— 想看原理的往下翻。 */
function scriptPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Yoww 浏览器脚本</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;padding:24px 16px;max-width:680px;margin-inline:auto;
      font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
      color:#1b1b1f;background:#fbfaf8}
 @media (prefers-color-scheme:dark){body{color:#e8e6e3;background:#17171a} pre{background:#26262b!important;border-color:#3a3a42!important}}
 h1{font-size:21px;margin:0 0 4px} h2{font-size:16px;margin:26px 0 6px}
 .m{color:#8a8681;font-size:13px;margin:0 0 20px}
 a.go{display:inline-block;margin:10px 0;padding:11px 20px;border-radius:10px;
      background:#3b6ef5;color:#fff;text-decoration:none;font-size:15px}
 ol{padding-left:20px} li{margin:6px 0}
 pre{white-space:pre-wrap;word-break:break-all;font-size:12px;margin:6px 0;
     padding:9px;border-radius:8px;background:#f3f0ea;border:1px solid #e6e1d9}
 .note{border-left:3px solid #e6e1d9;padding-left:12px;color:#8a8681;font-size:13px}
</style>
<h1>Yoww 浏览器脚本</h1>
<p class="m">在任何 AI 聊天网页里，直接用你在 Yoww 点赞过的表情包。</p>

<h2>装它</h2>
<ol>
<li>浏览器先装 <b>Tampermonkey</b>（油猴）扩展，商店里搜得到。</li>
<li>点下面这个按钮，油猴会弹出安装框，点「安装」。</li>
<li>随便打开一个 AI 聊天网页，右下角会出现一个圆形按钮。点开，把令牌粘进去。</li>
</ol>
<a class="go" href="/yoww.user.js">安装脚本</a>
<p class="note">令牌在 <a href="${SITE}">yoww2026.cn</a> 的「我的 → MCP 接口」里生成，跟接 MCP 用的是同一个，不用另外办。</p>

<h2>它能干什么</h2>
<ul>
<li><b>单张插入</b>：点一张图，就把它写进你正在打字的那个框。你自己发的消息，前端是按 Markdown 渲染的，所以图会正常显示。</li>
<li><b>一次性导入</b>：把你点赞过的所有表情，按你选的写法一股脑填进前端「添加表情」的那个框。
导进去之后，<b>AI 就原生会发这些表情了</b> —— 前端会把它自己那份表情列表塞进提示词，模型挑名字，前端按名字渲染。
不调任何工具，也不会因为一次几十张图把前端拖超时。</li>
</ul>

<h2>为什么只有点赞过的</h2>
<p>站上本来就是「点赞后可下载」。脚本要是能搜全站，等于开了个绕过点赞的后门，
发包的人白干。所以这里能看到什么，跟你在站上能下载什么，是同一条线。</p>
<p>搜到一半发现想要的包没点过赞，脚本会直接告诉你「站里还有 N 个包也有这个词」，
回站里点个赞，刷新一下就有了。</p>
<p class="note">想搜全站的，去接 <a href="/">MCP</a> —— 那条路一直开着，门槛在"要会配 MCP"，不在"我们不给"。</p>

<h2>装不上 / 不出现按钮</h2>
<ul>
<li>右下角没有按钮：油猴里看看这个脚本是不是被停用了，或者当前网站被排除了。</li>
<li>点了图但框里没反应：先在聊天框里点一下（让它获得过焦点），再点图。脚本插的是你<b>最后点过</b>的那个框。</li>
<li>图是裂的：说明图片中转没通，打开 <a href="/selftest">/selftest</a> 跑一遍，第 5 步会直接告诉你。</li>
</ul>
</html>`;
}

/* ---------------- 导出成一份列表 ----------------
   有些前端的表情包是"一份写死在 prompt 里的清单"，而且那份清单允许自己填。
   那种情况下最省事的不是让 AI 来调工具，而是直接把我们的清单给用户，
   让他贴进去 —— 跟前端原本的机制完全一致，零调用、零延迟。 */
function listPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Yoww 表情清单导出</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;padding:24px 16px;max-width:760px;margin-inline:auto;
      font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
      color:#1b1b1f;background:#fbfaf8}
 @media (prefers-color-scheme:dark){body{color:#e8e6e3;background:#17171a}
   input,select,textarea{background:#26262b!important;border-color:#3a3a42!important;color:inherit}}
 h1{font-size:20px;margin:0 0 4px} .m{color:#8a8681;font-size:13px;margin:0 0 18px}
 .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
 input,select{flex:1;min-width:130px;box-sizing:border-box;padding:10px 12px;font-size:14px;
       border:1px solid #ddd8d0;border-radius:10px;background:#fff;color:inherit}
 button{padding:10px 18px;font-size:15px;border:none;border-radius:10px;
        background:#3b6ef5;color:#fff;cursor:pointer}
 button:disabled{opacity:.5}
 textarea{width:100%;box-sizing:border-box;margin-top:12px;height:300px;padding:10px;
          font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
          border:1px solid #ddd8d0;border-radius:10px;background:#fff;color:inherit}
 .st{margin-top:8px;font-size:13px;color:#8a8681}
</style>
<h1>表情清单导出</h1>
<p class="m">有些前端的表情包是一份写死在 prompt 里的清单，而且允许自己填。
那种就不用让 AI 调工具了 —— 在这儿导出，贴进去，跟它原本的机制一模一样，零调用零延迟。</p>
<div class="row"><input id="tok" placeholder="令牌（yoww_ 开头）" autocomplete="off" spellcheck="false"></div>
<div class="row">
  <input id="q" placeholder="主题，留空＝最新的一批">
  <input id="n" type="number" value="60" min="5" max="300" title="要几张">
  <select id="f">
    <option value="md">Markdown：![描述词](链接)</option>
    <option value="tsv">两列：描述词 ⇥ 链接</option>
    <option value="url">只要链接</option>
    <option value="json">JSON</option>
  </select>
</div>
<div class="row"><button id="go">导出</button><button id="cp" disabled>复制</button></div>
<div class="st" id="st"></div>
<textarea id="out" readonly placeholder="导出的清单会出现在这里"></textarea>
<script>
const $=id=>document.getElementById(id);
async function call(tok,body){
  const r=await fetch('/mcp',{method:'POST',headers:{'content-type':'application/json',
    ...(tok?{authorization:'Bearer '+tok}:{})},body:JSON.stringify(body)});
  try{ return JSON.parse(await r.text()); }catch(e){ return null; }
}
$('go').addEventListener('click', async ()=>{
  const tok=$('tok').value.trim(); if(!tok){ $('st').textContent='先把令牌填上'; return; }
  $('go').disabled=true; $('st').textContent='取数据中…';
  const want=Math.min(Math.max(+$('n').value||60,5),300);
  const q=$('q').value.trim();
  let got=[];
  // 一次最多 100，要更多就分几次翻页取
  for(let off=0; got.length<want; off+=100){
    const res=await call(tok,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'load_emoji_set',
      arguments:{query:q,limit:Math.min(100,want-got.length)}}});
    const sc=res&&res.result&&res.result.structuredContent;
    if(!sc||!sc.ok){ $('st').textContent=(res&&res.result&&res.result.content&&res.result.content[0].text)||'取不到，检查令牌'; $('go').disabled=false; return; }
    const fresh=(sc.emojis||[]).filter(e=>!got.some(g=>g.url===e.url));
    if(!fresh.length) break;
    got=got.concat(fresh);
    if((sc.emojis||[]).length<100) break;
  }
  got=got.slice(0,want);
  const f=$('f').value;
  const alt=e=>String(e.desc||'表情').replace(/[\\[\\]\\n\\t]/g,' ').trim()||'表情';
  $('out').value =
    f==='md'   ? got.map(e=>'!['+alt(e)+']('+e.url+')').join('\\n') :
    f==='tsv'  ? got.map(e=>alt(e)+'\\t'+e.url).join('\\n') :
    f==='url'  ? got.map(e=>e.url).join('\\n') :
                 JSON.stringify(got.map(e=>({desc:alt(e),url:e.url})),null,1);
  $('st').textContent='共 '+got.length+' 张。'+(got.length<want?'（站里就这么多）':'');
  $('cp').disabled=!got.length; $('go').disabled=false;
});
$('cp').addEventListener('click', async ()=>{
  try{ await navigator.clipboard.writeText($('out').value); $('st').textContent='已复制'; }
  catch(e){ $('out').select(); $('st').textContent='复制失败，手动全选复制'; }
});
</script>
</html>`;
}

/* ---------------- 出图写法配置 ----------------
   预设那几种不可能覆盖所有前端。与其我这边一个个猜，不如让用户
   自己写一行长什么样，在这页拼好整条 MCP 地址 —— 手动 URL 编码
   一个模板对普通用户是劝退的。 */
function formatPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Yoww MCP 出图写法</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;padding:24px 16px;max-width:720px;margin-inline:auto;
      font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
      color:#1b1b1f;background:#fbfaf8}
 @media (prefers-color-scheme:dark){body{color:#e8e6e3;background:#17171a}
   input,textarea,.box{background:#26262b!important;border-color:#3a3a42!important;color:inherit}}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:22px 0 6px}
 .m{color:#8a8681;font-size:13px;margin:0 0 16px}
 label{display:block;padding:9px 11px;margin-top:8px;border:1px solid #ddd8d0;border-radius:10px;
       background:#fff;cursor:pointer;font-size:14px}
 label.on{border-color:#3b6ef5;box-shadow:0 0 0 2px rgba(59,110,245,.15)}
 label code{font-size:12px;color:#8a8681}
 input,textarea{width:100%;box-sizing:border-box;padding:10px 12px;font-size:14px;
       border:1px solid #ddd8d0;border-radius:10px;background:#fff;color:inherit;
       font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 .box{margin-top:8px;padding:10px 12px;border:1px solid #e6e1d9;border-radius:10px;background:#fff;
      font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
 button{margin-top:10px;padding:10px 18px;font-size:15px;border:none;border-radius:10px;
        background:#3b6ef5;color:#fff;cursor:pointer}
 .st{margin-top:8px;font-size:13px;color:#8a8681}
</style>
<h1>出图写法</h1>
<p class="m">不同前端认的写法不一样。挑一个，或者自己写一行。
下面会拼好一条 MCP 地址，把你现在用的那条换成它就行 —— 令牌不用动。</p>

<div id="opts"></div>

<h2>自己写</h2>
<input id="tpl" placeholder="例如：[图片:{url}]" autocomplete="off" spellcheck="false">
<p class="m" style="margin:6px 0 0">可用：<code>{url}</code> 图片直链　<code>{desc}</code> 描述词　<code>{n}</code> 序号。
必须含 <code>{url}</code>，否则按上面选的预设走。</p>

<h2>预览：AI 会照着发出这样的行</h2>
<div class="box" id="prev"></div>

<h2>把你的 MCP 地址换成这条</h2>
<div class="box" id="urlout"></div>
<button id="cp">复制地址</button>
<div class="st" id="st"></div>

<script>
const PRESETS=[
 ['markdown','Markdown 图片','![{desc}]({url})','大多数前端（Cherry Studio、Chatbox…）'],
 ['plain','描述词 + 链接','{desc} {url}','自带表情包的那类前端最常见的写法'],
 ['url','纯链接','{url}','会自动把链接变成图的那种'],
 ['html','HTML img 标签','<img src="{url}" alt="{desc}">','允许 HTML 的前端'],
 ['both','两种都给','![{desc}]({url})\\n{url}','不确定认哪种时用这个'],
];
const SAMPLE=[{desc:'哈哈哈 笑死',url:'https://img.yoww2026.cn/2026/09/k3x9q2mf7p1a.webp'},
              {desc:'无语',url:'https://img.yoww2026.cn/2026/09/p7m2q9x1k4b3.webp'}];
let picked='markdown';
const $=id=>document.getElementById(id);
$('opts').innerHTML=PRESETS.map(([k,name,tpl,note])=>
  '<label data-k="'+k+'"><b>'+name+'</b> <code>'+tpl.replace(/</g,'&lt;').replace(/\\n/g,' ⏎ ')+'</code><br><code>'+note+'</code></label>').join('');
$('opts').addEventListener('click',e=>{ const l=e.target.closest('label'); if(!l) return;
  picked=l.dataset.k; $('tpl').value=''; draw(); });
$('tpl').addEventListener('input',draw);
function draw(){
  const custom=$('tpl').value;
  const use=custom.includes('{url}')?custom:(PRESETS.find(p=>p[0]===picked)||PRESETS[0])[2];
  document.querySelectorAll('#opts label').forEach(l=>
    l.classList.toggle('on', !custom.includes('{url}') && l.dataset.k===picked));
  $('prev').textContent=SAMPLE.map((e,i)=>use.replace(/\\{url\\}/g,e.url)
    .replace(/\\{desc\\}/g,e.desc).replace(/\\{n\\}/g,String(i+1))).join('\\n');
  const base=location.origin+'/mcp';
  $('urlout').textContent = custom.includes('{url}')
    ? base+'?tpl='+encodeURIComponent(custom)
    : (picked==='markdown' ? base : base+'?format='+picked);
}
$('cp').addEventListener('click',async()=>{
  try{ await navigator.clipboard.writeText($('urlout').textContent); $('st').textContent='已复制，回你的前端把 MCP 地址换成它，然后断开重连一次'; }
  catch(e){ $('st').textContent='复制失败，长按上面那行手动复制'; }
});
draw();
</script>
</html>`;
}

function landing() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yoww MCP 接口</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;padding:32px 20px;font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
       max-width:680px;margin-inline:auto;color:#1b1b1f;background:#fbfaf8}
  @media (prefers-color-scheme:dark){body{color:#e8e6e3;background:#17171a}code,pre{background:#26262b!important}}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:28px 0 8px}
  p,li{margin:8px 0} code{background:#efece7;padding:1px 5px;border-radius:5px;font-size:13px}
  pre{background:#efece7;padding:12px 14px;border-radius:10px;overflow-x:auto;font-size:13px}
  .m{color:#8a8681;font-size:13px}
</style>
<h1>Yoww MCP 接口</h1>
<p class="m">给接了 MCP 的 AI 前端用的。配好之后直接让 AI 帮你找表情包，不用再导出导入。</p>
<h2>怎么配</h2>
<ol>
<li>在 <a href="${SITE}">yoww2026.cn</a> 里打开「我的 → MCP 接口」，生成一个令牌，复制下来（只显示这一次）。</li>
<li>在你的 AI 前端里添加一个 MCP 服务，类型选 <b>Streamable HTTP</b>（不是 stdio），地址填：
<pre>https://mcp.yoww2026.cn/mcp</pre>
再加一个请求头：<pre>Authorization: Bearer 你的令牌</pre></li>
<li>如果你的前端只能填地址、加不了请求头，就把令牌接在地址后面：
<pre>https://mcp.yoww2026.cn/mcp/你的令牌</pre></li>
</ol>
<h2>前端自带表情包的话</h2>
<p>有些前端（自带表情包的那类）是每次把一整份「描述词 + 链接」清单塞进 prompt，
再告诉 AI 想发表情就照某个格式写。那种情况下：</p>
<ul>
<li><b>清单能自己填</b> → 去 <a href="/list">/list</a> 导出一份贴进去，最省事，零调用零延迟。</li>
<li><b>清单填不了</b> → 让 AI 在对话开头调一次 <code>load_emoji_set</code>，
效果一样，之后整段对话它都能直接发，不用再调工具。</li>
<li><b>它内置的表情关不掉</b> → 模型会优先用内置那套（对它来说成本为零）。
在系统提示词里写死「发表情一律用 Yoww」，或者每次明说。</li>
</ul>
<h2>图显示不出来的时候</h2>
<p>不同前端认的写法不一样。到 <a href="${SITE}">yoww2026.cn</a> 的「我的 → MCP 接口」，
点那个令牌的「改写法」—— 写法是<b>跟着令牌</b>走的，一个前端一个令牌，各自设各自的，
改完立刻生效，<b>地址一个字都不用动</b>。</p>
<p>地址永远是 <code>https://mcp.yoww2026.cn/mcp</code>，别往后面加参数：
有些前端会按 MCP 服务配置算哈希拼进工具名，地址一改哈希就变，
老对话里的调用记录跟新的对不上，整个对话会直接报错。</p>
<h2>换写法也没用：把我们当绘图服务</h2>
<p>有一类前端，AI 消息里的图<b>根本不走 Markdown</b> —— 不管 AI 吐的是
<code>![](…)</code>、<code>&lt;img&gt;</code> 还是裸链接，它一律当纯文本显示。
这不是写法问题，是那条路不存在，换几种格式都一样。</p>
<p>但同一个前端，<b>生图是能出图的</b>。因为生图走的是另一条路：
AI 说要画图，前端自己拿着提示词去调绘图 API，拿回来的图由前端自己插进消息里 ——
跟用户自己发的图同一条路，那条一直是通的。</p>
<p>所以我们也同时装成一个绘图服务。AI 说「发个笑死的表情」，
前端把「笑死」当提示词发过来，我们不画，直接从站里挑一张现成的表情回给它，
它当成自己画的显示出来。AI 不用贴链接，你也不用复制粘贴。</p>
<p>在前端的<b>绘图设置</b>里填（密钥就填同一个令牌）：</p>
<ul>
<li>选项里有「OpenAI / DALL·E / 自定义 OpenAI 接口」→ 地址填
<pre>https://mcp.yoww2026.cn/v1</pre></li>
<li>选项里有「Stable Diffusion WebUI / AUTOMATIC1111」→ 地址填
<pre>https://mcp.yoww2026.cn</pre></li>
<li>只能填一条出图网址的 → 填
<pre>https://mcp.yoww2026.cn/gen?prompt={prompt}&amp;key=你的令牌</pre></li>
</ul>
<p>提示词写中文短词最准（「笑死」「无语」「摸头」）。整句英文提示词我们也会自己拆词去搜，
实在搜不到就给一张站里最新的 —— 宁可发得不那么贴切，也不让前端弹一个生图失败。
想要头像就在提示词里带上「头像」两个字。</p>
<p>两条路可以同时接：MCP 那条让 AI 能搜、能看描述词，绘图这条保证图真的显示得出来。</p>
<p>不确定是哪一步出的问题，打开 <a href="/selftest">/selftest</a> 自己跑一遍，
它不经过 AI，直接告诉你是服务器、令牌、搜索还是图片加载断了。</p>
<h2>配好之后能干嘛</h2>
<p>直接跟 AI 说「找几个笑死的表情」「有什么猫猫表情包」「把这个包都发出来」就行。</p>
<h2>说明</h2>
<p>令牌代表你本人，能看到的跟你自己登录站里看到的一样多，不会更多。留言、通知、我的仓库、成员名单这些，这个接口里没有对应的功能，取不到。</p>
<p>令牌随时可以在站里撤销，撤销之后立刻失效。</p>
<p>站里的东西都是大家自己整理上传的，转发和二次修改请照作者标的使用权限来。</p>
</html>`;
}
