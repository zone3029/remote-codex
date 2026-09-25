const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EMPTY_SHA256, startLanServer } = require('../lan-server');

function signedRequest(server, deviceId, pathname, { method = 'GET', body = Buffer.alloc(0), transferId = '' } = {}) {
  const ticketExpires = String(Math.floor(Date.now() / 1000) + 120);
  const ticketNonce = crypto.randomBytes(16).toString('hex');
  const ticketKey = crypto.createHmac('sha256', Buffer.from(server.secret, 'hex')).update(`${deviceId}\n${ticketExpires}\n${ticketNonce}`).digest();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodySha256 = body.length ? crypto.createHash('sha256').update(body).digest('hex') : EMPTY_SHA256;
  const canonical = `${timestamp}\n${nonce}\n${method}\n${pathname}\n${bodySha256}`;
  const signature = crypto.createHmac('sha256', ticketKey).update(canonical).digest('hex');
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: '127.0.0.1', port: server.port, path: pathname, method, rejectUnauthorized: false, headers: { 'Content-Length': String(body.length), 'X-Content-Sha256': bodySha256, 'X-Remote-Codex-Timestamp': timestamp, 'X-Remote-Codex-Nonce': nonce, 'X-Remote-Codex-Ticket-Expires': ticketExpires, 'X-Remote-Codex-Ticket-Nonce': ticketNonce, 'X-Remote-Codex-Signature': signature, ...(transferId ? { 'X-Transfer-Id': transferId } : {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-lan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const commands = new Map();
  const deviceId = 'win-desktop-test-12345678';
  const server = startLanServer({
    userData: directory,
    deviceId,
    port: 0,
    host: '127.0.0.1',
    configureFirewall: false,
    writeLog: (_, event) => { if (event === 'lan.server_started') resolveStarted(); },
    submitCommand: (input) => { const value = { id: input.id, status: 'running' }; commands.set(input.id, value); return value; },
    commandStatus: (id) => commands.get(id),
    cancelCommand: async (id) => ({ cancelled: commands.has(id) }),
  });
  t.after(() => server.close());
  await started;
  return { directory, deviceId, server };
}

test('LAN command endpoint accepts a short-lived signed request', async (t) => {
  const { deviceId, server } = await fixture(t);
  const id = crypto.randomUUID();
  const body = Buffer.from(JSON.stringify({ id, command: 'Get-Date', timeoutSeconds: 30 }));
  const submitted = await signedRequest(server, deviceId, '/v1/lan/commands', { method: 'POST', body });
  assert.equal(submitted.status, 202);
  assert.deepEqual(JSON.parse(submitted.body), { id, status: 'running' });
  const status = await signedRequest(server, deviceId, `/v1/lan/commands/${id}`);
  assert.equal(status.status, 200);
});

test('LAN upload is atomic, verified, and idempotent by transfer ID', async (t) => {
  const { directory, deviceId, server } = await fixture(t);
  const destination = path.join(directory, 'nested', 'sample.bin');
  const transferId = crypto.randomUUID();
  const body = crypto.randomBytes(64 * 1024);
  const pathname = `/v1/lan/files?path=${encodeURIComponent(destination)}`;
  const first = await signedRequest(server, deviceId, pathname, { method: 'PUT', body, transferId });
  assert.equal(first.status, 201);
  assert.deepEqual(fs.readFileSync(destination), body);
  const second = await signedRequest(server, deviceId, pathname, { method: 'PUT', body: Buffer.from('different'), transferId });
  assert.equal(second.status, 200);
  assert.deepEqual(fs.readFileSync(destination), body);
});

test('LAN download includes a SHA-256 checksum', async (t) => {
  const { directory, deviceId, server } = await fixture(t);
  const source = path.join(directory, 'download.bin');
  const body = crypto.randomBytes(32 * 1024);
  fs.writeFileSync(source, body);
  const result = await signedRequest(server, deviceId, `/v1/lan/files?path=${encodeURIComponent(source)}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, body);
  assert.equal(result.headers['x-content-sha256'], crypto.createHash('sha256').update(body).digest('hex'));
});

test('LAN endpoint rejects an unsigned request', async (t) => {
  const { server } = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const request = https.get({ hostname: '127.0.0.1', port: server.port, path: '/v1/lan/commands/00000000-0000-0000-0000-000000000000', rejectUnauthorized: false }, (value) => { value.resume(); value.once('end', () => resolve(value)); });
    request.once('error', reject);
  });
  assert.equal(response.statusCode, 401);
});
