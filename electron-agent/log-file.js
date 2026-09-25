const fs = require('node:fs');

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;

function rotateLog(filename) {
  try {
    if (fs.statSync(filename).size < MAX_LOG_BYTES) return;
    const backup = `${filename}.1`;
    try { fs.unlinkSync(backup); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(filename, backup);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function appendLog(filename, entry) {
  try {
    rotateLog(filename);
    fs.appendFileSync(filename, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {}
}

function readLogTail(filename, maximumBytes = MAX_TAIL_BYTES) {
  let descriptor;
  try {
    const stat = fs.statSync(filename);
    const length = Math.min(stat.size, maximumBytes);
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    descriptor = fs.openSync(filename, 'r');
    fs.readSync(descriptor, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return text;
  } catch { return ''; }
  finally { if (descriptor != null) try { fs.closeSync(descriptor); } catch {} }
}

module.exports = { MAX_LOG_BYTES, MAX_TAIL_BYTES, appendLog, readLogTail };
