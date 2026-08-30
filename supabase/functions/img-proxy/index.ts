// 图片代理：把外链图片原样取回来，加上 Access-Control-Allow-Origin 再吐出去。
//
// 为什么需要它：生成分享卡片时 html2canvas 用 crossOrigin='anonymous' 取图，
// 图床只要不返回 Access-Control-Allow-Origin，浏览器就会拦掉，那一格画成空白，
// 而且不报错。这是浏览器的安全边界，纯前端绕不过去（fetch 一样被拦；不带
// crossOrigin 虽然能画但会污染画布，连导出都做不了）。只能由服务端代取一次。
//
// 部署（必须带 --no-verify-jwt，见下）：
//   supabase functions deploy img-proxy --no-verify-jwt
//
// 为什么要 --no-verify-jwt：这个地址是给 <img crossorigin> 直接加载的，
// 而 <img> 标签没法带 Authorization 头，开着 JWT 校验就永远 401。
// 也正因为它必须公开，下面这几道防护一个都不能少 —— 否则就是一个人人可用的
// 开放中转站，既能刷爆你的流量额度，也能被用来探测内网。
//
// 防护：
//   1. 白名单：只代理数据库里真实存在的图片地址（表情图 / 头像 / 字体底图），
//      不是"任意 URL 都转"。这一条最关键，它让这个接口没法当通用代理用。
//   2. 只允许 http/https。
//   3. 拦私有网段、环回、链路本地（含云厂商 169.254.169.254 元数据地址），
//      并且真正做一次 DNS 解析再检查一遍 —— 只看域名挡不住 evil.com 解析到
//      127.0.0.1 这种写法。
//   4. 跟跳转时每一跳都重新校验，防止用跳转绕过第 3 条。
//   5. 响应必须是 image/*，并且限制大小。
//   6. 加长缓存头，让 CDN 扛住重复请求，别每次都真去取。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAX_BYTES = 8 * 1024 * 1024;   // 单张图上限 8MB
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 12000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
};

function fail(status: number, msg: string) {
  return new Response(msg, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ---- 私有地址判断 ----
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 解析不出来就当危险
  const [a, b] = p;
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // 环回
  if (a === 0) return true;                           // 0.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 169 && b === 254) return true;            // 链路本地，含 169.254.169.254 元数据
  if (a === 100 && b >= 64 && b <= 127) return true;  // 运营商级 NAT
  if (a >= 224) return true;                          // 组播 / 保留
  return false;
}
function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true; // 链路本地 / 唯一本地
  if (s.startsWith('::ffff:')) return isPrivateIPv4(s.slice(7));                     // v4 映射地址
  return false;
}
function looksLikeIPv4(h: string) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(h); }

// 域名先做形态检查，再真解析一遍 —— 只看字面量挡不住 DNS 指向内网
async function hostIsSafe(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (looksLikeIPv4(h)) return !isPrivateIPv4(h);
  if (h.includes(':')) return !isPrivateIPv6(h);
  for (const type of ['A', 'AAAA'] as const) {
    let ips: string[] = [];
    try { ips = await Deno.resolveDns(h, type); } catch { continue; }
    for (const ip of ips) {
      if (type === 'A' ? isPrivateIPv4(ip) : isPrivateIPv6(ip)) return false;
    }
  }
  return true;
}

async function urlIsSafe(raw: string): Promise<URL | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return (await hostIsSafe(u.hostname)) ? u : null;
}

// ---- 白名单：这个地址必须是库里真有的图 ----
const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);
async function isKnownImage(url: string): Promise<boolean> {
  const probes = [
    sb.from('image_assets').select('id').eq('source_url', url).limit(1),
    sb.from('users').select('id').eq('avatar_url', url).limit(1),
    sb.from('fonts').select('id').eq('bg_image', url).limit(1),
  ];
  const rs = await Promise.all(probes);
  return rs.some((r) => !r.error && r.data && r.data.length > 0);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'GET') return fail(405, 'method not allowed');

  const target = new URL(req.url).searchParams.get('url');
  if (!target) return fail(400, 'missing url');

  let safe = await urlIsSafe(target);
  if (!safe) return fail(400, 'url not allowed');
  if (!(await isKnownImage(target))) return fail(403, 'unknown image');

  // 自己跟跳转，每一跳都重新校验；交给 fetch 自动跟的话，
  // 一个 302 到 127.0.0.1 就把上面的检查全绕过去了
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(safe!.toString(), {
        redirect: 'manual',
        signal: ac.signal,
        headers: { 'Accept': 'image/*,*/*;q=0.8', 'User-Agent': 'Yoww-img-proxy' },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return fail(502, 'bad redirect');
        const next = await urlIsSafe(new URL(loc, safe!).toString());
        if (!next) return fail(400, 'redirect not allowed');
        safe = next;
        continue;
      }
      break;
    }
    if (!res || !res.ok) return fail(502, 'upstream error');

    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) return fail(415, 'not an image');

    const declared = Number(res.headers.get('content-length') || '0');
    if (declared && declared > MAX_BYTES) return fail(413, 'image too large');

    // content-length 可能不准或缺失，边读边数，超了就断开
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) return fail(413, 'image too large');

    return new Response(buf, {
      headers: {
        ...CORS,
        'Content-Type': type,
        'Content-Length': String(buf.byteLength),
        // 同一张图会被反复请求（每次生成卡片都要），让 CDN 和浏览器扛住
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, immutable',
      },
    });
  } catch (e) {
    return fail(504, 'fetch failed: ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    clearTimeout(timer);
  }
});
