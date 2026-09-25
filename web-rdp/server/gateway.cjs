const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const GuacamoleLite = require('guacamole-lite');

const listenHost = process.env.REMOTE_CODEX_WEB_BIND_HOST || '127.0.0.1';
const listenPort = Number(process.env.REMOTE_CODEX_WEB_PORT || 8180);
const websocketPort = Number(process.env.REMOTE_CODEX_GUAC_WS_PORT || 8181);
const relayUrl = String(process.env.REMOTE_CODEX_RELAY_URL || 'http://127.0.0.1:18765').replace(/\/$/, '');
const controllerToken = String(process.env.REMOTE_CODEX_CONTROLLER_TOKEN || '');
const webPassword = String(process.env.REMOTE_CODEX_WEB_PASSWORD || '');
const guacKey = String(process.env.REMOTE_CODEX_GUAC_KEY || '');
// Windows 支持标准 NLA。避免让 FreeRDP 同时请求多种协议后被服务端
// 升级到兼容性较差的 HYBRID_EX；需要排障时可通过环境变量切换。
const rdpSecurity = String(process.env.REMOTE_CODEX_RDP_SECURITY || 'nla').trim().toLowerCase();
const staticRoot = path.resolve(__dirname, '../dist');

if (!controllerToken || !webPassword || Buffer.byteLength(guacKey) !== 32) {
  throw new Error('缺少网关配置：需要控制令牌、网页访问口令和 32 字节 Guacamole 密钥');
}

const sessions = new Map();
const sessionLifetimeMs = 12 * 60 * 60 * 1000;

const guacServer = new GuacamoleLite(
  { host: listenHost, port: websocketPort },
  { host: '127.0.0.1', port: Number(process.env.REMOTE_CODEX_GUACD_PORT || 4822) },
  { crypt: { cypher: 'AES-256-CBC', key: guacKey } },
);
guacServer.on('error', (error) => console.error(JSON.stringify({ time: new Date().toISOString(), event: 'guac.error', error: error.message })));

function log(event, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...extra }));
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
}

function authenticated(request) {
  const token = parseCookies(request).rc_web_session;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}

async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('无效的 JSON 请求'); }
}

async function relay(path, options = {}) {
  const response = await fetch(`${relayUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${controllerToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `中继返回 HTTP ${response.status}`);
  return body;
}

function encryptedConnectionToken(connection) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(guacKey), iv);
  let value = cipher.update(JSON.stringify({ connection }), 'utf8', 'base64');
  value += cipher.final('base64');
  return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), value })).toString('base64');
}

function normalizeWindowsCredentials(value) {
  const raw = String(value || '').trim();
  const slash = raw.lastIndexOf('\\');
  if (slash > 0 && slash < raw.length - 1) {
    return { domain: raw.slice(0, slash), username: raw.slice(slash + 1) };
  }
  const at = raw.lastIndexOf('@');
  if (at > 0 && at < raw.length - 1) {
    return { domain: raw.slice(at + 1), username: raw.slice(0, at) };
  }
  return { domain: '', username: raw };
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://gateway.local');
  if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true });

  if (request.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/ws')) {
    const relative = url.pathname.replace(/^\/+/, '') || 'index.html';
    const candidate = path.resolve(staticRoot, relative);
    if (candidate === staticRoot || candidate.startsWith(`${staticRoot}${path.sep}`)) {
      const file = fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(staticRoot, 'index.html');
      if (fs.existsSync(file)) {
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon' };
        response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(response);
      }
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/login') {
    const input = await readJson(request);
    const supplied = Buffer.from(String(input.password || ''));
    const expected = Buffer.from(webPassword);
    const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (!valid) return sendJson(response, 401, { error: '访问口令不正确' });
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + sessionLifetimeMs);
    response.writeHead(204, { 'Set-Cookie': `rc_web_session=${encodeURIComponent(token)}; Path=/remote-codex/web-rdp/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionLifetimeMs / 1000}`, 'Cache-Control': 'no-store' });
    response.end();
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/logout') {
    sessions.delete(parseCookies(request).rc_web_session);
    response.writeHead(204, { 'Set-Cookie': 'rc_web_session=; Path=/remote-codex/web-rdp/; HttpOnly; Secure; SameSite=Strict; Max-Age=0', 'Cache-Control': 'no-store' });
    response.end();
    return;
  }

  if (!authenticated(request)) return sendJson(response, 401, { error: '登录已失效' });

  if (request.method === 'GET' && url.pathname === '/api/devices') {
    const result = await relay('/v1/devices');
    return sendJson(response, 200, { devices: result.devices.filter((device) => device.platform === 'win32' || device.platform === 'windows') });
  }

  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    const input = await readJson(request);
    const deviceId = String(input.deviceId || '');
    const suppliedUsername = String(input.username || '').trim();
    const password = String(input.password || '');
    const ttlSeconds = Number(input.ttlSeconds) === 0 ? 0 : Math.max(300, Math.min(86400, Number(input.ttlSeconds) || 43200));
    if (!deviceId || !suppliedUsername || !password || suppliedUsername.length > 255 || password.length > 1024) return sendJson(response, 400, { error: '请填写有效的 Windows 用户名和密码' });
    const { domain, username } = normalizeWindowsCredentials(suppliedUsername);
    const devices = (await relay('/v1/devices')).devices;
    const device = devices.find((item) => item.id === deviceId && (item.platform === 'win32' || item.platform === 'windows'));
    if (!device) return sendJson(response, 404, { error: '设备不存在或不是 Windows 设备' });
    if (!device.online) return sendJson(response, 409, { error: '设备当前离线' });
    const rdpSession = await relay('/v1/rdp/sessions', { method: 'POST', body: JSON.stringify({ deviceId, username, ttlSeconds }) });
    const token = encryptedConnectionToken({
      type: 'rdp',
      settings: {
        hostname: '127.0.0.1', port: String(rdpSession.port), username, password,
        ...(domain ? { domain } : {}),
        width: 1920, height: 1080, dpi: 96,
        security: rdpSecurity, 'ignore-cert': true, 'enable-wallpaper': false,
        'enable-font-smoothing': true, 'enable-desktop-composition': false,
        'resize-method': 'display-update', 'color-depth': 32,
      },
    });
    log('web_rdp.created', { deviceId, rdpSessionId: rdpSession.id, port: rdpSession.port, security: rdpSecurity, hasDomain: Boolean(domain) });
    return sendJson(response, 201, {
      id: rdpSession.id,
      deviceName: device.hostname || device.id,
      websocketPath: `/remote-codex/web-rdp/ws?token=${encodeURIComponent(token)}`,
    });
  }

  const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]+)$/);
  if (request.method === 'DELETE' && match) {
    await relay(`/v1/rdp/sessions/${match[1]}`, { method: 'DELETE' });
    log('web_rdp.closed', { rdpSessionId: match[1] });
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  return sendJson(response, 404, { error: '接口不存在' });
}

const httpServer = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    log('web.error', { message: error.message });
    if (!response.headersSent) sendJson(response, 500, { error: error.message || '服务器错误' });
    else response.destroy();
  });
});
httpServer.listen(listenPort, listenHost, () => log('web.started', { host: listenHost, port: listenPort, websocketPort }));

function shutdown() {
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(token);
}, 60_000).unref();
