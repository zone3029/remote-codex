const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn } = require('node:child_process');
const selfsigned = require('selfsigned');

const DEFAULT_PORT = 32145;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const EMPTY_SHA256 = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function secureEqualHex(actual, expected) {
  if (!/^[a-f0-9]{64}$/i.test(actual || '') || !/^[a-f0-9]{64}$/i.test(expected || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function createIdentity(directory) {
  const certificatePath = path.join(directory, 'lan-cert.pem');
  const keyPath = path.join(directory, 'lan-key.pem');
  const secretPath = path.join(directory, 'lan-secret.txt');
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(certificatePath) || !fs.existsSync(keyPath)) {
    const pair = selfsigned.generate([{ name: 'commonName', value: 'Remote Codex LAN' }], { days: 3650, keySize: 2048, algorithm: 'sha256' });
    fs.writeFileSync(certificatePath, pair.cert, { mode: 0o600 });
    fs.writeFileSync(keyPath, pair.private, { mode: 0o600 });
  }
  if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const certificate = fs.readFileSync(certificatePath, 'utf8');
  const key = fs.readFileSync(keyPath, 'utf8');
  const secret = fs.readFileSync(secretPath, 'utf8').trim();
  const fingerprint256 = new crypto.X509Certificate(certificate).fingerprint256.replaceAll(':', '').toUpperCase();
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('局域网控制密钥无效');
  return { certificate, key, secret, fingerprint256 };
}

function readJson(request, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > limit) request.destroy(new Error('请求正文过大'));
      else chunks.push(Buffer.from(chunk));
    });
    request.once('error', reject);
    request.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('JSON 格式无效')); }
    });
  });
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  response.end(body);
}

function authorize(request, response, deviceId, secret, nonces) {
  const timestamp = String(request.headers['x-remote-codex-timestamp'] || '');
  const nonce = String(request.headers['x-remote-codex-nonce'] || '');
  const ticketExpires = String(request.headers['x-remote-codex-ticket-expires'] || '');
  const ticketNonce = String(request.headers['x-remote-codex-ticket-nonce'] || '');
  const bodySha256 = String(request.headers['x-content-sha256'] || EMPTY_SHA256).toLowerCase();
  const signature = String(request.headers['x-remote-codex-signature'] || '').toLowerCase();
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 60_000 || Number(ticketExpires) * 1000 < Date.now() || !/^[a-f0-9]{32}$/i.test(nonce) || !/^[a-f0-9]{32}$/i.test(ticketNonce)) {
    sendJson(response, 401, { error: '局域网授权票据已失效' });
    return false;
  }
  if (nonces.has(nonce)) {
    sendJson(response, 409, { error: '局域网授权票据已使用' });
    return false;
  }
  const ticketKey = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(`${deviceId}\n${ticketExpires}\n${ticketNonce}`).digest();
  const canonical = `${timestamp}\n${nonce}\n${request.method}\n${request.url}\n${bodySha256}`;
  const expected = crypto.createHmac('sha256', ticketKey).update(canonical).digest('hex');
  if (!secureEqualHex(signature, expected)) {
    sendJson(response, 401, { error: '局域网授权签名无效' });
    return false;
  }
  nonces.set(nonce, Date.now());
  return true;
}

function absoluteWindowsPath(value) {
  const result = String(value || '');
  if (!path.win32.isAbsolute(result) || result.includes('\0')) throw new Error('远程文件路径必须是绝对 Windows 路径');
  return result;
}

function replaceFileAtomically(temporary, destination) {
  const backup = `${destination}.remote-codex-${crypto.randomUUID()}.bak`;
  const hadDestination = fs.existsSync(destination);
  try {
    if (hadDestination) fs.renameSync(destination, backup);
    fs.renameSync(temporary, destination);
    if (hadDestination) fs.unlinkSync(backup);
  } catch (error) {
    if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination);
    throw error;
  }
}

function hashFileSha256(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filename);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

function enableFirewall(port, writeLog) {
  if (process.platform !== 'win32') return;
  const command = `netsh advfirewall firewall delete rule name="Remote Codex Agent LAN" >nul 2>&1 & netsh advfirewall firewall add rule name="Remote Codex Agent LAN" dir=in action=allow protocol=TCP localport=${port} profile=private`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.on('error', (error) => writeLog('error', 'lan.firewall_failed', { error: error.message }));
  child.on('close', (code) => writeLog(code === 0 ? 'info' : 'error', 'lan.firewall_configured', { exitCode: code, output: output.trim().slice(0, 1024) }));
}

function startLanServer({ userData, deviceId, port = DEFAULT_PORT, host = '0.0.0.0', configureFirewall = true, writeLog, submitCommand, commandStatus, cancelCommand, completedTransfers = new Map(), transferCompleted = () => {} }) {
  const identity = createIdentity(path.join(userData, 'lan-control'));
  const nonces = new Map();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const server = https.createServer({ key: identity.key, cert: identity.certificate }, async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/lan/health') return sendJson(response, 200, { ok: true, protocol: 1 });
      if (!authorize(request, response, deviceId, identity.secret, nonces)) return;
      const url = new URL(request.url, 'https://remote-codex-lan.local');
      if (request.method === 'POST' && url.pathname === '/v1/lan/commands') return sendJson(response, 202, submitCommand(await readJson(request)));
      const commandMatch = url.pathname.match(/^\/v1\/lan\/commands\/([a-f0-9-]{36})$/i);
      if (request.method === 'GET' && commandMatch) {
        const result = commandStatus(commandMatch[1]);
        return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: '任务不存在' });
      }
      if (request.method === 'DELETE' && commandMatch) return sendJson(response, 202, await cancelCommand(commandMatch[1]));
      if (request.method === 'PUT' && url.pathname === '/v1/lan/files') {
        const transferId = String(request.headers['x-transfer-id'] || '');
        if (!/^[a-f0-9-]{36}$/i.test(transferId)) throw new Error('文件传输 ID 无效');
        if (completedTransfers.has(transferId)) return sendJson(response, 200, completedTransfers.get(transferId));
        const destination = absoluteWindowsPath(url.searchParams.get('path'));
        const expectedSha = String(request.headers['x-content-sha256'] || '').toLowerCase();
        const expectedSize = Number(request.headers['content-length']);
        if (!/^[a-f0-9]{64}$/.test(expectedSha) || !Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error('缺少有效的文件大小或 SHA-256');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.remote-codex-${crypto.randomUUID()}.part`;
        const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
        const hash = crypto.createHash('sha256');
        let size = 0;
        try {
          for await (const chunk of request) {
            size += chunk.length;
            hash.update(chunk);
            if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
          }
          await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
          const actualSha = hash.digest('hex');
          if (size !== expectedSize || !secureEqualHex(actualSha, expectedSha)) throw new Error('文件大小或 SHA-256 校验失败');
          replaceFileAtomically(temporary, destination);
          const result = { id: transferId, path: destination, size, sha256: actualSha, transport: 'lan', status: 'completed' };
          completedTransfers.set(transferId, result);
          transferCompleted(result);
          writeLog('info', 'lan.file_uploaded', { transferId, path: destination, size, sha256: actualSha });
          return sendJson(response, 201, result);
        } catch (error) { output.destroy(); try { fs.unlinkSync(temporary); } catch {} throw error; }
      }
      if (request.method === 'GET' && url.pathname === '/v1/lan/files') {
        const source = absoluteWindowsPath(url.searchParams.get('path'));
        const stat = fs.statSync(source);
        if (!stat.isFile()) throw new Error('远程路径不是文件');
        const sha256 = await hashFileSha256(source);
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'X-Content-Sha256': sha256, 'Cache-Control': 'no-store' });
        return fs.createReadStream(source).pipe(response);
      }
      const transferMatch = url.pathname.match(/^\/v1\/lan\/transfers\/([a-f0-9-]{36})$/i);
      if (request.method === 'GET' && transferMatch) {
        const result = completedTransfers.get(transferMatch[1]);
        return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: '传输记录不存在' });
      }
      return sendJson(response, 404, { error: '接口不存在' });
    } catch (error) {
      writeLog('error', 'lan.request_failed', { method: request.method, url: request.url, error: error.message });
      if (!response.headersSent) sendJson(response, error.code === 'ENOENT' ? 404 : 400, { error: error.message });
      else response.destroy();
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 15_000;
  server.listen(port, host, () => {
    const address = server.address();
    if (address && typeof address === 'object') api.port = address.port;
    api.available = true;
    writeLog('info', 'lan.server_started', { port: api.port, fingerprint256: identity.fingerprint256 });
    if (configureFirewall) enableFirewall(api.port, writeLog);
    resolveReady(true);
  });
  server.on('error', (error) => { api.port = 0; api.available = false; writeLog('error', 'lan.server_failed', { port, error: error.message }); resolveReady(false); });
  const nonceTimer = setInterval(() => {
    const cutoff = Date.now() - 120_000;
    for (const [nonce, usedAt] of nonces) if (usedAt < cutoff) nonces.delete(nonce);
    if (completedTransfers.size > 1000) completedTransfers.delete(completedTransfers.keys().next().value);
  }, 60_000);
  nonceTimer.unref();
  const api = {
    port: 0,
    available: false,
    ready,
    secret: identity.secret,
    fingerprint256: identity.fingerprint256,
    completedTransfer: (id) => completedTransfers.get(id) || null,
    close: () => { clearInterval(nonceTimer); server.close(); },
  };
  return api;
}

module.exports = { DEFAULT_PORT, EMPTY_SHA256, startLanServer };
