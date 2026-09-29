/**
 * 本地小服务（零第三方依赖，Node 18+ 自带 fetch 即可运行）
 *
 *   1. 静态托管当前目录（index.html、图片等）
 *   2. POST /api/remove-bg   转发到 Replicate 的 lucataco/remove-bg
 *   3. GET  /api/health      供前端自检：服务在不在、token 有没有
 *   4. GET  /api/fetch-image 结果图下载代理（带域名白名单，避免 SSRF）
 *
 * 启动：
 *   set REPLICATE_API_TOKEN=r8_xxx   (Windows CMD)
 *   $env:REPLICATE_API_TOKEN="r8_xxx" (PowerShell)
 *   node server.js
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT  = Number(process.env.PORT) || 5173;
const ROOT  = __dirname;
const MAX_BODY = 25 * 1024 * 1024;           // 请求体上限 25MB
const POLL_TIMEOUT = 90 * 1000;              // 模型最长等待 90 秒

/* lucataco/remove-bg 的固定版本，避免以后latest变动导致行为不一致 */
const MODEL_VERSION =
  '95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1';

/* ==========================================================
   1. 密钥：优先读真实环境变量，其次读项目根目录的 .env
      （.env 只是本地图省事，真正部署时请用系统环境变量）
      注意：环境变量只在进程启动时读一次，改完要重启服务。
   ========================================================== */
function envKey(name) {
  const fromEnv = (process.env[name] || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = txt.match(new RegExp('^\\s*' + name + '\\s*=\\s*(.+?)\\s*$', 'm'));
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  } catch (_) { /* 没有 .env 就忽略 */ }
  return '';
}
const TOKEN  = envKey('REPLICATE_API_TOKEN');   // 去背景用
const OR_KEY = envKey('OPENROUTER_API_KEY');    // 文生图用

/* ==========================================================
   2. 小工具
   ========================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif':  'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico':  'image/x-icon', '.md': 'text/markdown; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8'
};

const sendJSON = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 读请求体，顺带挡住过大的请求 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) {
      req.destroy();
      throw Object.assign(new Error('请求体过大（上限 25MB）'), { status: 413 });
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* 上游（Replicate / OpenRouter）的错误码翻成中文，页面上看得懂。
   措辞保持中立，因为两套接口共用这张表。 */
const FRIENDLY = {
  401: '上游拒绝了请求：API Key 无效或已过期，检查一下环境变量里的 Key',
  403: '上游拒绝了请求：这个 Key 没有调用该模型的权限',
  402: '上游账户额度不足，去对应平台充值后再试',
  404: '模型或接口不存在（可能版本 ID 已失效）',
  422: '上游认为输入不合规：',
  429: '请求太频繁被限流了，稍等半分钟再试'
};
const friendly = (status, detail) =>
  FRIENDLY[status] ? (status === 422 ? FRIENDLY[422] + detail : FRIENDLY[status]) : detail;

/* Replicate 返回的错误信息藏在 detail / title 里，尽量还原原文 */
async function upstreamError(res) {
  let detail = `Replicate 返回 ${res.status}`;
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      detail = j.detail || j.title || j.message || t;
    } catch (_) { if (t) detail = t; }
  } catch (_) {}
  return detail.slice(0, 500);
}

/* ==========================================================
   3. 核心：调用 remove-bg
   ========================================================== */

/* 大图先传到 Replicate 的文件存储，拿一个 URL 再喂给模型。
   Replicate 官方建议：Data URL 只用于 256KB 以内的小图，大图用 URL。 */
async function uploadFile(buf, mime) {
  const ext  = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const bnd  = '----wb' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  const body = Buffer.concat([
    Buffer.from(
      `--${bnd}${CRLF}` +
      `Content-Disposition: form-data; name="content"; filename="upload.${ext}"${CRLF}` +
      `Content-Type: ${mime}${CRLF}${CRLF}`, 'utf8'),
    buf,
    Buffer.from(`${CRLF}--${bnd}--${CRLF}`, 'utf8')
  ]);

  const r = await fetch('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': `multipart/form-data; boundary=${bnd}`
    },
    body
  });
  if (!r.ok) throw new Error(await upstreamError(r));
  const j = await r.json();
  if (!j.urls || !j.urls.get) throw new Error('上传后没拿到文件地址');
  return j.urls.get;                       // 有效期 24 小时，够用
}

async function createPrediction(imageInput) {
  const r = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: 'wait'          // 让 Replicate 尽量同步等结果（最多约 60s）
    },
    body: JSON.stringify({ version: MODEL_VERSION, input: { image: imageInput } })
  });
  if (!r.ok) {
    const err = new Error(friendly(r.status, await upstreamError(r)));
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function waitForResult(prediction) {
  const started = Date.now();
  let p = prediction;
  // 该模型输出是单个 uri 字符串（有的模型返回数组，一起兼容）
  const outOf = q => Array.isArray(q && q.output) ? q.output[0] : q.output;

  while (true) {
    const out = outOf(p);
    if (typeof out === 'string' && out) return out;   // 有结果就直接用

    if (p.status === 'failed' || p.status === 'canceled')
      throw new Error(p.error || `处理失败（状态：${p.status}）`);
    if (p.status === 'succeeded' || p.status === 'successful')
      throw new Error('模型跑完了但没返回图片地址');

    if (Date.now() - started > POLL_TIMEOUT) throw new Error('模型处理超时，请稍后再试');
    await sleep(1000);
    const url = (p.urls && p.urls.get) || `https://api.replicate.com/v1/predictions/${p.id}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) throw new Error(friendly(r.status, await upstreamError(r)));
    p = await r.json();
  }
}

/* ==========================================================
   4. 请求处理
   ========================================================== */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const full = path.join(ROOT, rel);
  // 目录穿越防护：解析后的路径必须仍在 ROOT 之内
  if (!full.startsWith(ROOT + path.sep) && full !== path.join(ROOT, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found'); return; }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* 下载代理只允许 Replicate 自己的域名，避免被当成任意 URL 代理 */
const ALLOWED_HOSTS = ['replicate.delivery', 'api.replicate.com', 'pbxt.replicate.delivery'];
async function proxyImage(req, res, url) {
  let u;
  try { u = new URL(url); } catch (_) { return sendJSON(res, 400, { error: '下载地址不合法' }); }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) {
    return sendJSON(res, 400, { error: '不允许下载该地址的图片' });
  }
  const r = await fetch(u.href);
  if (!r.ok) return sendJSON(res, 502, { error: '下载结果图失败' });
  const buf = Buffer.from(await r.arrayBuffer());
  const name = (path.basename(u.pathname) || 'result').replace(/[^\w.-]/g, '');
  res.writeHead(200, {
    'Content-Type': r.headers.get('content-type') || 'image/png',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename*=UTF-8''remove-bg-${name}`
  });
  res.end(buf);
}

/* ==========================================================
   5. 文生图：OpenRouter（openai/gpt-5.4-image-2）
   ----------------------------------------------------------
   优先用专用图像接口 /api/v1/images，开 stream 拿到中间帧，
   边生成边把预览推给前端（这个模型 P50 要 76 秒，没有预览体验很差）。
   万一该模型不支持这个接口，回退到 chat completions + modalities。
   ========================================================== */
const OR_MODEL   = 'openai/gpt-5.4-image-2';
const OR_ENDPOINT = 'https://openrouter.ai/api/v1/images';
const OR_CHAT     = 'https://openrouter.ai/api/v1/chat/completions';

const sse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

const orHeaders = () => ({
  Authorization: `Bearer ${OR_KEY}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': `http://localhost:${PORT}`,
  'X-Title': 'My Personal Homepage'
});

/* 回退方案：chat completions，图片在 message.images 里 */
async function generateViaChat(res, prompt) {
  const r = await fetch(OR_CHAT, {
    method: 'POST',
    headers: orHeaders(),
    body: JSON.stringify({
      model: OR_MODEL,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error(friendly(r.status, await upstreamError(r)));

  const j = await r.json();
  const msg  = j.choices && j.choices[0] && j.choices[0].message;
  const imgs = (msg && msg.images) || [];
  const url  = imgs[0] && imgs[0].image_url && imgs[0].image_url.url;
  if (!url) throw new Error('模型没有返回图片');

  const m = String(url).match(/^data:([^;,]+);base64,([\s\S]+)$/);
  if (!m) throw new Error('返回的图片格式无法解析');
  sse(res, { type: 'done', b64: m[2], mediaType: m[1], cost: j.usage && j.usage.cost, via: 'chat' });
}

async function streamImage(res, opts) {
  sse(res, { type: 'start', model: OR_MODEL });

  let r;
  try {
    r = await fetch(OR_ENDPOINT, {
      method: 'POST',
      headers: orHeaders(),
      body: JSON.stringify({
        model: OR_MODEL,
        prompt: opts.prompt,
        n: 1,
        aspect_ratio: opts.aspect_ratio,
        quality: opts.quality,
        background: opts.background,
        stream: true
      })
    });
  } catch (e) {
    return sse(res, { type: 'error', message: '连不上 OpenRouter：' + e.message });
  }

  if (!r.ok) {
    const detail = await upstreamError(r);
    // 404/400 多半是这个模型不走专用图像接口，换 chat completions 试一次
    if (r.status === 404 || r.status === 400) {
      console.warn('[image] 专用图像接口不可用（' + r.status + '），改用 chat completions');
      try { return await generateViaChat(res, opts.prompt); }
      catch (e) { return sse(res, { type: 'error', message: e.message }); }
    }
    return sse(res, { type: 'error', message: friendly(r.status, detail) });
  }

  // 有些情况不返回 SSE，直接给完整结果
  if (!(r.headers.get('content-type') || '').includes('event-stream')) {
    const j = await r.json().catch(() => null);
    const first = j && j.data && j.data[0];
    if (!first || !first.b64_json) return sse(res, { type: 'error', message: 'OpenRouter 没有返回图片' });
    return sse(res, {
      type: 'done', b64: first.b64_json,
      mediaType: first.media_type || 'image/png',
      cost: j.usage && j.usage.cost
    });
  }

  // SSE：转发中间帧和最终结果
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', lastPartial = 0, gotDone = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = raw.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let ev;
        try { ev = JSON.parse(payload); } catch (_) { continue; }

        if (ev.type === 'image_generation.partial_image' && ev.b64_json) {
          const now = Date.now();
          if (now - lastPartial < 800) continue;      // 轻微节流，别刷太猛
          lastPartial = now;
          sse(res, { type: 'partial', b64: ev.b64_json });
        } else if (ev.type === 'image_generation.completed' && ev.b64_json) {
          gotDone = true;
          sse(res, {
            type: 'done', b64: ev.b64_json,
            mediaType: ev.media_type || 'image/png',
            cost: ev.usage && ev.usage.cost
          });
        } else if (ev.type === 'error') {
          sse(res, { type: 'error', message: (ev.error && ev.error.message) || '生成失败' });
        }
      }
    }
    if (!gotDone) sse(res, { type: 'error', message: '生成流提前结束，没有拿到最终图片' });
  } catch (e) {
    sse(res, { type: 'error', message: '读取生成流中断：' + e.message });
  }
}

/* ----------------------------------------------------------
   跨源放行：本服务只监听 127.0.0.1，但页面可能被别的本地工具托管
   （比如编辑器/预览面板跑在 127.0.0.1:48412）。
   只放行本机来源，外部网站（https://evil.com）会被拒掉，
   免得有人在网页里偷偷调你的接口烧额度。
   ---------------------------------------------------------- */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;                          // 同源请求 / 命令行调用
  if (origin !== 'null' && !LOCAL_ORIGIN.test(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
  return true;
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!applyCors(req, res)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Origin not allowed');
  }
  if (req.method === 'OPTIONS') {                    // CORS 预检
    res.writeHead(204);
    return res.end();
  }

  /* ---- 自检 ---- */
  if (pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, token: !!TOKEN, orKey: !!OR_KEY, port: PORT });
  }

  /* ---- 文生图（SSE 流式） ---- */
  if (pathname === '/api/generate-image') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: '请用 POST' });

    let payload;
    try { payload = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }

    const prompt = String(payload.prompt || '').trim();
    if (!prompt)                 return sendJSON(res, 400, { error: '先写一句画面描述' });
    if (prompt.length > 4000)    return sendJSON(res, 400, { error: '描述太长了（上限 4000 字）' });
    if (!OR_KEY)                 return sendJSON(res, 500, { error: '服务端未配置 OPENROUTER_API_KEY，设置环境变量后重启服务' });

    const allow = v => ['1:1','16:9','9:16','4:3','3:4'].includes(v) ? v : '1:1';
    const opts = {
      prompt,
      aspect_ratio: allow(payload.aspect_ratio),
      quality:    ['auto','low','medium','high'].includes(payload.quality) ? payload.quality : 'high',
      background: ['auto','transparent','opaque'].includes(payload.background) ? payload.background : 'auto'
    };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'          // 关掉反代缓冲，保证中间帧实时到
    });
    try { await streamImage(res, opts); } catch (e) { sse(res, { type: 'error', message: e.message }); }
    return res.end();
  }

  /* ---- 结果图下载 ---- */
  if (pathname === '/api/fetch-image') {
    try { return await proxyImage(req, res, searchParams.get('url')); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  /* ---- 去背景 ---- */
  if (pathname === '/api/remove-bg') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: '请用 POST' });

    const chunks = [];
    let size = 0;
    try {
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); return sendJSON(res, 413, { error: '图片太大了（上限 25MB）' }); }
        chunks.push(c);
      }
      const { image } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const m = typeof image === 'string'
        ? image.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([\s\S]+)$/i) : null;
      if (!m) return sendJSON(res, 400, { error: '图片格式不支持，请上传 PNG / JPG / WebP / GIF' });
      if (!TOKEN) return sendJSON(res, 500, { error: '服务端未配置 REPLICATE_API_TOKEN，请先设置环境变量后重启服务' });

      const mime = m[1].toLowerCase();
      const buf  = Buffer.from(m[2], 'base64');
      if (!buf.length) return sendJSON(res, 400, { error: '图片内容为空，换一张试试' });

      // 小图直接传 data URI；大图先传到 Replicate 文件存储，拿 URL 再跑模型
      let input = image;
      if (buf.length > 256 * 1024) {
        try { input = await uploadFile(buf, mime); }
        catch (e) {
          console.warn('[remove-bg] 文件上传失败，改用 data URI：', e.message);
          input = image;                    // 兜底：还是塞 data URI 试一次
        }
      }

      const output = await waitForResult(await createPrediction(input));
      return sendJSON(res, 200, { output });
    } catch (e) {
      return sendJSON(res, e.status && e.status < 500 ? e.status : 500, { error: e.message || '处理失败' });
    }
  }

  /* ---- 静态文件 ---- */
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);

  res.writeHead(405).end('Method Not Allowed');
});

// 只监听本机，不对外暴露
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  个人主页已启动  →  http://localhost:' + PORT);
  console.log('  Replicate Token: ' + (TOKEN ? '已读取 ✓' : '未检测到 ✗  （去背景功能不可用）'));
  if (!TOKEN) console.log('  设置方法: PowerShell 执行  $env:REPLICATE_API_TOKEN="r8_你的token"  然后重启本服务');
  console.log('  OpenRouter Key:  ' + (OR_KEY ? '已读取 ✓' : '未检测到 ✗  （文生图功能不可用）'));
  if (!OR_KEY) console.log('  设置方法: PowerShell 执行  $env:OPENROUTER_API_KEY="sk-or-v1-你的key"  然后重启本服务');
  console.log('  停止服务: Ctrl + C');
  console.log('');
});
