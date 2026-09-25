/*
 * This process deliberately does not import Electron. Windows may suspend an
 * Electron application after its window is minimized; the relay connection
 * must remain independent from that application event loop.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { privateIpv4Addresses } = require('./network-addresses');
const { appendLog } = require('./log-file');
const { startLanServer } = require('./lan-server');
const { executeInteractive, isInteractiveCommand } = require('./interactive-bridge');

const userData = process.env.REMOTE_CODEX_USER_DATA;
const appVersion = process.env.REMOTE_CODEX_APP_VERSION || 'unknown';
const appRoot = process.env.REMOTE_CODEX_APP_ROOT || __dirname;
if (!userData) throw new Error('REMOTE_CODEX_USER_DATA is required');

const embeddedConfig = require(path.join(appRoot, 'embedded-config.json'));
const statePath = path.join(userData, 'worker-state.json');
const operationHistoryPath = path.join(userData, 'operation-history.json');
const commandDirectory = path.join(userData, 'worker-commands');
const logFile = path.join(userData, 'agent.log');
const identity = JSON.parse(fs.readFileSync(path.join(userData, 'identity.json'), 'utf8'));
const relayConfigPath = path.join(userData, 'relay-config.json');
function normalizeRelayConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const parsed = new URL(String(source.server || '').trim());
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('中继服务器必须使用无凭据 HTTPS 地址');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const enrollmentToken = String(source.enrollmentToken || '').trim();
  const fingerprint = String(source.certificateFingerprint256 || '').replace(/[\s:-]/g, '').toUpperCase();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(enrollmentToken)) throw new Error('注册令牌无效');
  if (!/^[A-F0-9]{64}$/.test(fingerprint)) throw new Error('证书指纹无效');
  return { server: parsed.toString().replace(/\/$/, ''), enrollmentToken, certificateFingerprint256: fingerprint, allowInsecure: false };
}
function loadRelayConfig() {
  try { return normalizeRelayConfig(JSON.parse(fs.readFileSync(relayConfigPath, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') writeLog('error', 'relay_config.invalid', { error: errorValue(error) }); return null; }
}
let config = { ...embeddedConfig, ...(loadRelayConfig() || {}), ...identity };
const MAX_OUTPUT = 2 * 1024 * 1024;
let stopped = false;
let polling = false;
let status = { state: 'starting', message: '正在启动后台连接' };
let rdpStatus = { state: 'starting', message: '正在自动启动永久远程桌面', sessionId: '', host: '', port: 0, username: '', expiresAt: '', ttlSeconds: 0 };
let rdpTunnel = null;
let rdpAutoStartEnabled = true;
let rdpEnsurePending = false;
let lastPollStartedAt = null;
let lastPollCompletedAt = null;
let lanAddresses = privateIpv4Addresses();
const activeCommands = new Map();
const operationHistory = loadOperationHistory();
const commandResults = new Map(operationHistory.commands.map((value) => [value.id, value]));
const completedTransfers = new Map(operationHistory.transfers.map((value) => [value.id, value]));
const verifiedCertificateHosts = new Set();
let lanServer = null;

function errorValue(error) {
  if (!error) return null;
  return { name: error.name, message: error.message, code: error.code, stack: error.stack, cause: error.cause ? errorValue(error.cause) : null };
}
function writeLog(level, event, details = {}) {
  const entry = { time: new Date().toISOString(), level, event, process: 'worker', pid: process.pid, ...details };
  appendLog(logFile, entry);
  console.log(JSON.stringify(entry));
}
function writeJsonAtomically(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}
function loadOperationHistory() {
  try {
    const value = JSON.parse(fs.readFileSync(operationHistoryPath, 'utf8'));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return {
      commands: (Array.isArray(value.commands) ? value.commands : []).filter((item) => item?.id && Date.parse(item.completedAt || 0) >= cutoff).slice(-5),
      transfers: (Array.isArray(value.transfers) ? value.transfers : []).filter((item) => item?.id && Date.parse(item.completedAt || 0) >= cutoff).slice(-200),
    };
  } catch { return { commands: [], transfers: [] }; }
}
function persistOperationHistory() {
  const commands = [...commandResults.values()].slice(-5);
  const transfers = [...completedTransfers.values()].slice(-200);
  writeJsonAtomically(operationHistoryPath, { updatedAt: new Date().toISOString(), commands, transfers });
}
function publishState() {
  try {
    writeJsonAtomically(statePath, {
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status,
      rdpStatus,
      activeCommands: [...activeCommands.values()].map((command) => ({
        id: command.id,
        pid: command.child?.pid || null,
        startedAt: command.startedAt,
        timeoutSeconds: command.timeoutSeconds,
        cancellationRequested: Boolean(command.cancellationRequested),
      })),
      lastPollStartedAt,
      lastPollCompletedAt,
      lanAddresses,
      lanPort: lanServer?.port || 0,
      lanFingerprint256: lanServer?.fingerprint256 || '',
    });
  } catch (error) { writeLog('error', 'worker.state_write_failed', { error: errorValue(error) }); }
}
function setStatus(next) { status = { ...status, ...next, at: new Date().toISOString() }; publishState(); }
function setRdpStatus(next) { rdpStatus = { ...rdpStatus, ...next, at: new Date().toISOString() }; publishState(); }
function publishTaskStatus() {
  const count = activeCommands.size;
  setStatus(count
    ? { state: 'running', message: `正在执行 ${count} 个任务` }
    : { state: 'online', message: '中继连接正常，等待任务' });
}
function endpoint(pathname) { return `${config.server}${pathname}`; }
function authHeaders(extra = {}) { return { Authorization: `Bearer ${config.agentToken}`, ...extra }; }
function workspace() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(userData, 'workspace.json'), 'utf8')).path;
    return fs.statSync(value).isDirectory() ? value : '';
  } catch { return ''; }
}
function deviceAlias() {
  try {
    const alias = String(JSON.parse(fs.readFileSync(path.join(userData, 'identity.json'), 'utf8')).alias || '').trim().replace(/\s+/g, ' ');
    return alias.length <= 64 && !/[\u0000-\u001f\u007f]/.test(alias) ? alias : '';
  } catch { return ''; }
}
function rdpUsername() { return identity.windowsUsername || `${os.hostname()}\\${os.userInfo().username}`; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
    input.once('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

function relayStreamRequest(pathname, { method = 'GET', headers = {}, input = null, output = null, timeoutMs = 0 } = {}) {
  const target = new URL(endpoint(pathname));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => { if (!settled) { settled = true; callback(value); } };
    const req = https.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || 443, path: `${target.pathname}${target.search}`, method, headers: authHeaders(headers), agent: false, rejectUnauthorized: false, servername: net.isIP(target.hostname) ? undefined : target.hostname }, (response) => {
      response.once('aborted', () => finish(reject, new Error('文件传输响应被中断')));
      response.once('error', (error) => finish(reject, error));
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('end', () => finish(reject, new Error(`文件传输失败：HTTP ${response.statusCode} ${Buffer.concat(chunks).toString('utf8').slice(0, 512)}`)));
        return;
      }
      if (output) {
        response.pipe(output);
        output.once('finish', () => finish(resolve, { status: response.statusCode || 0, headers: response.headers }));
        output.once('error', (error) => finish(reject, error));
      } else {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('end', () => finish(resolve, { status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
      }
    });
    req.once('socket', (socket) => socket.once('secureConnect', () => {
      try {
        const expected = String(config.certificateFingerprint256 || '').replaceAll(':', '').toUpperCase();
        const actual = crypto.createHash('sha256').update(socket.getPeerCertificate(true).raw).digest('hex').toUpperCase();
        if (actual !== expected) req.destroy(new Error('中继证书指纹不匹配'));
      } catch (error) { req.destroy(error); }
    }));
    req.once('error', (error) => finish(reject, error));
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error('文件传输超时')));
    if (input) { input.once('error', (error) => req.destroy(error)); input.pipe(req); } else req.end();
  });
}

function request(url, options = {}, timeoutMs = 45000) {
  const target = new URL(url);
  const routineRequest = /\/v1\/agent\/(?:poll|cancel|transfers\/poll)$/.test(target.pathname);
  const method = options.method || 'GET';
  const body = options.body == null ? null : (Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body)));
  const headers = { ...(options.headers || {}) };
  if (body && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) headers['Content-Length'] = String(body.length);
  if (!routineRequest) writeLog('debug', 'http.request', { method, url, timeoutMs });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; writeLog('error', 'http.error', { method, url, error: errorValue(error) }); reject(error); } };
    const req = https.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || 443, path: `${target.pathname}${target.search}`, method, headers, agent: false, rejectUnauthorized: false, servername: net.isIP(target.hostname) ? undefined : target.hostname }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', fail);
      response.once('end', () => {
        if (settled) return;
        settled = true;
        const data = Buffer.concat(chunks);
        const get = (name) => { const value = response.headers[String(name).toLowerCase()]; return Array.isArray(value) ? value.join(', ') : (value == null ? null : String(value)); };
        if (!routineRequest) writeLog('debug', 'http.response', { method, url, status: response.statusCode || 0 });
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode || 0, headers: { get }, text: async () => data.toString('utf8'), json: async () => JSON.parse(data.toString('utf8')) });
      });
    });
    req.once('socket', (socket) => socket.once('secureConnect', () => {
      try {
        const expected = String(config.certificateFingerprint256 || '').replaceAll(':', '').toUpperCase();
        const certificate = socket.getPeerCertificate(true);
        const actual = crypto.createHash('sha256').update(certificate.raw).digest('hex').toUpperCase();
        const accepted = Boolean(expected) && actual === expected;
        if (!accepted || !verifiedCertificateHosts.has(target.hostname)) {
          writeLog(accepted ? 'info' : 'error', 'certificate.verify', { hostname: target.hostname, expectedFingerprint256: expected, actualFingerprint256: actual, accepted });
          if (accepted) verifiedCertificateHosts.add(target.hostname);
        }
        if (!accepted) { const error = new Error('中继证书指纹不匹配'); req.destroy(error); fail(error); }
      } catch (error) { req.destroy(error); fail(error); }
    }));
    req.setTimeout(timeoutMs, () => { const error = new Error('请求超时'); req.destroy(error); fail(error); });
    req.once('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function register() {
  setStatus({ state: 'registering', message: '正在注册此电脑' });
  lanAddresses = privateIpv4Addresses();
  const response = await request(endpoint('/v1/agent/register'), { method: 'POST', headers: { Authorization: `Bearer ${config.enrollmentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: config.deviceId, agentToken: config.agentToken, hostname: os.hostname(), username: rdpUsername(), platform: process.platform, arch: process.arch, appVersion, alias: deviceAlias(), lanAddresses, lanPort: lanServer?.port || 0, lanFingerprint256: lanServer?.fingerprint256 || '', lanSecret: lanServer?.secret || '' }) }, 15000);
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.deviceId !== config.deviceId) throw new Error(`注册失败：HTTP ${response.status}${result.error ? ` ${result.error}` : ''}`);
  writeLog('info', 'device.registered', { deviceId: config.deviceId });
}

function clientFrame(payload, opcode = 2) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  else if (body.length <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(body.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}
function parseFrames(state, chunk, receive) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0]; const second = state.buffer[1]; let offset = 2; let length = second & 0x7f;
    if (length === 126) { if (state.buffer.length < 4) return; length = state.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (state.buffer.length < 10) return; const large = state.buffer.readBigUInt64BE(2); if (large > BigInt(8 * 1024 * 1024)) throw new Error('RDP 数据帧过大'); length = Number(large); offset = 10; }
    const masked = Boolean(second & 0x80); const total = offset + (masked ? 4 : 0) + length;
    if (state.buffer.length < total) return;
    const payload = Buffer.from(state.buffer.subarray(offset + (masked ? 4 : 0), total));
    if (masked) { const mask = state.buffer.subarray(offset, offset + 4); for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]; }
    state.buffer = state.buffer.subarray(total); receive(first & 0x0f, payload);
  }
}
function openWebSocket(sessionId) {
  return new Promise((resolve, reject) => {
    const relay = new URL(config.server);
    const expected = String(config.certificateFingerprint256 || '').replaceAll(':', '').toUpperCase();
    const socket = tls.connect({ host: relay.hostname, port: Number(relay.port || 443), servername: net.isIP(relay.hostname) ? undefined : relay.hostname, rejectUnauthorized: false });
    socket.setKeepAlive(true, 15000);
    socket.setTimeout(0);
    let opened = false; let header = Buffer.alloc(0); const frames = { buffer: Buffer.alloc(0) };
    const fail = (error) => { if (!opened) reject(error); else writeLog('error', 'rdp.websocket_error', { sessionId, error: errorValue(error) }); socket.destroy(); };
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      try {
        const actual = crypto.createHash('sha256').update(socket.getPeerCertificate(true).raw).digest('hex').toUpperCase();
        if (!expected || actual !== expected) throw new Error('RDP 中继证书指纹不匹配');
        const key = crypto.randomBytes(16).toString('base64');
        const requestPath = `${relay.pathname.replace(/\/$/, '')}/v1/agent/rdp?device_id=${encodeURIComponent(config.deviceId)}&session_id=${encodeURIComponent(sessionId)}`;
        socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${relay.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${config.agentToken}\r\n\r\n`);
      } catch (error) { fail(error); }
    });
    // The relay can send the controller's first RDP negotiation packet in the
    // same TCP read as the WebSocket upgrade response. Keep it until the
    // tunnel has installed its handlers instead of silently dropping it.
    const connection = {
      controls: [], binaries: [], binaryBytes: 0, onBinary: null, onControl: null, onClose: null, onDrain: null,
      send: (payload, opcode = 2) => !socket.destroyed && socket.write(clientFrame(payload, opcode)),
      close: () => { if (!socket.destroyed) socket.end(clientFrame(Buffer.alloc(0), 8)); },
    };
    socket.on('data', (chunk) => {
      try {
        if (!opened) {
          header = Buffer.concat([header, chunk]); const boundary = header.indexOf('\r\n\r\n'); if (boundary === -1) return;
          const response = header.subarray(0, boundary).toString('utf8');
          if (!/^HTTP\/1\.1 101\b/m.test(response)) return fail(new Error(`RDP 中继升级失败：${response.split('\r\n')[0]}`));
          opened = true; chunk = header.subarray(boundary + 4); header = Buffer.alloc(0); resolve(connection);
        }
        if (chunk.length) parseFrames(frames, chunk, (opcode, payload) => {
          if (opcode === 2) {
            if (connection.onBinary) connection.onBinary(payload);
            else {
              connection.binaryBytes += payload.length;
              if (connection.binaryBytes > 8 * 1024 * 1024) throw new Error('RDP 初始数据队列超过 8 MiB');
              connection.binaries.push(payload);
            }
          }
          else if (opcode === 1) { const control = JSON.parse(payload.toString('utf8')); if (connection.onControl) connection.onControl(control); else connection.controls.push(control); }
          else if (opcode === 9) connection.send(payload, 10); else if (opcode === 8) socket.end();
        });
      } catch (error) { fail(error); }
    });
    socket.on('drain', () => { if (connection.onDrain) connection.onDrain(); });
    socket.on('close', (hadError) => { writeLog('info', 'rdp.websocket_closed', { sessionId, hadError, opened }); if (connection.onClose) connection.onClose(); if (!opened) reject(new Error('RDP 中继连接已关闭')); });
  });
}
async function openTunnel(session) {
  if (rdpTunnel?.sessionId === session.id) return;
  if (rdpTunnel) rdpTunnel.close();
  setRdpStatus({ state: 'waiting', message: '等待远程桌面连接', sessionId: session.id, host: session.host, port: session.port, username: rdpUsername() });
  const relay = await openWebSocket(session.id);
  writeLog('info', 'rdp.tunnel_opened', { sessionId: session.id, host: session.host, port: session.port });
  let local = null; let closed = false; const pendingRelayData = []; let pendingRelayBytes = 0;
  const queueRelayData = (payload) => {
    pendingRelayBytes += payload.length;
    if (pendingRelayBytes > 8 * 1024 * 1024) {
      writeLog('error', 'rdp.local_queue_overflow', { sessionId: session.id, pendingRelayBytes });
      relay.close();
      return;
    }
    pendingRelayData.push(payload);
  };
  const tunnel = { sessionId: session.id, close: () => { closed = true; if (local) local.destroy(); relay.close(); } };
  rdpTunnel = tunnel;
  const closeLocal = () => { if (local) { const socket = local; local = null; socket.destroy(); } };
  const connectLocal = () => {
    if (closed || local || rdpTunnel !== tunnel) return;
    setRdpStatus({ state: 'connecting', message: '正在连接本机远程桌面服务' });
    const socket = net.createConnection({ host: '127.0.0.1', port: 3389 }); local = socket;
    socket.setNoDelay(true); socket.setKeepAlive(true, 15000);
    socket.on('connect', () => {
      if (local !== socket) return;
      writeLog('info', 'rdp.local_connected', { sessionId: session.id, pendingBytes: pendingRelayBytes });
      setRdpStatus({ state: 'active', message: `远程桌面已就绪：${session.host}:${session.port}` });
      while (pendingRelayData.length && !closed && local === socket && !socket.destroyed) {
        const payload = pendingRelayData.shift();
        pendingRelayBytes -= payload.length;
        socket.write(payload);
      }
    });
    socket.on('data', (chunk) => { if (!closed && !relay.send(chunk)) socket.pause(); });
    socket.on('error', (error) => { if (local !== socket) return; local = null; writeLog('error', 'rdp.local_error', { sessionId: session.id, error: errorValue(error) }); relay.close(); if (rdpTunnel === tunnel) { rdpTunnel = null; setRdpStatus({ state: 'error', message: `本机远程桌面不可用：${error.message}` }); } });
    socket.on('close', () => { if (local === socket) local = null; writeLog('debug', 'rdp.local_closed', { sessionId: session.id }); });
  };
  relay.onBinary = (payload) => {
    if (closed) return;
    if (!local || local.destroyed || local.pending) {
      queueRelayData(payload);
      return;
    }
    local.write(payload);
  };
  relay.onDrain = () => { if (local && !local.destroyed) local.resume(); };
  relay.onControl = (control) => {
    writeLog('debug', 'rdp.control', { sessionId: session.id, type: control?.type || 'unknown' });
    if (control?.type === 'client-connected') connectLocal();
    if (control?.type === 'client-disconnected') { closeLocal(); if (!closed) setRdpStatus({ state: 'waiting', message: '等待远程桌面重新连接' }); }
  };
  relay.onClose = () => {
    closed = true;
    closeLocal();
    if (rdpTunnel === tunnel) {
      rdpTunnel = null;
      // The relay keeps an unexpired session in `connecting` state after an
      // Agent socket reset. The poll loop will receive the same session ID
      // and open a replacement WebSocket automatically.
      setRdpStatus({ state: 'connecting', message: '远程桌面中继已断开，正在自动恢复' });
      writeLog('warn', 'rdp.reconnect_pending', { sessionId: session.id, reason: 'relay_closed' });
    }
  };
  for (const control of relay.controls.splice(0)) relay.onControl(control);
  for (const payload of relay.binaries.splice(0)) relay.onBinary(payload);
  relay.binaryBytes = 0;
}
async function startRdp(ttlSeconds, { automatic = false } = {}) {
  const requested = Number(ttlSeconds) === 0 ? 0 : (Number(ttlSeconds) || 0);
  if (!automatic) rdpAutoStartEnabled = requested === 0;
  setRdpStatus({ state: 'requesting', message: '正在分配远程桌面端口', ttlSeconds: requested });
  const response = await request(endpoint(`/v1/agent/rdp/start?device_id=${encodeURIComponent(config.deviceId)}`), { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ username: rdpUsername(), ttlSeconds: requested }) }, 15000);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `RDP 会话创建失败：HTTP ${response.status}`);
  setRdpStatus({ state: value.state, message: '端口已分配，正在建立隧道', sessionId: value.id, host: value.host, port: Number(value.port) || 0, username: value.username || rdpUsername(), expiresAt: value.expiresAt, ttlSeconds: requested });
  await openTunnel({ id: value.id, host: value.host, port: Number(value.port) || 0 });
  return value;
}
async function ensurePermanentRdp(reason) {
  if (stopped || !rdpAutoStartEnabled || rdpTunnel || rdpEnsurePending) return null;
  rdpEnsurePending = true;
  try {
    const value = await startRdp(0, { automatic: true });
    writeLog('info', 'rdp.permanent_ready', { reason, sessionId: value.id, host: value.host, port: value.port });
    return value;
  } catch (error) {
    setRdpStatus({ state: 'error', message: `永久远程桌面启动失败，正在重试：${error.message}`, ttlSeconds: 0 });
    writeLog('error', 'rdp.permanent_start_failed', { reason, error: errorValue(error) });
    return null;
  } finally {
    rdpEnsurePending = false;
  }
}
async function stopRdp() {
  rdpAutoStartEnabled = false;
  setRdpStatus({ state: 'stopping', message: '正在关闭远程桌面' });
  const response = await request(endpoint(`/v1/agent/rdp/stop?device_id=${encodeURIComponent(config.deviceId)}`), { method: 'POST', headers: authHeaders() }, 15000);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `RDP 会话关闭失败：HTTP ${response.status}`);
  const tunnel = rdpTunnel;
  rdpTunnel = null;
  if (tunnel) tunnel.close();
  setRdpStatus({ state: 'idle', message: '未启动', sessionId: '', host: '', port: 0, username: '', expiresAt: '' });
  writeLog('info', 'rdp.stopped_by_user', { previousSessionId: tunnel?.sessionId || '' });
}
function powershellExecutable() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const systemPowerShell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(systemPowerShell) ? systemPowerShell : 'powershell.exe';
}
function execute(command, cwd, timeoutSeconds, commandId = '') {
  return new Promise((resolve) => {
    const executable = powershellExecutable();
    writeLog('debug', 'command.start', { executable, cwd: cwd || '' });
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command', command], { cwd: cwd || undefined, windowsHide: true });
    const activeCommand = activeCommands.get(commandId);
    if (activeCommand) {
      activeCommand.child = child;
      publishState();
    }
    const chunks = []; let length = 0; let timedOut = false;
    const append = (chunk) => { if (length >= MAX_OUTPUT) return; const kept = Buffer.from(chunk).subarray(0, MAX_OUTPUT - length); chunks.push(kept); length += kept.length; };
    const recordOutput = (stream, chunk) => { const text = Buffer.from(chunk).toString('utf8'); writeLog('info', `command.${stream}`, { commandId, text: text.slice(0, 4096), truncated: text.length > 4096 }); };
    child.stdout.on('data', (chunk) => { append(chunk); recordOutput('stdout', chunk); });
    child.stderr.on('data', (chunk) => { append(Buffer.from('\r\n[stderr]\r\n')); append(chunk); recordOutput('stderr', chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutSeconds * 1000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: -1, timedOut, output: Buffer.from(`无法启动 PowerShell：${error.message}`) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: timedOut ? 124 : (code ?? -1), timedOut, output: Buffer.concat(chunks).subarray(0, MAX_OUTPUT) }); });
  });
}
function terminateProcessTree(pid) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(pid) || pid < 1) return resolve(false);
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(true) : reject(new Error(output.trim() || `taskkill 退出码 ${code}`)));
  });
}
async function cancelActiveCommands(commandId = '', reason = 'local') {
  const selected = commandId ? [activeCommands.get(commandId)].filter(Boolean) : [...activeCommands.values()];
  if (!selected.length) return { cancelled: false, message: '当前没有匹配的运行任务' };
  for (const task of selected) {
    task.cancellationRequested = true;
    writeLog('info', 'command.cancellation_requested', { commandId: task.id, pid: task.child?.pid || null, reason });
  }
  publishState();
  const outcomes = await Promise.allSettled(selected.map(async (task) => {
    if (task.child?.pid) return terminateProcessTree(task.child.pid);
    task.cancelBeforeSpawn = true;
    return false;
  }));
  const failed = outcomes.find((item) => item.status === 'rejected');
  if (failed) throw failed.reason;
  return { cancelled: true, commandIds: selected.map((task) => task.id), count: selected.length };
}
function publicCommandResult(value) {
  return value ? { id: value.id, status: value.status, startedAt: value.startedAt, completedAt: value.completedAt || null, exitCode: value.exitCode ?? null, timedOut: Boolean(value.timedOut), output: value.output == null ? null : String(value.output) } : null;
}
function submitLanCommand(input) {
  const id = String(input.id || '');
  const command = String(input.command || '');
  const cwd = String(input.cwd || '');
  const timeoutSeconds = Math.max(1, Math.min(3600, Number(input.timeoutSeconds) || 300));
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('任务 ID 无效');
  if (!command || Buffer.byteLength(command, 'utf8') > 1024 * 1024) throw new Error('任务命令必须是 1-1048576 字节');
  if (cwd.length > 4096) throw new Error('工作目录无效');
  const existing = activeCommands.get(id) || commandResults.get(id);
  if (existing) return publicCommandResult(existing);
  runCommand(id, command, cwd, timeoutSeconds).catch((error) => writeLog('error', 'command.lan_runner_failed', { commandId: id, error: errorValue(error) }));
  return { id, status: 'running', startedAt: new Date().toISOString(), completedAt: null, exitCode: null, timedOut: false, output: null };
}
function commandStatus(id) { return publicCommandResult(activeCommands.get(id) || commandResults.get(id)); }
async function cancelCommand(id) {
  const completed = commandResults.get(id);
  if (completed) return publicCommandResult(completed);
  const result = await cancelActiveCommands(id, 'lan-controller');
  return { ...result, command: commandStatus(id) };
}
async function reportCommandResult(id, result, cancelled) {
  const response = await request(endpoint(`/v1/agent/result/${encodeURIComponent(id)}?device_id=${encodeURIComponent(config.deviceId)}`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/octet-stream', 'X-Exit-Code': String(cancelled ? 130 : result.exitCode), 'X-Timed-Out': String(result.timedOut), 'X-Cancelled': String(cancelled) }),
    body: result.output,
  });
  if (!response.ok && response.status !== 404 && response.status !== 409) throw new Error(`任务结果回传失败：HTTP ${response.status}`);
  return response.ok;
}
async function runCommand(id, command, cwd, timeoutSeconds) {
  if (activeCommands.has(id)) return;
  if (commandResults.has(id)) {
    const previous = commandResults.get(id);
    await reportCommandResult(id, { exitCode: previous.exitCode, timedOut: previous.timedOut, output: Buffer.from(previous.output || '') }, previous.status === 'cancelled').catch(() => {});
    return;
  }
  const activeCommand = { id, status: 'running', child: null, startedAt: new Date().toISOString(), completedAt: null, exitCode: null, timedOut: false, output: null, timeoutSeconds, cancellationRequested: false, cancelBeforeSpawn: false };
  activeCommands.set(id, activeCommand);
  publishTaskStatus();
  writeLog('info', 'command.execution_started', { commandId: id, cwd: cwd || '', timeoutSeconds });
  try {
    if (activeCommand.cancelBeforeSpawn) throw new Error('任务在启动前被取消');
    const result = isInteractiveCommand(command)
      ? await executeInteractive({ userData, id, command, cwd: cwd || workspace(), timeoutSeconds, cancelled: () => activeCommand.cancellationRequested })
      : await execute(command, cwd || workspace(), timeoutSeconds, id);
    const cancelled = activeCommand.cancellationRequested;
    const completed = { id, status: cancelled ? 'cancelled' : 'completed', startedAt: activeCommand.startedAt, completedAt: new Date().toISOString(), exitCode: cancelled ? 130 : result.exitCode, timedOut: result.timedOut, output: result.output.toString('utf8') };
    commandResults.set(id, completed);
    persistOperationHistory();
    const resultAccepted = await reportCommandResult(id, result, cancelled);
    writeLog('info', 'command.execution_finished', { commandId: id, exitCode: completed.exitCode, timedOut: result.timedOut, cancelled, resultAccepted });
  } catch (error) {
    writeLog('error', 'command.execution_failed', { commandId: id, error: errorValue(error) });
  } finally {
    activeCommands.delete(id);
    publishTaskStatus();
  }
}
async function pollLoop() {
  if (polling) return; polling = true; writeLog('info', 'worker.poll_started');
  while (!stopped) {
    try {
      lanAddresses = privateIpv4Addresses();
      const query = new URLSearchParams({ device_id: config.deviceId, hostname: os.hostname(), workspace_path: workspace(), device_alias: deviceAlias(), lan_addresses: lanAddresses.join(','), lan_port: String(lanServer?.port || 0), lan_fingerprint256: lanServer?.fingerprint256 || '' });
      lastPollStartedAt = new Date().toISOString(); publishState();
      const response = await request(endpoint(`/v1/agent/poll?${query}`), {
        method: 'POST',
        headers: authHeaders(),
      });
      lastPollCompletedAt = new Date().toISOString();
      const sessionId = response.headers.get('x-rdp-session-id');
      if (sessionId) openTunnel({ id: sessionId, host: response.headers.get('x-rdp-host') || new URL(config.server).hostname, port: Number(response.headers.get('x-rdp-port')) || 0 }).catch((error) => { writeLog('error', 'rdp.tunnel_failed', { sessionId, error: errorValue(error) }); setRdpStatus({ state: 'error', message: `远程桌面隧道失败：${error.message}` }); });
      if (response.status === 204) publishTaskStatus();
      else if (response.status === 200) {
        const id = response.headers.get('x-command-id');
        const cwd = Buffer.from(response.headers.get('x-cwd-base64') || '', 'base64').toString('utf8');
        const timeout = Math.max(1, Math.min(3600, Number(response.headers.get('x-timeout-seconds')) || 300));
        const command = await response.text();
        runCommand(id, command, cwd, timeout).catch((error) => writeLog('error', 'command.background_runner_failed', { commandId: id, error: errorValue(error) }));
      } else { setStatus({ state: 'error', message: `中继返回 HTTP ${response.status}` }); await sleep(5000); }
    } catch (error) { writeLog('error', 'poll.failed', { error: errorValue(error) }); setStatus({ state: 'offline', message: `连接失败：${error.message}` }); await sleep(5000); }
    await sleep(2000);
  }
  polling = false; writeLog('info', 'worker.poll_stopped');
}
async function processTransfer(transfer) {
  const id = String(transfer.id || '');
  const remotePath = absoluteWindowsPath(transfer.remotePath);
  writeLog('info', 'transfer.started', { transferId: id, direction: transfer.direction, path: remotePath, size: transfer.size });
  try {
    const alreadyCompleted = lanServer?.completedTransfer(id);
    if (alreadyCompleted && transfer.direction === 'upload') {
      await request(endpoint(`/v1/agent/transfers/${id}/complete?device_id=${encodeURIComponent(config.deviceId)}`), { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({}) }, 15000);
      writeLog('info', 'transfer.deduplicated_after_lan', { transferId: id, path: alreadyCompleted.path, size: alreadyCompleted.size });
      return;
    }
    if (transfer.direction === 'upload') {
      fs.mkdirSync(path.dirname(remotePath), { recursive: true });
      const temporary = `${remotePath}.remote-codex-${id}.part`;
      const output = fs.createWriteStream(temporary, { flags: 'w', mode: 0o600 });
      try {
        await relayStreamRequest(`/v1/agent/transfers/${id}/content?device_id=${encodeURIComponent(config.deviceId)}`, { output });
        const stat = fs.statSync(temporary);
        const actual = await hashFileSha256(temporary);
        if (stat.size !== Number(transfer.size) || actual !== String(transfer.sha256 || '').toUpperCase()) throw new Error('中转文件大小或 SHA-256 校验失败');
        replaceFileAtomically(temporary, remotePath);
      } catch (error) { output.destroy(); try { fs.unlinkSync(temporary); } catch {} throw error; }
    } else if (transfer.direction === 'download') {
      const stat = fs.statSync(remotePath);
      if (!stat.isFile()) throw new Error('远程路径不是文件');
      await relayStreamRequest(`/v1/agent/transfers/${id}/content?device_id=${encodeURIComponent(config.deviceId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size) }, input: fs.createReadStream(remotePath) });
    } else throw new Error('未知文件传输方向');
    if (transfer.direction === 'upload') {
      await request(endpoint(`/v1/agent/transfers/${id}/complete?device_id=${encodeURIComponent(config.deviceId)}`), { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({}) }, 15000);
    }
    writeLog('info', 'transfer.finished', { transferId: id, direction: transfer.direction, path: remotePath });
  } catch (error) {
    writeLog('error', 'transfer.failed', { transferId: id, direction: transfer.direction, path: remotePath, error: errorValue(error) });
    await request(endpoint(`/v1/agent/transfers/${id}/complete?device_id=${encodeURIComponent(config.deviceId)}`), { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ error: error.message }) }, 15000).catch(() => {});
  }
}
async function transferLoop() {
  while (!stopped) {
    try {
      const response = await request(endpoint(`/v1/agent/transfers/poll?device_id=${encodeURIComponent(config.deviceId)}`), { method: 'GET', headers: authHeaders() }, 15000);
      if (response.status === 200) processTransfer(await response.json()).catch((error) => writeLog('error', 'transfer.runner_failed', { error: errorValue(error) }));
      else if (response.status !== 204) writeLog('error', 'transfer.poll_failed', { status: response.status });
    } catch (error) { writeLog('error', 'transfer.poll_failed', { error: errorValue(error) }); }
    await sleep(2000);
  }
}
async function reloadRelayConfig() {
  const next = loadRelayConfig();
  if (!next) throw new Error('未找到有效的中继配置');
  const previousServer = config.server;
  setStatus({ state: 'connecting', message: '正在切换中继服务器' });
  if (rdpTunnel) { rdpTunnel.close(); rdpTunnel = null; }
  setRdpStatus({ state: 'idle', message: '未启动', sessionId: '', host: '', port: 0, username: '', expiresAt: '' });
  verifiedCertificateHosts.clear();
  config = { ...config, ...next };
  try {
    await register();
    publishTaskStatus();
    await ensurePermanentRdp('relay-config-reload');
    writeLog('info', 'relay_config.reloaded', { previousServer, server: config.server });
    return { server: config.server };
  } catch (error) {
    setStatus({ state: 'offline', message: '中继切换失败：' + error.message });
    writeLog('error', 'relay_config.reload_failed', { server: config.server, error: errorValue(error) });
    throw error;
  }
}
async function processCommands() {
  fs.mkdirSync(commandDirectory, { recursive: true });
  for (const filename of fs.readdirSync(commandDirectory).filter((item) => item.startsWith('request-') && item.endsWith('.json'))) {
    const requestPath = path.join(commandDirectory, filename); let command;
    try { command = JSON.parse(fs.readFileSync(requestPath, 'utf8')); fs.renameSync(requestPath, `${requestPath}.processing`); } catch { continue; }
    let result;
    try {
      if (command.type === 'start-rdp') result = { ok: true, value: await startRdp(command.ttlSeconds) };
      else if (command.type === 'stop-rdp') result = { ok: true, value: await stopRdp() };
      else if (command.type === 'cancel-active-task') result = { ok: true, value: await cancelActiveCommands(command.commandId, command.reason) };
      else if (command.type === 'reload-config') result = { ok: true, value: await reloadRelayConfig() };
      else if (command.type === 'stop') { stopped = true; if (rdpTunnel) rdpTunnel.close(); result = { ok: true }; }
      else result = { ok: false, error: '未知后台命令' };
    } catch (error) { writeLog('error', 'worker.command_failed', { type: command.type, error: errorValue(error) }); result = { ok: false, error: error.message }; }
    writeJsonAtomically(path.join(commandDirectory, `response-${command.id}.json`), result);
  }
}

process.on('uncaughtException', (error) => { writeLog('error', 'worker.uncaught_exception', { error: errorValue(error) }); });
process.on('unhandledRejection', (error) => writeLog('error', 'worker.unhandled_rejection', { error: errorValue(error) }));
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
(async () => {
  writeLog('info', 'worker.start', { appVersion, node: process.versions.node, deviceId: config.deviceId, server: config.server });
  lanServer = startLanServer({ userData, deviceId: config.deviceId, writeLog, submitCommand: submitLanCommand, commandStatus, cancelCommand, completedTransfers, transferCompleted: (value) => { value.completedAt = new Date().toISOString(); persistOperationHistory(); } });
  await lanServer.ready;
  publishState();
  try { await register(); } catch (error) { writeLog('error', 'device.registration_failed', { error: errorValue(error) }); setStatus({ state: 'offline', message: `注册失败：${error.message}` }); await sleep(10000); }
  if (!stopped) await ensurePermanentRdp('worker-start');
  setInterval(() => { ensurePermanentRdp('maintenance').catch(() => {}); }, 15000).unref();
  if (!stopped) pollLoop();
  if (!stopped) transferLoop();
  const commandTimer = setInterval(() => processCommands().catch((error) => writeLog('error', 'worker.command_loop_failed', { error: errorValue(error) })), 500);
  const heartbeatTimer = setInterval(publishState, 5000);
  while (!stopped) await sleep(500);
  clearInterval(commandTimer); clearInterval(heartbeatTimer); if (lanServer) lanServer.close(); publishState();
  process.exit(0);
})();
