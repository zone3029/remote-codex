import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const bindHost = process.env.REMOTE_CODEX_BIND_HOST || "127.0.0.1";
const bindPort = Number(process.env.REMOTE_CODEX_BIND_PORT || 18765);
const controllerToken = process.env.REMOTE_CODEX_CONTROLLER_TOKEN || "";
const enrollmentToken = process.env.REMOTE_CODEX_ENROLLMENT_TOKEN || "";
const staticAgentTokens = JSON.parse(process.env.REMOTE_CODEX_AGENT_TOKENS_JSON || "{}");
const registryPath = process.env.REMOTE_CODEX_DEVICE_REGISTRY_PATH || "/var/lib/remote-codex/devices.json";
const updateDir = process.env.REMOTE_CODEX_UPDATE_DIR || "/opt/remote-codex/updates/windows";
const transferDir = process.env.REMOTE_CODEX_TRANSFER_DIR || "/var/lib/remote-codex/transfers";
const publicHost = process.env.REMOTE_CODEX_PUBLIC_HOST || "127.0.0.1";
const rdpPortMin = Number(process.env.REMOTE_CODEX_RDP_PORT_MIN || 31000);
const rdpPortMax = Number(process.env.REMOTE_CODEX_RDP_PORT_MAX || 31999);
const rdpTtlSeconds = normalizeRdpTtl(process.env.REMOTE_CODEX_RDP_TTL_SECONDS, 12 * 60 * 60);
const maxBodyBytes = 2 * 1024 * 1024;
const maxCommandBytes = 1024 * 1024;
const devices = new Map();
const commands = new Map();
const cancellationRequests = new Map();
const rdpSessions = new Map();
const transfers = new Map();
const maxTransferBytes = 5 * 1024 * 1024 * 1024;

function normalizeRdpTtl(value, fallback = rdpTtlSeconds) {
  const seconds = Number(value);
  if (seconds === 0) return 0;
  return Math.max(60, Math.min(7 * 24 * 60 * 60, Number.isFinite(seconds) && seconds > 0 ? seconds : fallback));
}

if (controllerToken.length < 32) {
  throw new Error("REMOTE_CODEX_CONTROLLER_TOKEN must contain at least 32 characters");
}
if (enrollmentToken.length < 32) {
  throw new Error("REMOTE_CODEX_ENROLLMENT_TOKEN must contain at least 32 characters");
}
if (Object.values(staticAgentTokens).some((token) => String(token).length < 32)) {
  throw new Error("REMOTE_CODEX_AGENT_TOKENS_JSON must map device IDs to tokens of at least 32 characters");
}

function loadRegisteredDevices() {
  try {
    const value = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`cannot load device registry: ${error.message}`);
  }
}

const registeredDevices = loadRegisteredDevices();
const agentTokens = {
  ...staticAgentTokens,
  ...Object.fromEntries(Object.entries(registeredDevices).map(([id, device]) => [id, device.agentToken])),
};

function saveRegisteredDevices() {
  const directory = path.dirname(registryPath);
  const temporaryPath = `${registryPath}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(registeredDevices, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, registryPath);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function secureEqual(actual, expected) {
  const left = Buffer.from(actual || "");
  const right = Buffer.from(expected || "");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeDeviceAlias(value) {
  const alias = String(value || "").trim().replace(/\s+/g, " ");
  return alias.length <= 64 && !/[\u0000-\u001f\u007f]/.test(alias) ? alias : "";
}

function isPrivateIpv4(address) {
  if (net.isIP(address) !== 4) return false;
  const parts = address.split('.').map(Number);
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function normalizeLanAddresses(value) {
  const candidates = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(candidates.map((item) => String(item).trim()).filter(isPrivateIpv4))].slice(0, 8);
}

function normalizeLanPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
}

function normalizeSha256(value) {
  const result = String(value || '').replaceAll(':', '').toUpperCase();
  return /^[A-F0-9]{64}$/.test(result) ? result : '';
}

function bearer(request) {
  const value = request.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function authorizeController(request, response) {
  if (!secureEqual(bearer(request), controllerToken)) {
    sendJson(response, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function authorizeEnrollment(request, response) {
  if (!secureEqual(bearer(request), enrollmentToken)) {
    sendJson(response, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function isAgentAuthorized(request, deviceId) {
  const expected = agentTokens[deviceId];
  return Boolean(expected && secureEqual(bearer(request), expected));
}

function authorizeAgent(request, response, deviceId) {
  const expected = agentTokens[deviceId];
  if (!expected || !secureEqual(bearer(request), expected)) {
    sendJson(response, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function authorizeAnyAgent(request, response) {
  const actual = bearer(request);
  if (!Object.values(agentTokens).some((expected) => secureEqual(actual, expected))) {
    sendJson(response, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function publicRdpSession(session) {
  return {
    id: session.id,
    deviceId: session.deviceId,
    host: publicHost,
    port: session.port,
    username: session.username || "",
    state: session.state,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    error: session.error || null,
  };
}

function rdpPortCandidates(deviceId) {
  const count = rdpPortMax - rdpPortMin + 1;
  if (!Number.isInteger(count) || count < 1) throw new Error("RDP 端口范围配置无效");
  const preferred = Number(registeredDevices[deviceId]?.rdpPort);
  const hash = crypto.createHash("sha256").update(deviceId).digest().readUInt32BE(0) % count;
  const candidates = new Set();
  if (preferred >= rdpPortMin && preferred <= rdpPortMax) candidates.add(preferred);
  for (let offset = 0; offset < count; offset += 1) candidates.add(rdpPortMin + ((hash + offset) % count));
  return [...candidates];
}

function isRdpPortReserved(port, deviceId) {
  return Object.entries(registeredDevices).some(([id, device]) => id !== deviceId && Number(device.rdpPort) === port);
}

function listenRdpPort(listener, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { listener.off("listening", onListening); reject(error); };
    const onListening = () => { listener.off("error", onError); resolve(); };
    listener.once("error", onError);
    listener.once("listening", onListening);
    listener.listen({ host: "0.0.0.0", port });
  });
}

async function allocateRdpPort(session, listener) {
  let lastError;
  for (const port of rdpPortCandidates(session.deviceId)) {
    if (isRdpPortReserved(port, session.deviceId)) continue;
    try {
      await listenRdpPort(listener, port);
      session.port = listener.address().port;
      const device = registeredDevices[session.deviceId];
      if (device && device.rdpPort !== session.port) {
        device.rdpPort = session.port;
        device.updatedAt = new Date().toISOString();
        saveRegisteredDevices();
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError ? lastError.message : "没有可用端口");
}

function logRdp(event, session, extra = {}) {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    event,
    sessionId: session.id,
    deviceId: session.deviceId,
    port: session.port,
    state: session.state,
    ...extra,
  }));
}

function recordRdpBytes(session, direction, length) {
  const stats = session.bytes || (session.bytes = { clientToAgent: 0, agentToClient: 0, loggedClientToAgent: false, loggedAgentToClient: false });
  if (direction === "clientToAgent") {
    stats.clientToAgent += length;
    if (!stats.loggedClientToAgent) {
      stats.loggedClientToAgent = true;
      logRdp("rdp.first_client_bytes", session, { bytes: length });
    }
  } else {
    stats.agentToClient += length;
    if (!stats.loggedAgentToClient) {
      stats.loggedAgentToClient = true;
      logRdp("rdp.first_agent_bytes", session, { bytes: length });
    }
  }
}

function queueRdpData(session, payload) {
  session.pendingClientDataBytes += payload.length;
  if (session.pendingClientDataBytes > 8 * 1024 * 1024) {
    closeRdpSession(session, "error", "RDP 初始数据队列超过 8 MiB");
    return false;
  }
  session.pendingClientData.push(payload);
  return true;
}

function discardPendingClientData(session, reason) {
  const discardedBytes = session.pendingClientDataBytes;
  const discardedFrames = session.pendingClientData.length;
  if (!discardedBytes && !discardedFrames) return;
  session.pendingClientData.length = 0;
  session.pendingClientDataBytes = 0;
  logRdp("rdp.pending_client_data_discarded", session, { reason, discardedBytes, discardedFrames });
}

function forwardClientToAgent(session, payload) {
  recordRdpBytes(session, "clientToAgent", payload.length);
  if (!session.agentSocket || session.agentSocket.destroyed) return queueRdpData(session, payload);
  return session.agentSocket.write(frameWebSocket(payload));
}

function forwardAgentToClient(session, payload) {
  recordRdpBytes(session, "agentToClient", payload.length);
  return Boolean(session.clientSocket && !session.clientSocket.destroyed && session.clientSocket.write(payload));
}

function recordRdpConnection(session) {
  const device = registeredDevices[session.deviceId];
  if (!device) return;
  device.lastRdpConnectedAt = new Date().toISOString();
  device.updatedAt = device.lastRdpConnectedAt;
  saveRegisteredDevices();
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function closeRdpSession(session, state = "closed", error = "") {
  if (!session || session.state === "closed" || session.state === "expired") return;
  session.state = state;
  session.error = error;
  session.expiresAt = new Date().toISOString();
  logRdp("rdp.closed", session, { reason: error || state, bytes: session.bytes || { clientToAgent: 0, agentToClient: 0 } });
  if (session.clientSocket) session.clientSocket.destroy();
  if (session.agentSocket) session.agentSocket.destroy();
  if (session.listener) session.listener.close();
}

function frameWebSocket(payload, opcode = 2) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function sendRdpControl(session, type) {
  if (session.agentSocket && !session.agentSocket.destroyed) {
    session.agentSocket.write(frameWebSocket(JSON.stringify({ type }), 1));
  }
}

function parseWebSocketFrames(state, chunk, onFrame) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const masked = Boolean(second & 0x80);
    let offset = 2;
    let length = second & 0x7f;
    if (length === 126) {
      if (state.buffer.length < 4) return;
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) return;
      const largeLength = state.buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(8 * 1024 * 1024)) throw new Error("RDP frame is too large");
      length = Number(largeLength);
      offset = 10;
    }
    const maskOffset = masked ? 4 : 0;
    const total = offset + maskOffset + length;
    if (state.buffer.length < total) return;
    const mask = masked ? state.buffer.subarray(offset, offset + 4) : null;
    const payloadStart = offset + maskOffset;
    const payload = Buffer.from(state.buffer.subarray(payloadStart, payloadStart + length));
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    state.buffer = state.buffer.subarray(total);
    onFrame(first & 0x0f, payload);
  }
}

function attachRdpAgentSocket(session, socket) {
  if (session.agentSocket) session.agentSocket.destroy();
  session.agentSocket = socket;
  session.state = session.clientSocket ? "active" : "waiting";
  logRdp("rdp.agent_connected", session);
  if (session.clientSocket) {
    sendRdpControl(session, "client-connected");
    for (const payload of session.pendingClientData.splice(0)) forwardClientToAgent(session, payload);
    session.pendingClientDataBytes = 0;
  }
  const wsState = { buffer: Buffer.alloc(0) };
  socket.on("data", (chunk) => {
    try {
      parseWebSocketFrames(wsState, chunk, (opcode, payload) => {
        if (opcode === 2) forwardAgentToClient(session, payload);
        else if (opcode === 9) socket.write(frameWebSocket(payload, 10));
        else if (opcode === 8) socket.end();
      });
    } catch (error) {
      closeRdpSession(session, "error", error.message);
    }
  });
  socket.on("close", () => {
    const isCurrentSocket = session.agentSocket === socket;
    if (isCurrentSocket) session.agentSocket = null;
    logRdp("rdp.agent_disconnected", session);
    if (!isCurrentSocket) return;
    // Keep the listener and session alive while the TTL has not expired. The
    // next Agent poll will receive this same session ID and reconnect the
    // WebSocket, so a transient relay/network reset does not strand the RDP
    // port or force the controller to create a new session.
    if (session.clientSocket && !session.clientSocket.destroyed) {
      session.clientSocket.destroy();
      session.clientSocket = null;
    }
    discardPendingClientData(session, "agent_disconnected");
    if (["active", "waiting", "connecting"].includes(session.state)) {
      session.state = "connecting";
      session.assignedAt = new Date().toISOString();
      logRdp("rdp.reconnect_pending", session, { reason: "agent_socket_closed" });
    }
  });
  socket.on("error", (error) => closeRdpSession(session, "error", error.message));
}

async function createRdpSession(deviceId, username = "", requestedTtlSeconds = rdpTtlSeconds) {
  const ttlSeconds = normalizeRdpTtl(requestedTtlSeconds);
  const existing = [...rdpSessions.values()].find((session) => session.deviceId === deviceId && ["queued", "connecting", "waiting", "active"].includes(session.state));
  if (existing) {
    existing.username = String(username || existing.username).slice(0, 255);
    existing.ttlSeconds = ttlSeconds;
    existing.expiresAt = ttlSeconds === 0 ? null : new Date(Date.now() + ttlSeconds * 1000).toISOString();
    return existing;
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const session = {
    id,
    deviceId,
    username: String(username || "").slice(0, 255),
    state: "queued",
    error: "",
    port: 0,
    listener: null,
    clientSocket: null,
    agentSocket: null,
    pendingClientData: [],
    pendingClientDataBytes: 0,
    bytes: { clientToAgent: 0, agentToClient: 0, loggedClientToAgent: false, loggedAgentToClient: false },
    createdAt: new Date(now).toISOString(),
    ttlSeconds,
    expiresAt: ttlSeconds === 0 ? null : new Date(now + ttlSeconds * 1000).toISOString(),
  };
  const listener = net.createServer((clientSocket) => {
    // A device has one interactive RDP channel. A previously connected native
    // client must not block a later web client indefinitely. Tell the Agent to
    // close its old localhost:3389 socket before admitting the replacement;
    // otherwise the incoming RDP negotiation bytes would be mixed into the old
    // encrypted RDP stream.
    const incomingIsWebClient = isLoopbackAddress(clientSocket.remoteAddress);
    const currentIsWebClient = isLoopbackAddress(session.clientSocket?.remoteAddress);
    if (session.clientSocket && !session.clientSocket.destroyed && currentIsWebClient && !incomingIsWebClient) {
      logRdp("rdp.client_rejected", session, {
        reason: "web_client_has_priority",
        remoteAddress: clientSocket.remoteAddress || "",
        remotePort: clientSocket.remotePort || 0,
      });
      clientSocket.destroy();
      return;
    }
    if (session.clientSocket && !session.clientSocket.destroyed) {
      logRdp("rdp.client_replaced", session, {
        previousRemoteAddress: session.clientSocket.remoteAddress || "",
        previousRemotePort: session.clientSocket.remotePort || 0,
        nextRemoteAddress: clientSocket.remoteAddress || "",
        nextRemotePort: clientSocket.remotePort || 0,
      });
      discardPendingClientData(session, "client_replaced");
      sendRdpControl(session, "client-disconnected");
      session.clientSocket.destroy();
    }
    session.clientSocket = clientSocket;
    clientSocket.setNoDelay(true);
    recordRdpConnection(session);
    logRdp("rdp.client_connected", session, {
      remoteAddress: clientSocket.remoteAddress || "",
      remotePort: clientSocket.remotePort || 0,
    });
    clientSocket.on("data", (chunk) => { forwardClientToAgent(session, chunk); });
    clientSocket.on("close", () => {
      if (session.clientSocket === clientSocket) {
        session.clientSocket = null;
        session.state = session.agentSocket ? "waiting" : "connecting";
        sendRdpControl(session, "client-disconnected");
        logRdp("rdp.client_disconnected", session, { bytes: session.bytes || { clientToAgent: 0, agentToClient: 0 } });
      }
    });
    clientSocket.on("error", () => {});
    if (session.agentSocket) {
      session.state = "active";
      sendRdpControl(session, "client-connected");
    }
  });
  session.listener = listener;
  rdpSessions.set(id, session);
  try {
    await allocateRdpPort(session, listener);
    logRdp("rdp.created", session, { expiresAt: session.expiresAt });
    return session;
  } catch (error) {
    rdpSessions.delete(id);
    listener.close();
    throw new Error(`无法分配 RDP 端口：${error.message}`);
  }
}

async function readBody(request, limit = maxBodyBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, limit = 128 * 1024) {
  const body = await readBody(request, limit);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("invalid JSON");
  }
}

function publicCommand(command) {
  return {
    id: command.id,
    deviceId: command.deviceId,
    status: command.status,
    cwd: command.cwd,
    timeoutSeconds: command.timeoutSeconds,
    createdAt: command.createdAt,
    startedAt: command.startedAt,
    completedAt: command.completedAt,
    exitCode: command.exitCode,
    timedOut: command.timedOut,
    output: command.output,
  };
}

function publicTransfer(transfer) {
  return {
    id: transfer.id,
    deviceId: transfer.deviceId,
    direction: transfer.direction,
    remotePath: transfer.remotePath,
    size: transfer.size ?? null,
    sha256: transfer.sha256 || null,
    status: transfer.status,
    createdAt: transfer.createdAt,
    completedAt: transfer.completedAt || null,
    error: transfer.error || null,
  };
}

function transferPath(id) { return path.join(transferDir, `${id}.data`); }

async function receiveFile(request, filename, maximumBytes) {
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maximumBytes) throw new Error('request body too large');
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
    fs.renameSync(temporary, filename);
    return { size, sha256: hash.digest('hex').toUpperCase() };
  } catch (error) {
    output.destroy();
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function sendFile(response, filename, stat) {
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
  fs.createReadStream(filename).pipe(response);
}

async function route(request, response) {
  const url = new URL(request.url, "http://relay.local");
  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, { ok: true });
  }

  const updateMatch = url.pathname.match(/^\/updates\/windows\/([^/]+)$/);
  if (request.method === "GET" && updateMatch) {
    if (!authorizeAnyAgent(request, response)) return;
    const filename = decodeURIComponent(updateMatch[1]);
    if (path.basename(filename) !== filename || !/\.(?:yml|exe|blockmap)$/i.test(filename)) {
      return sendJson(response, 400, { error: "invalid update filename" });
    }
    const file = path.join(updateDir, filename);
    let stat;
    try { stat = fs.statSync(file); } catch { return sendJson(response, 404, { error: "update file not found" }); }
    response.writeHead(200, {
      "Content-Type": filename.endsWith(".yml") ? "text/yaml; charset=utf-8" : "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      "X-Accel-Redirect": `/_remote-codex-update-files/${encodeURIComponent(filename)}`,
    });
    return response.end();
  }

  if (request.method === "POST" && url.pathname === "/v1/agent/register") {
    if (!authorizeEnrollment(request, response)) return;
    const input = await readJson(request);
    const deviceId = String(input.deviceId || "").trim().toLowerCase();
    const agentToken = String(input.agentToken || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(deviceId)) {
      return sendJson(response, 400, { error: "invalid device ID" });
    }
    if (!/^[a-f0-9]{64}$/i.test(agentToken)) {
      return sendJson(response, 400, { error: "invalid agent token" });
    }
    const existing = registeredDevices[deviceId];
    if (existing && !secureEqual(existing.agentToken, agentToken)) {
      return sendJson(response, 409, { error: "device ID is already registered" });
    }
    const now = new Date().toISOString();
    registeredDevices[deviceId] = {
      deviceId,
      agentToken,
      hostname: String(input.hostname || "").slice(0, 255),
      username: String(input.username || "").slice(0, 255),
      platform: String(input.platform || "").slice(0, 32),
      arch: String(input.arch || "").slice(0, 32),
      appVersion: String(input.appVersion || "").slice(0, 32),
      alias: input.alias == null ? String(existing?.alias || "") : normalizeDeviceAlias(input.alias),
      lanAddresses: input.lanAddresses == null ? normalizeLanAddresses(existing?.lanAddresses) : normalizeLanAddresses(input.lanAddresses),
      lanPort: normalizeLanPort(input.lanPort || existing?.lanPort),
      lanFingerprint256: normalizeSha256(input.lanFingerprint256 || existing?.lanFingerprint256),
      lanSecret: normalizeSha256(input.lanSecret || existing?.lanSecret),
      registeredAt: existing?.registeredAt || now,
      updatedAt: now,
    };
    agentTokens[deviceId] = agentToken;
    saveRegisteredDevices();
    console.log(JSON.stringify({ time: now, event: "device.registered", deviceId, hostname: registeredDevices[deviceId].hostname }));
    return sendJson(response, existing ? 200 : 201, { deviceId, registeredAt: registeredDevices[deviceId].registeredAt });
  }

  if (request.method === "POST" && url.pathname === "/v1/agent/rdp/start") {
    const deviceId = url.searchParams.get("device_id") || "";
    if (!authorizeAgent(request, response, deviceId)) return;
    const input = await readJson(request, 16 * 1024);
    const session = await createRdpSession(deviceId, input.username || registeredDevices[deviceId]?.username, input.ttlSeconds);
    return sendJson(response, session.state === "queued" ? 201 : 200, publicRdpSession(session));
  }

  if (request.method === "POST" && url.pathname === "/v1/agent/rdp/stop") {
    const deviceId = url.searchParams.get("device_id") || "";
    if (!authorizeAgent(request, response, deviceId)) return;
    const session = [...rdpSessions.values()].find((item) => item.deviceId === deviceId && ["queued", "connecting", "waiting", "active"].includes(item.state));
    if (!session) return sendJson(response, 200, { state: "idle" });
    closeRdpSession(session, "closed", "设备端已关闭远程桌面");
    rdpSessions.delete(session.id);
    return sendJson(response, 200, publicRdpSession(session));
  }

  if (request.method === "POST" && url.pathname === "/v1/rdp/sessions") {
    if (!authorizeController(request, response)) return;
    const input = await readJson(request, 16 * 1024);
    const deviceId = String(input.deviceId || "");
    if (!agentTokens[deviceId]) return sendJson(response, 404, { error: "unknown device" });
    const session = await createRdpSession(deviceId, input.username, input.ttlSeconds);
    return sendJson(response, session.state === "queued" ? 201 : 200, publicRdpSession(session));
  }

  const rdpSessionMatch = url.pathname.match(/^\/v1\/rdp\/sessions\/([a-f0-9-]+)$/);
  if (request.method === "GET" && rdpSessionMatch) {
    if (!authorizeController(request, response)) return;
    const session = rdpSessions.get(rdpSessionMatch[1]);
    return session ? sendJson(response, 200, publicRdpSession(session)) : sendJson(response, 404, { error: "RDP session not found" });
  }

  if (request.method === "DELETE" && rdpSessionMatch) {
    if (!authorizeController(request, response)) return;
    const session = rdpSessions.get(rdpSessionMatch[1]);
    if (!session) return sendJson(response, 404, { error: "RDP session not found" });
    closeRdpSession(session, "closed", "控制端已关闭会话");
    rdpSessions.delete(session.id);
    return sendJson(response, 200, publicRdpSession(session));
  }

  if (request.method === "POST" && url.pathname === "/v1/agent/poll") {
    const deviceId = url.searchParams.get("device_id") || "";
    if (!authorizeAgent(request, response, deviceId)) return;
    const hasAlias = url.searchParams.has("device_alias");
    const alias = hasAlias ? normalizeDeviceAlias(url.searchParams.get("device_alias")) : "";
    const hasLanAddresses = url.searchParams.has("lan_addresses");
    const lanAddresses = hasLanAddresses ? normalizeLanAddresses(url.searchParams.get("lan_addresses")) : normalizeLanAddresses(registeredDevices[deviceId]?.lanAddresses);
    const lanPort = normalizeLanPort(url.searchParams.get("lan_port") || registeredDevices[deviceId]?.lanPort);
    const lanFingerprint256 = normalizeSha256(url.searchParams.get("lan_fingerprint256") || registeredDevices[deviceId]?.lanFingerprint256);
    const registrationChanged = registeredDevices[deviceId] && (
      (hasAlias && registeredDevices[deviceId].alias !== alias)
      || (hasLanAddresses && JSON.stringify(normalizeLanAddresses(registeredDevices[deviceId].lanAddresses)) !== JSON.stringify(lanAddresses))
      || registeredDevices[deviceId].lanPort !== lanPort
      || registeredDevices[deviceId].lanFingerprint256 !== lanFingerprint256
    );
    if (registrationChanged) {
      if (hasAlias) registeredDevices[deviceId].alias = alias;
      if (hasLanAddresses) registeredDevices[deviceId].lanAddresses = lanAddresses;
      registeredDevices[deviceId].lanPort = lanPort;
      registeredDevices[deviceId].lanFingerprint256 = lanFingerprint256;
      registeredDevices[deviceId].updatedAt = new Date().toISOString();
      saveRegisteredDevices();
      console.log(JSON.stringify({ time: registeredDevices[deviceId].updatedAt, event: "device.network_changed", deviceId, alias: registeredDevices[deviceId].alias || "", lanAddresses }));
    }
    devices.set(deviceId, {
      id: deviceId,
      hostname: url.searchParams.get("hostname") || "",
      alias: hasAlias ? alias : (registeredDevices[deviceId]?.alias || ""),
      workspacePath: url.searchParams.get("workspace_path") || "",
      lanAddresses,
      lanPort,
      lanFingerprint256,
      online: true,
      lastSeenAt: new Date().toISOString(),
    });
    // Polling is independent of task completion. Each dispatched command has
    // its own ID, so the Agent may execute multiple independent tasks.
    const command = [...commands.values()].find(
      (item) => item.deviceId === deviceId && item.status === "queued" && Date.parse(item.dispatchAfter || item.createdAt) <= Date.now(),
    );
    const rdpSession = [...rdpSessions.values()].find((item) => item.deviceId === deviceId && (
      item.state === "queued" || (item.state === "connecting" && !item.agentSocket && Date.now() - Date.parse(item.assignedAt || item.createdAt) > 10_000)
    ));
    if (rdpSession) {
      rdpSession.state = "connecting";
      rdpSession.assignedAt = new Date().toISOString();
    }
    if (!command) {
      response.writeHead(204, {
        "Cache-Control": "no-store",
        ...(rdpSession ? {
          "X-Rdp-Session-Id": rdpSession.id,
          "X-Rdp-Host": rdpSession.host || publicHost,
          "X-Rdp-Port": String(rdpSession.port),
        } : {}),
      });
      return response.end();
    }
    command.status = "running";
    command.startedAt = new Date().toISOString();
    const body = Buffer.from(command.command, "utf8");
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Command-Id": command.id,
      "X-Cwd-Base64": Buffer.from(command.cwd || "", "utf8").toString("base64"),
      "X-Timeout-Seconds": String(command.timeoutSeconds),
      ...(rdpSession ? {
        "X-Rdp-Session-Id": rdpSession.id,
        "X-Rdp-Host": rdpSession.host || publicHost,
        "X-Rdp-Port": String(rdpSession.port),
      } : {}),
    });
    return response.end(body);
  }

  if (request.method === "GET" && url.pathname === "/v1/agent/cancel") {
    const deviceId = url.searchParams.get("device_id") || "";
    if (!authorizeAgent(request, response, deviceId)) return;
    const cancellations = cancellationRequests.get(deviceId) || [];
    if (!cancellations.length) {
      response.writeHead(204, { "Cache-Control": "no-store" });
      return response.end();
    }
    return sendJson(response, 200, cancellations[0]);
  }

  if (request.method === "POST" && url.pathname === "/v1/agent/cancel/ack") {
    const deviceId = url.searchParams.get("device_id") || "";
    if (!authorizeAgent(request, response, deviceId)) return;
    const input = await readJson(request, 16 * 1024);
    const cancellations = cancellationRequests.get(deviceId) || [];
    const index = cancellations.findIndex((item) => item.id === input.id);
    const acknowledged = index !== -1;
    if (acknowledged) cancellations.splice(index, 1);
    if (cancellations.length) cancellationRequests.set(deviceId, cancellations);
    else cancellationRequests.delete(deviceId);
    return sendJson(response, 200, { acknowledged });
  }

  const resultMatch = url.pathname.match(/^\/v1\/agent\/result\/([a-f0-9-]+)$/);
  if (request.method === "POST" && resultMatch) {
    const deviceId = url.searchParams.get("device_id") || "";
    if (!authorizeAgent(request, response, deviceId)) return;
    const command = commands.get(resultMatch[1]);
    if (!command || command.deviceId !== deviceId || !["queued", "running"].includes(command.status)) {
      return sendJson(response, 409, { error: "command is not running" });
    }
    const output = await readBody(request);
    const cancelled = request.headers["x-cancelled"] === "true";
    command.status = cancelled ? "cancelled" : "completed";
    command.completedAt = new Date().toISOString();
    command.exitCode = Number(request.headers["x-exit-code"] || -1);
    command.timedOut = request.headers["x-timed-out"] === "true";
    command.output = output.toString("utf8");
    response.writeHead(204, { "Cache-Control": "no-store" });
    return response.end();
  }

  if (request.method === "GET" && url.pathname === "/v1/devices") {
    if (!authorizeController(request, response)) return;
    const now = Date.now();
    const deviceIds = new Set([...Object.keys(registeredDevices), ...devices.keys()]);
    const list = [...deviceIds].map((deviceId) => {
      const registration = registeredDevices[deviceId];
      const heartbeat = devices.get(deviceId);
      return {
        id: deviceId,
        alias: heartbeat?.alias || registration?.alias || "",
        hostname: heartbeat?.hostname || registration?.hostname || "",
        username: registration?.username || "",
        platform: registration?.platform || "",
        arch: registration?.arch || "",
        appVersion: registration?.appVersion || "",
        lanAddresses: heartbeat?.lanAddresses || normalizeLanAddresses(registration?.lanAddresses),
        lanPort: heartbeat?.lanPort || normalizeLanPort(registration?.lanPort),
        lanFingerprint256: heartbeat?.lanFingerprint256 || normalizeSha256(registration?.lanFingerprint256),
        registeredAt: registration?.registeredAt || null,
        lastRdpConnectedAt: registration?.lastRdpConnectedAt || null,
        workspacePath: heartbeat?.workspacePath || "",
        online: Boolean(heartbeat && now - Date.parse(heartbeat.lastSeenAt) < 15_000),
        lastSeenAt: heartbeat?.lastSeenAt || null,
      };
    });
    return sendJson(response, 200, { devices: list });
  }

  if (request.method === "POST" && url.pathname === "/v1/lan/tickets") {
    if (!authorizeController(request, response)) return;
    const input = await readJson(request, 16 * 1024);
    const deviceId = String(input.deviceId || '');
    const device = registeredDevices[deviceId];
    if (!device) return sendJson(response, 404, { error: 'unknown device' });
    if (!device.lanPort || !device.lanFingerprint256 || !device.lanSecret) return sendJson(response, 409, { error: 'device does not support LAN control' });
    const expires = Math.floor(Date.now() / 1000) + 120;
    const nonce = crypto.randomBytes(16).toString('hex');
    const key = crypto.createHmac('sha256', Buffer.from(device.lanSecret, 'hex')).update(`${deviceId}\n${expires}\n${nonce}`).digest('hex');
    return sendJson(response, 200, { deviceId, lanAddresses: normalizeLanAddresses(devices.get(deviceId)?.lanAddresses || device.lanAddresses), port: device.lanPort, fingerprint256: device.lanFingerprint256, expires, nonce, key });
  }

  if (request.method === "POST" && url.pathname === "/v1/commands") {
    if (!authorizeController(request, response)) return;
    const input = await readJson(request, maxBodyBytes);
    if (!agentTokens[input.deviceId]) {
      return sendJson(response, 404, { error: "unknown device" });
    }
    const commandBytes = typeof input.command === "string" ? Buffer.byteLength(input.command, "utf8") : 0;
    if (!commandBytes || commandBytes > maxCommandBytes) {
      return sendJson(response, 400, { error: "command must contain 1-1048576 UTF-8 bytes" });
    }
    if (input.cwd != null && (typeof input.cwd !== "string" || input.cwd.length > 4096)) {
      return sendJson(response, 400, { error: "invalid cwd" });
    }
    const requestedId = String(input.id || '');
    if (requestedId && !/^[a-f0-9-]{36}$/i.test(requestedId)) return sendJson(response, 400, { error: "invalid command ID" });
    if (requestedId && commands.has(requestedId)) {
      const existing = commands.get(requestedId);
      if (existing.deviceId !== input.deviceId || existing.command !== input.command || existing.cwd !== (input.cwd || "")) return sendJson(response, 409, { error: "command ID conflict" });
      return sendJson(response, 200, publicCommand(existing));
    }
    const pending = [...commands.values()].filter(
      (item) => item.deviceId === input.deviceId && ["queued", "running"].includes(item.status),
    );
    if (pending.length >= 20) {
      return sendJson(response, 429, { error: "device command queue is full" });
    }
    const timeoutSeconds = Math.max(1, Math.min(3600, Number(input.timeoutSeconds) || 300));
    const id = requestedId || crypto.randomUUID();
    const dispatchDelayMs = Math.max(0, Math.min(30_000, Number(input.dispatchDelayMs) || 0));
    const command = {
      id,
      deviceId: input.deviceId,
      command: input.command,
      cwd: input.cwd || "",
      timeoutSeconds,
      status: "queued",
      createdAt: new Date().toISOString(),
      dispatchAfter: new Date(Date.now() + dispatchDelayMs).toISOString(),
      startedAt: null,
      completedAt: null,
      exitCode: null,
      timedOut: false,
      output: null,
    };
    commands.set(id, command);
    return sendJson(response, 202, publicCommand(command));
  }

  const commandMatch = url.pathname.match(/^\/v1\/commands\/([a-f0-9-]+)$/);
  if (request.method === "GET" && commandMatch) {
    if (!authorizeController(request, response)) return;
    const command = commands.get(commandMatch[1]);
    return command
      ? sendJson(response, 200, publicCommand(command))
      : sendJson(response, 404, { error: "command not found" });
  }

  if (request.method === "DELETE" && commandMatch) {
    if (!authorizeController(request, response)) return;
    const command = commands.get(commandMatch[1]);
    if (!command) return sendJson(response, 404, { error: "command not found" });
    if (command.status === "queued") {
      command.status = "cancelled";
      command.completedAt = new Date().toISOString();
      command.exitCode = -2;
      command.output = "任务在执行前已由控制端取消。\n";
      return sendJson(response, 200, { command: publicCommand(command), remoteTerminationRequested: false });
    }
    if (command.status !== "running") return sendJson(response, 409, { error: "command is not running" });
    command.status = "cancelled";
    command.completedAt = new Date().toISOString();
    command.exitCode = -2;
    command.output = "任务已由控制端取消，正在请求设备结束任务树。\n";
    const cancellation = { id: crypto.randomUUID(), commandId: command.id, requestedAt: command.completedAt };
    const cancellations = cancellationRequests.get(command.deviceId) || [];
    cancellations.push(cancellation);
    cancellationRequests.set(command.deviceId, cancellations);
    console.log(JSON.stringify({ time: command.completedAt, event: "command.cancellation_requested", deviceId: command.deviceId, commandId: command.id, cancellationId: cancellation.id }));
    return sendJson(response, 202, { command: publicCommand(command), remoteTerminationRequested: true, cancellationId: cancellation.id });
  }

  if (request.method === 'POST' && url.pathname === '/v1/transfers') {
    if (!authorizeController(request, response)) return;
    const input = await readJson(request, 32 * 1024);
    const deviceId = String(input.deviceId || '');
    const direction = String(input.direction || '');
    const remotePath = String(input.remotePath || '');
    const requestedId = String(input.id || '');
    if (!agentTokens[deviceId]) return sendJson(response, 404, { error: 'unknown device' });
    if (!['upload', 'download'].includes(direction)) return sendJson(response, 400, { error: 'direction must be upload or download' });
    if (!remotePath || remotePath.length > 32767) return sendJson(response, 400, { error: 'invalid remote path' });
    if (requestedId && !/^[a-f0-9-]{36}$/i.test(requestedId)) return sendJson(response, 400, { error: 'invalid transfer ID' });
    const id = requestedId || crypto.randomUUID();
    const existing = transfers.get(id);
    if (existing) return sendJson(response, 200, publicTransfer(existing));
    const transfer = { id, deviceId, direction, remotePath, size: null, sha256: '', status: direction === 'upload' ? 'awaiting-controller-upload' : 'queued', createdAt: new Date().toISOString(), completedAt: null, error: '' };
    transfers.set(id, transfer);
    return sendJson(response, 201, publicTransfer(transfer));
  }

  const transferMatch = url.pathname.match(/^\/v1\/transfers\/([a-f0-9-]{36})(?:\/(content))?$/i);
  if (transferMatch && !transferMatch[2] && request.method === 'GET') {
    if (!authorizeController(request, response)) return;
    const transfer = transfers.get(transferMatch[1]);
    return transfer ? sendJson(response, 200, publicTransfer(transfer)) : sendJson(response, 404, { error: 'transfer not found' });
  }
  if (transferMatch && !transferMatch[2] && request.method === 'DELETE') {
    if (!authorizeController(request, response)) return;
    const transfer = transfers.get(transferMatch[1]);
    if (!transfer) return sendJson(response, 404, { error: 'transfer not found' });
    try { fs.unlinkSync(transferPath(transfer.id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    transfers.delete(transfer.id);
    return sendJson(response, 200, { id: transfer.id, removed: true });
  }
  if (transferMatch && transferMatch[2] && request.method === 'PUT') {
    if (!authorizeController(request, response)) return;
    const transfer = transfers.get(transferMatch[1]);
    if (!transfer || transfer.direction !== 'upload' || transfer.status !== 'awaiting-controller-upload') return sendJson(response, 409, { error: 'transfer is not awaiting upload' });
    const value = await receiveFile(request, transferPath(transfer.id), maxTransferBytes);
    const expected = normalizeSha256(request.headers['x-content-sha256']);
    if (expected && expected !== value.sha256) { fs.unlinkSync(transferPath(transfer.id)); return sendJson(response, 422, { error: 'SHA-256 mismatch' }); }
    transfer.size = value.size; transfer.sha256 = value.sha256; transfer.status = 'queued';
    return sendJson(response, 202, publicTransfer(transfer));
  }
  if (transferMatch && transferMatch[2] && request.method === 'GET') {
    if (!authorizeController(request, response)) return;
    const transfer = transfers.get(transferMatch[1]);
    if (!transfer || transfer.direction !== 'download' || transfer.status !== 'completed') return sendJson(response, 409, { error: 'transfer content is not ready' });
    const filename = transferPath(transfer.id);
    let stat; try { stat = fs.statSync(filename); } catch { return sendJson(response, 404, { error: 'transfer content not found' }); }
    return sendFile(response, filename, stat);
  }

  if (request.method === 'GET' && url.pathname === '/v1/agent/transfers/poll') {
    const deviceId = url.searchParams.get('device_id') || '';
    if (!authorizeAgent(request, response, deviceId)) return;
    const transfer = [...transfers.values()].find((item) => item.deviceId === deviceId && item.status === 'queued');
    if (!transfer) { response.writeHead(204, { 'Cache-Control': 'no-store' }); return response.end(); }
    transfer.status = 'running';
    return sendJson(response, 200, publicTransfer(transfer));
  }
  const agentTransferMatch = url.pathname.match(/^\/v1\/agent\/transfers\/([a-f0-9-]{36})(?:\/(content|complete))?$/i);
  if (agentTransferMatch) {
    const deviceId = url.searchParams.get('device_id') || '';
    if (!authorizeAgent(request, response, deviceId)) return;
    const transfer = transfers.get(agentTransferMatch[1]);
    if (!transfer || transfer.deviceId !== deviceId) return sendJson(response, 404, { error: 'transfer not found' });
    if (request.method === 'GET' && agentTransferMatch[2] === 'content' && transfer.direction === 'upload' && transfer.status === 'running') {
      const filename = transferPath(transfer.id); let stat; try { stat = fs.statSync(filename); } catch { return sendJson(response, 404, { error: 'transfer content not found' }); }
      return sendFile(response, filename, stat);
    }
    if (request.method === 'PUT' && agentTransferMatch[2] === 'content' && transfer.direction === 'download' && transfer.status === 'running') {
      const value = await receiveFile(request, transferPath(transfer.id), maxTransferBytes);
      transfer.size = value.size; transfer.sha256 = value.sha256; transfer.status = 'completed'; transfer.completedAt = new Date().toISOString();
      return sendJson(response, 201, publicTransfer(transfer));
    }
    if (request.method === 'POST' && agentTransferMatch[2] === 'complete') {
      const input = await readJson(request, 16 * 1024);
      transfer.status = input.error ? 'failed' : 'completed'; transfer.error = String(input.error || ''); transfer.completedAt = new Date().toISOString();
      return sendJson(response, 200, publicTransfer(transfer));
    }
  }

  return sendJson(response, 404, { error: "not found" });
}

function handleUpgrade(request, socket, head) {
  const url = new URL(request.url, "http://relay.local");
  if (url.pathname !== "/v1/agent/rdp") return socket.destroy();
  const deviceId = url.searchParams.get("device_id") || "";
  const sessionId = url.searchParams.get("session_id") || "";
  const session = rdpSessions.get(sessionId);
  // A newly started Agent may need to replace an idle WebSocket left behind by
  // an updater or a terminated desktop process. Never replace it while a
  // controller is actively using the session.
  if (!session || session.deviceId !== deviceId || !["queued", "connecting", "waiting"].includes(session.state) || !isAgentAuthorized(request, deviceId)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string" || request.headers["upgrade"]?.toLowerCase() !== "websocket") return socket.destroy();
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  attachRdpAgentSocket(session, socket);
  if (head?.length) socket.emit("data", head);
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) {
      sendJson(response, error.message.includes("large") ? 413 : 400, { error: error.message });
    } else {
      response.destroy();
    }
  });
});
server.on("upgrade", handleUpgrade);

server.requestTimeout = 0;
server.headersTimeout = 15_000;
server.listen(bindPort, bindHost, () => {
  console.log(`Remote Codex relay listening on http://${bindHost}:${bindPort}`);
});

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, command] of commands) {
    if (command.completedAt && Date.parse(command.completedAt) < cutoff) commands.delete(id);
  }
}, 60 * 60 * 1000).unref();

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, transfer] of transfers) {
    if (Date.parse(transfer.completedAt || transfer.createdAt) >= cutoff) continue;
    try { fs.unlinkSync(transferPath(id)); } catch {}
    transfers.delete(id);
  }
}, 60 * 60 * 1000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of rdpSessions) {
    if (session.expiresAt && Date.parse(session.expiresAt) <= now) {
      closeRdpSession(session, "expired", "RDP 会话已过期");
      rdpSessions.delete(id);
    }
  }
}, 30 * 1000).unref();
