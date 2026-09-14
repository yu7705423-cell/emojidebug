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
const VERSION = '1.0.0';
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

/* ---------------- 工具定义 ----------------
   description 这几段是给模型看的，不是给人看的。写清楚"什么时候该调我"
   比写清楚"我是什么"重要得多。 */
const TOOLS = [
  {
    name: 'load_emoji_set',
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
        limit: { type: 'integer', description: '载入几张，默认 60，最多 100。太多会占上下文' },
      },
    },
  },
  {
    name: 'search_emojis',
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
        limit: { type: 'integer', description: '最多返回几张，默认 40，最多 100' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_emoji_packs',
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
    title: '取一个表情包里的全部图',
    description:
      '按 pack_id 取一个表情包的全部图片，顺序跟站上一致，每张都带一行拼好的 ![](…)，' +
      '原样贴进回复就能发出去。' +
      '用户说「把这个包都发出来」「这个包里有什么」时用。' +
      '返回里带了使用权限（allow_repost / allow_edit / other_permission），' +
      '那是给「用户问能不能转载 / 能不能二次修改」时如实回答用的；' +
      '把图发给用户看不受它们限制，照发就行。',
    inputSchema: {
      type: 'object',
      properties: { pack_id: { type: 'string', description: 'search_emoji_packs 返回的 id' } },
      required: ['pack_id'],
    },
  },
  {
    name: 'list_categories',
    title: '看有哪些分类',
    description: '列出站里所有表情包分类和各自的数量。不知道该往哪个方向搜的时候先调它。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_fonts',
    title: '搜字体',
    description: '搜站里分享的字体，返回名字、分类、下载直链和站内链接。query 留空就是列最新的。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '字体名或作者昵称；留空表示不过滤' },
        limit: { type: 'integer', description: '最多返回几个，默认 20，最多 50' },
      },
    },
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
      signal: AbortSignal.timeout(20000),
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

async function sign(env, text) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.IMG_SIGN_KEY || 'yoww'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
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
  // 自家图床不用中转
  const base = env.IMG_BASE || '';
  if (base && url.startsWith(base)) return url;
  const payload = b64u.enc(url);
  // 强制 https：本地跑的时候 origin 可能是 http，那种地址贴进 https 的前端
  // 会被当成混合内容直接拦掉，又是一次"图加载失败"
  const secure = origin.replace(/^http:/, 'https:');
  // 结尾带个扩展名，有些渲染器按扩展名才认它是图
  const ext = (/\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.exec(url) || [, 'webp'])[1].toLowerCase();
  return `${secure}/i/${await sign(env, payload)}/${payload}.${ext}`;
}

// 一批图一起换成中转地址，顺手把取不到的丢掉
async function withProxy(env, list, origin) {
  return Promise.all((list || []).map(async e =>
    Object.assign({}, e, { url: await proxyUrl(env, e.url, origin) })));
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
  markdown: { label: 'Markdown 图片', line: e => `![${altText(e.desc)}](${e.url})`,
              hint: '↓ 下面每一行 ![](…) 都是一张图，原样贴进你的回复就能发出去，一次可以发好几张。用户要的是图，不要只回网站链接。' },
  url:      { label: '纯链接',        line: e => e.url,
              hint: '↓ 每张图给的是直链，单独一行原样贴进回复即可，这个前端会自己把它变成图。别改写、别加说明文字在同一行。' },
  both:     { label: '两种都给',      line: e => `![${altText(e.desc)}](${e.url})\n${e.url}`,
              hint: '↓ 每张图给了两种写法（Markdown 一行、纯链接一行）。挑你所在环境能显示成图片的那一种贴出去，只贴一种，别两种都贴。' },
};
const fmtOf = name => FORMATS[name] || FORMATS.markdown;

function fmtEmojis(list, head, fmt) {
  if (!list.length) return head + '\n（一张都没搜到，换个近义词再试试）';
  const f = fmtOf(fmt);
  return head + '\n' + f.hint + '\n\n' + list.map((e, i) =>
    `${i + 1}. ${oneLine(e.desc) || '（没写描述词）'}` +
    (e.pack_title ? `　来自《${oneLine(e.pack_title)}》` : '') +
    `\n${f.line(e)}`).join('\n\n');
}

const PREVIEW_PACKS = 6;   // 给几个包配预览图
const PREVIEW_EACH  = 4;   // 每个包配几张

function fmtPacks(list, fmt) {
  if (!list.length) return '没找到符合的表情包。';
  const f = fmtOf(fmt);
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
               ? '\n' + p.preview.map(f.line).join('\n')
               : '');
    }).join('\n\n');
}

async function runTool(env, token, name, args, origin, fmt) {
  const a = args && typeof args === 'object' ? args : {};
  const num = (v, d) => (Number.isFinite(+v) ? Math.trunc(+v) : d);

  if (name === 'whoami') {
    const r = await rpc(env, 'mcp_whoami', { p_token: token });
    // 连不上和令牌过期是两回事，别混着报 —— 报错了让人去重办令牌，
    // 结果其实是服务器在抽风，那就白折腾了
    if (!r.ok) return { text: authText(r), err: true };
    return { text: `令牌有效，属于「${r.nickname}」。`, data: r };
  }

  if (name === 'load_emoji_set') {
    const want = Math.min(Math.max(num(a.limit, 60), 5), 100);
    const q = String(a.query == null ? '' : a.query).trim();
    let list = [];

    if (q) {
      const r = await rpc(env, 'mcp_search_emojis', { p_token: token, p_query: q, p_limit: want });
      if (!r.ok) return { text: authText(r), err: true };
      list = r.emojis || [];
    } else {
      // 不挑主题时按包取：一包一包往里装，装够为止。
      // 这样载入的是成套的，比按词搜出来的零散图更像"一套表情"。
      const ps = await rpc(env, 'mcp_search_packs', { p_token: token, p_query: '', p_category: '', p_limit: 12 });
      if (!ps.ok) return { text: authText(ps), err: true };
      for (const p of ps.packs || []) {
        if (list.length >= want) break;
        const one = await rpc(env, 'mcp_get_pack', { p_token: token, p_id: p.id });
        if (one && one.ok && Array.isArray(one.emojis)) list = list.concat(one.emojis);
      }
      list = list.slice(0, want);
    }

    if (!list.length) return { text: q ? `没找到「${q}」相关的表情，换个词再试。` : '站里还没有表情。', err: true };

    const withUrls = await withProxy(env, list, origin);
    const f = fmtOf(fmt);
    const text =
      `已载入 ${withUrls.length} 张表情${q ? `（主题：${q}）` : ''}。\n\n` +
      `【接下来怎么用】想发表情的时候，从下面这份列表里挑一行，原样贴进你的回复就发出去了，\n` +
      `一次贴好几行就是一次发好几张。**不用再调用任何工具**，这份列表整段对话里一直有效。\n` +
      `挑的依据是每行括号前的描述词。不确定发什么就别硬发，宁可不发。\n` +
      `列表里没有合适的，再用 search_emojis 按词搜。\n\n` +
      withUrls.map(e => f.line(e)).join('\n');
    return { text, data: { ok: true, count: withUrls.length, emojis: withUrls } };
  }

  if (name === 'search_emojis') {
    const q = String(a.query == null ? '' : a.query).trim();
    if (!q) return { text: '要搜什么词？', err: true };
    const r = await rpc(env, 'mcp_search_emojis', { p_token: token, p_query: q, p_limit: num(a.limit, 40) });
    if (!r.ok) return { text: authText(r), err: true };
    const list = await withProxy(env, r.emojis, origin);
    return { text: fmtEmojis(list, `搜「${q}」找到 ${list.length} 张：`, fmt), data: { ok: true, emojis: list } };
  }

  if (name === 'search_emoji_packs') {
    const r = await rpc(env, 'mcp_search_packs', {
      p_token: token,
      p_query: String(a.query == null ? '' : a.query).trim(),
      p_category: String(a.category == null ? '' : a.category).trim(),
      p_limit: num(a.limit, 20), p_offset: num(a.offset, 0),
    });
    if (!r.ok) return { text: authText(r), err: true };
    const packs = r.packs || [];

    // 顺手把前几个包的头几张图取回来。
    // 不这么做的话，模型调完这个工具手上一张图都没有，多半就拿个站内链接交差了 ——
    // 用户要的是表情，不是网址。并行发，取不到就算了，不能因为预览失败让整次搜索失败。
    await Promise.all(packs.slice(0, PREVIEW_PACKS).map(async p => {
      const one = await rpc(env, 'mcp_get_pack', { p_token: token, p_id: p.id });
      if (one && one.ok && Array.isArray(one.emojis)) {
        p.preview = await withProxy(env, one.emojis.slice(0, PREVIEW_EACH), origin);
      }
    }));

    return { text: fmtPacks(packs, fmt), data: r };
  }

  if (name === 'get_emoji_pack') {
    const id = String(a.pack_id == null ? '' : a.pack_id).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { text: 'pack_id 不对，要用 search_emoji_packs 返回的那个 id。', err: true };
    }
    const r = await rpc(env, 'mcp_get_pack', { p_token: token, p_id: id });
    if (!r.ok) return { text: r.error === 'not_found' ? '这个表情包找不到了，可能已经被作者删掉。' : authText(r), err: true };
    const p = r.pack || {};
    const head = `《${p.title}》 by ${p.author || '佚名'}  共 ${r.emoji_count} 张\n` +
                 `转载/二改条款（只在用户问起时才提，不影响你现在发图）：${permLine(p)}\n${p.link}\n`;
    const list = await withProxy(env, r.emojis, origin);
    return { text: fmtEmojis(list, head, fmt), data: Object.assign({}, r, { emojis: list }) };
  }

  if (name === 'list_categories') {
    const r = await rpc(env, 'mcp_list_categories', { p_token: token });
    if (!r.ok) return { text: authText(r), err: true };
    return { text: '分类：\n' + (r.categories || []).map(c => `· ${c.name}（${c.pack_count}）`).join('\n'), data: r };
  }

  if (name === 'search_fonts') {
    const r = await rpc(env, 'mcp_search_fonts', {
      p_token: token, p_query: String(a.query == null ? '' : a.query).trim(), p_limit: num(a.limit, 20),
    });
    if (!r.ok) return { text: authText(r), err: true };
    const list = r.fonts || [];
    if (!list.length) return { text: '没找到符合的字体。', data: r };
    return {
      text: `找到 ${list.length} 个字体：\n` + list.map((f, i) =>
        `${i + 1}. ${f.name}  分类：${f.category || '未分类'}  by ${f.author || '佚名'}` +
        `\n   下载：${f.url || '（作者没填链接）'}\n   ${f.link}`).join('\n'),
      data: r,
    };
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

async function handleMessage(env, token, msg, origin, fmt) {
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
        note = '\n\n⚠️ 没有检测到令牌。请在这个 MCP 服务的地址后面加上你的令牌，' +
               '或者配一个 Authorization: Bearer <令牌> 的请求头。令牌在 ' + SITE + ' 的「我的 → MCP 接口」里生成。';
      } else {
        const who = await rpc(env, 'mcp_whoami', { p_token: token });
        if (!who.ok) note = '\n\n⚠️ 令牌无效、已撤销或已过期，现在什么都搜不到。到 ' + SITE + ' 的「我的 → MCP 接口」重新生成一个。';
        else note = `\n\n当前令牌属于「${who.nickname}」。`;
      }
      const f = fmtOf(fmt);
      return rpcOk(id, {
        protocolVersion: ver,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, title: 'Yoww 表情包', version: VERSION },
        instructions:
          'Yoww 是一个表情包 / 字体分享站。\n' +
          `用户要表情的时候，**直接把图发出来**：工具返回里那几行（当前出图写法：${f.label}）原样贴进你的回复即可，` +
          '一次贴好几行就是一次发好几张，像聊天时甩表情一样。不要只回一个网站链接 —— ' +
          '用户要的是图，不是网页。\n' +
          '**推荐用法**：对话一开始先调一次 load_emoji_set，把一批表情载进来；' +
          '之后整段对话里想发表情就从那批里挑一行贴出去，不用再调工具。' +
          '这样发表情是零成本的，该发就发，别因为"要先查"而放弃。\n' +
          '载入的那批里没有合适的，再用 search_emojis 按词搜单张；' +
          'search_emoji_packs 按包搜、会附预览图；get_emoji_pack 取某个包的全部。都会出图。\n' +
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
    case 'tools/list':
      return rpcOk(id, { tools: TOOLS });
    case 'tools/call': {
      const p = msg.params || {};
      if (!token) {
        return rpcOk(id, {
          content: [{ type: 'text', text: '还没配令牌。到 ' + SITE + ' 的「我的 → MCP 接口」生成一个，填进这个 MCP 服务的配置里。' }],
          isError: true,
        });
      }
      const out = await runTool(env, token, p.name, p.arguments, origin, fmt);
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

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS, extra),
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = url.origin;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const seg = url.pathname.split('/').filter(Boolean);
    const first = seg[0] || '';

    // 图片中转：/i/<签名>/<编码过的原链接>.<扩展名>
    if (first === 'i') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: Object.assign({ allow: 'GET, HEAD' }, CORS) });
      }
      if (seg.length < 3) return new Response('bad request', { status: 400, headers: CORS });
      const payload = seg.slice(2).join('/').replace(/\.[a-z0-9]+$/i, '');
      return serveImage(env, url, seg[1], payload);
    }

    const isMcp = first === 'mcp' || first === 'sse';

    if (!isMcp) {
      if (url.pathname === '/health') return json({ ok: true, name: NAME, version: VERSION });
      if (url.pathname === '/list') {
        return new Response(listPage(), {
          status: 200,
          headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, CORS),
        });
      }
      if (url.pathname === '/selftest') {
        return new Response(selftest(), {
          status: 200,
          headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, CORS),
        });
      }
      return new Response(landing(), {
        status: url.pathname === '/' ? 200 : 404,
        headers: Object.assign({ 'content-type': 'text/html; charset=utf-8' }, CORS),
      });
    }

    // 无状态：不发会话 id，也就没有会话可以被劫持。
    // GET（服务器主动推）和 DELETE（关会话）都用不上，按规范回 405。
    if (req.method === 'GET' || req.method === 'DELETE') {
      return new Response(null, { status: 405, headers: Object.assign({ allow: 'POST, OPTIONS' }, CORS) });
    }
    if (req.method !== 'POST') {
      return new Response(null, { status: 405, headers: Object.assign({ allow: 'POST, OPTIONS' }, CORS) });
    }

    let body;
    try { body = await req.json(); }
    catch (e) { return json(rpcErr(null, -32700, 'Parse error'), 400); }

    const token = readToken(req, url);
    // 出图写法。默认 Markdown；自带表情包系统、或者会剥掉外链图片的前端
    // 可以在地址后面加 ?format=url / ?format=both 换一种
    const fmt = url.searchParams.get('format') || '';
    const proto = req.headers.get('mcp-protocol-version') || '';
    const extra = proto && PROTOCOLS.includes(proto) ? { 'mcp-protocol-version': proto } : {};

    // 一次可以发一批
    if (Array.isArray(body)) {
      const out = [];
      for (const m of body) {
        const r = await handleMessage(env, token, m, origin, fmt);
        if (r) out.push(r);
      }
      return out.length ? json(out, 200, extra) : new Response(null, { status: 202, headers: CORS });
    }

    const r = await handleMessage(env, token, body, origin, fmt);
    // 通知和响应没有 id，规范说回 202 空body
    if (!r) return new Response(null, { status: 202, headers: CORS });
    return json(r, 200, extra);
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
<p class="m">这页不经过任何 AI。它会自己走一遍握手、列工具、搜图，并把图真的渲染出来 —— 哪一步断了一眼就看得见。</p>
<input id="tok" placeholder="把令牌粘进来（yoww_ 开头）" autocomplete="off" spellcheck="false">
<input id="q" placeholder="搜什么词，默认「笑」" style="margin-top:8px" autocomplete="off">
<button id="go">开始检查</button>
<div id="out"></div>
<script>
const $=id=>document.getElementById(id), out=$('out');
function step(name){ const d=document.createElement('div'); d.className='step';
  d.innerHTML='<b>'+name+'</b> <span class="r">检查中…</span>'; out.appendChild(d); return d; }
function mark(d,ok,msg,extra){ d.querySelector('.r').innerHTML=
  '<span class="'+(ok?'ok':'bad')+'">'+(ok?'✅ ':'❌ ')+msg+'</span>';
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
    // 失败时只把那句 ⚠️ 拎出来，别把整段给模型看的说明倒给用户
    const warn=ins.slice(ins.indexOf('⚠️'));
    mark(d,tokOk,tokOk?ins.slice(ins.lastIndexOf('当前令牌属于')):'令牌没通过',
         tokOk?'':(warn||('HTTP '+init.status+' '+init.raw.slice(0,200))));
    if(!tokOk) return;

    d=step('3. 工具列表');
    const tl=await call(tok,{jsonrpc:'2.0',id:2,method:'tools/list'});
    const names=((tl.json&&tl.json.result&&tl.json.result.tools)||[]).map(t=>t.name);
    mark(d,names.length===6,names.length+' 个：'+names.join('、'));

    d=step('4. 搜图');
    const cr=await call(tok,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'search_emojis',arguments:{query:q,limit:8}}});
    const res=cr.json&&cr.json.result;
    const emo=(res&&res.structuredContent&&res.structuredContent.emojis)||[];
    mark(d,!!emo.length,emo.length?('搜「'+q+'」拿到 '+emo.length+' 张'):'一张都没拿到',
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
  }catch(err){ const d=step('出错了'); mark(d,false,String(err&&err.message||err)); }
  finally{ $('go').disabled=false; }
});
</script>
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
<p>有些前端（尤其自带表情包功能的那类）不渲染 Markdown 图片，或者会把外链图片剥掉。
把服务地址后面加个参数换一种写法：</p>
<pre>https://mcp.yoww2026.cn/mcp?format=url    纯链接
https://mcp.yoww2026.cn/mcp?format=both   两种都给，让 AI 自己挑</pre>
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
