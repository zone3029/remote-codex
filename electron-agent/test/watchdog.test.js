const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { acquireLock, heartbeatIsFresh, releaseLock } = require('../watchdog');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-watchdog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('heartbeat freshness requires a recent timestamp and PID', (t) => {
  const filename = path.join(temporaryDirectory(t), 'heartbeat.json');
  const now = Date.now();
  fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, updatedAt: new Date(now - 1000).toISOString() }));
  assert.equal(heartbeatIsFresh(filename, now, 5000), true);
  assert.equal(heartbeatIsFresh(filename, now + 6000, 5000), false);
  fs.writeFileSync(filename, JSON.stringify({ updatedAt: new Date(now).toISOString() }));
  assert.equal(heartbeatIsFresh(filename, now, 5000), false);
});

test('watchdog lock rejects a live owner and replaces a stale owner', (t) => {
  const filename = path.join(temporaryDirectory(t), 'watchdog.json');
  assert.equal(acquireLock(filename, process.pid), true);
  assert.equal(acquireLock(filename, process.pid + 1), false);
  releaseLock(filename, process.pid);
  fs.writeFileSync(filename, JSON.stringify({ pid: 99999999 }));
  assert.equal(acquireLock(filename, process.pid), true);
  releaseLock(filename, process.pid);
  assert.equal(fs.existsSync(filename), false);
});
