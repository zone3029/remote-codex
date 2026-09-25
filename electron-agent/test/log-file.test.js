const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MAX_LOG_BYTES, MAX_TAIL_BYTES, appendLog, readLogTail } = require('../log-file');

function temporaryLog(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'agent.log');
}

test('appendLog rotates an oversized log and keeps one backup', (t) => {
  const filename = temporaryLog(t);
  fs.writeFileSync(filename, Buffer.alloc(MAX_LOG_BYTES, 0x61));

  appendLog(filename, { event: 'after-rotation' });

  assert.equal(fs.statSync(`${filename}.1`).size, MAX_LOG_BYTES);
  assert.match(fs.readFileSync(filename, 'utf8'), /"event":"after-rotation"/);
});

test('readLogTail is bounded and starts at a complete line', (t) => {
  const filename = temporaryLog(t);
  const line = `${'x'.repeat(1020)}\n`;
  fs.writeFileSync(filename, line.repeat(Math.ceil((MAX_TAIL_BYTES * 2) / Buffer.byteLength(line))));

  const tail = readLogTail(filename);

  assert.ok(Buffer.byteLength(tail) <= MAX_TAIL_BYTES);
  assert.equal(tail.startsWith('x'.repeat(1020)), true);
  assert.equal(tail.endsWith('\n'), true);
  assert.equal(tail.split('\n').filter(Boolean).every((value) => value.length === 1020), true);
});
