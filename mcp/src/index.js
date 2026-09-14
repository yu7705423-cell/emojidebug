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
      '⚠️ 这个工具**不返回任何图片**，只有包的标题、作者、张数、使用权限和站内页面地址。' +
      '用户想看到表情图的话，光调它是不够的：要么挑一个包接着调 get_emoji_pack，' +
      '要么一开始就改用 search_emojis。别拿一个站内链接就当答复交出去。\n' +
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
      '返回里带了使用权限（allow_repost / allow_edit / other_permission）—— ' +
      '如果用户问能不能转发、能不能改，照这几个字段如实回答，不要自己替作者决定。',
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
const imgLine = e => `![${altText(e.desc)}](${e.url})`;

const SEND_HINT = '↓ 下面每一行 ![](…) 都是一张图，原样贴进你的回复就能发出去，一次可以发好几张。' +
                  '用户要的是图，不要只回网站链接。';

function fmtEmojis(list, head) {
  if (!list.length) return head + '\n（一张都没搜到，换个近义词再试试）';
  return head + '\n' + SEND_HINT + '\n\n' + list.map((e, i) =>
    `${i + 1}. ${oneLine(e.desc) || '（没写描述词）'}` +
    (e.pack_title ? `　来自《${oneLine(e.pack_title)}》` : '') +
    `\n${imgLine(e)}`).join('\n\n');
}

function fmtPacks(list) {
  if (!list.length) return '没找到符合的表情包。';
  // 这个工具拿不到图。说破它，免得模型拿着一个站内链接就交差 ——
  // 用户想看的是表情，不是一个网页地址。
  return `找到 ${list.length} 个表情包。注意：这里只有包的信息，没有图片。\n` +
         `用户想看图的话，挑一个包用 get_emoji_pack 取图再发；或者直接用 search_emojis 按描述词搜单张。\n` +
         `下面的 yoww2026.cn 链接是站内页面，只在用户明确问「在哪看」「出处」时才给。\n\n` +
    list.map((p, i) => {
      const perm = [p.allow_repost ? '允许二传' : '不允许二传', p.allow_edit ? '允许二改' : '不允许二改']
        .concat(p.other_permission ? ['其他：' + trunc(p.other_permission, 40)] : []).join('、');
      const tags = Array.isArray(p.tags) && p.tags.length ? `  标签：${p.tags.join(' ')}` : '';
      return `${i + 1}. 《${p.title}》  ${p.emoji_count} 张  by ${p.author || '佚名'}` +
             `\n   id: ${p.id}\n   分类：${p.category || '未分类'}${tags}\n   ${perm}\n   站内页面：${p.link}`;
    }).join('\n');
}

async function runTool(env, token, name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const num = (v, d) => (Number.isFinite(+v) ? Math.trunc(+v) : d);

  if (name === 'whoami') {
    const r = await rpc(env, 'mcp_whoami', { p_token: token });
    // 连不上和令牌过期是两回事，别混着报 —— 报错了让人去重办令牌，
    // 结果其实是服务器在抽风，那就白折腾了
    if (!r.ok) return { text: authText(r), err: true };
    return { text: `令牌有效，属于「${r.nickname}」。`, data: r };
  }

  if (name === 'search_emojis') {
    const q = String(a.query == null ? '' : a.query).trim();
    if (!q) return { text: '要搜什么词？', err: true };
    const r = await rpc(env, 'mcp_search_emojis', { p_token: token, p_query: q, p_limit: num(a.limit, 40) });
    if (!r.ok) return { text: authText(r), err: true };
    return { text: fmtEmojis(r.emojis || [], `搜「${q}」找到 ${(r.emojis || []).length} 张：`), data: r };
  }

  if (name === 'search_emoji_packs') {
    const r = await rpc(env, 'mcp_search_packs', {
      p_token: token,
      p_query: String(a.query == null ? '' : a.query).trim(),
      p_category: String(a.category == null ? '' : a.category).trim(),
      p_limit: num(a.limit, 20), p_offset: num(a.offset, 0),
    });
    if (!r.ok) return { text: authText(r), err: true };
    return { text: fmtPacks(r.packs || []), data: r };
  }

  if (name === 'get_emoji_pack') {
    const id = String(a.pack_id == null ? '' : a.pack_id).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { text: 'pack_id 不对，要用 search_emoji_packs 返回的那个 id。', err: true };
    }
    const r = await rpc(env, 'mcp_get_pack', { p_token: token, p_id: id });
    if (!r.ok) return { text: r.error === 'not_found' ? '这个表情包找不到了，可能已经被作者删掉。' : authText(r), err: true };
    const p = r.pack || {};
    const perm = [p.allow_repost ? '允许二传' : '不允许二传', p.allow_edit ? '允许二改' : '不允许二改']
      .concat(p.other_permission ? ['其他：' + trunc(p.other_permission, 60)] : []).join('、');
    const head = `《${p.title}》 by ${p.author || '佚名'}  共 ${r.emoji_count} 张\n使用权限：${perm}\n${p.link}\n`;
    return { text: fmtEmojis(r.emojis || [], head), data: r };
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

async function handleMessage(env, token, msg) {
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
      return rpcOk(id, {
        protocolVersion: ver,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, title: 'Yoww 表情包', version: VERSION },
        instructions:
          'Yoww 是一个表情包 / 字体分享站。\n' +
          '用户要表情的时候，**直接把图发出来**：工具返回里 ![](…) 那些行原样贴进你的回复即可，' +
          '一次贴好几行就是一次发好几张，像聊天时甩表情一样。不要只回一个网站链接 —— ' +
          '用户要的是图，不是网页。\n' +
          '首选 search_emojis（按描述词搜单张，直接出图）。search_emoji_packs 只返回包的信息、' +
          '不含图片，光靠它没法发图，需要图就接着调 get_emoji_pack。\n' +
          'yoww2026.cn/?collection=… 这类站内链接，只在用户明确问「在哪看」「出处是什么」时才给。\n' +
          '这些内容都是站里的人自己整理上传的：用户问能不能转发或二次修改时，' +
          '照返回里的 allow_repost / allow_edit / other_permission 如实说，别自己替作者做主。' + note,
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
      const out = await runTool(env, token, p.name, p.arguments);
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

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const first = url.pathname.split('/').filter(Boolean)[0] || '';
    const isMcp = first === 'mcp' || first === 'sse';

    if (!isMcp) {
      if (url.pathname === '/health') return json({ ok: true, name: NAME, version: VERSION });
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
    const proto = req.headers.get('mcp-protocol-version') || '';
    const extra = proto && PROTOCOLS.includes(proto) ? { 'mcp-protocol-version': proto } : {};

    // 一次可以发一批
    if (Array.isArray(body)) {
      const out = [];
      for (const m of body) {
        const r = await handleMessage(env, token, m);
        if (r) out.push(r);
      }
      return out.length ? json(out, 200, extra) : new Response(null, { status: 202, headers: CORS });
    }

    const r = await handleMessage(env, token, body);
    // 通知和响应没有 id，规范说回 202 空body
    if (!r) return new Response(null, { status: 202, headers: CORS });
    return json(r, 200, extra);
  },
};

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
<h2>配好之后能干嘛</h2>
<p>直接跟 AI 说「找几个笑死的表情」「有什么猫猫表情包」「把这个包都发出来」就行。</p>
<h2>说明</h2>
<p>令牌代表你本人，能看到的跟你自己登录站里看到的一样多，不会更多。留言、通知、我的仓库、成员名单这些，这个接口里没有对应的功能，取不到。</p>
<p>令牌随时可以在站里撤销，撤销之后立刻失效。</p>
<p>站里的东西都是大家自己整理上传的，转发和二次修改请照作者标的使用权限来。</p>
</html>`;
}
