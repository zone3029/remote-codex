const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHECK_INTERVAL_MS = 5000;
const HEARTBEAT_MAX_AGE_MS = 30000;
const RESTART_COOLDOWN_MS = 60000;

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; }
}

function heartbeatIsFresh(filename, now = Date.now(), maximumAgeMs = HEARTBEAT_MAX_AGE_MS) {
  const heartbeat = readJson(filename);
  const updatedAt = Date.parse(heartbeat?.updatedAt || '');
  return Number.isInteger(heartbeat?.pid)
    && Number.isFinite(updatedAt)
    && now - updatedAt >= 0
    && now - updatedAt < maximumAgeMs;
}

function acquireLock(filename, pid = process.pid) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(filename, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(readJson(filename)?.pid);
      if (processIsRunning(owner)) return false;
      try { fs.unlinkSync(filename); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  return false;
}

function releaseLock(filename, pid = process.pid) {
  if (Number(readJson(filename)?.pid) !== pid) return;
  try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function appendWatchdogLog(filename, event, details = {}) {
  try {
    if (fs.statSync(filename).size > 1024 * 1024) fs.renameSync(filename, `${filename}.1`);
  } catch {}
  try { fs.appendFileSync(filename, `${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`, 'utf8'); } catch {}
}

function launchAgent(agentExecutable) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(agentExecutable, ['--hidden', '--watchdog-restart'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  return child.pid;
}

function runWatchdog({ userData, agentExecutable }) {
  if (!userData || !agentExecutable) throw new Error('watchdog requires userData and agentExecutable');
  const heartbeatPath = path.join(userData, 'main-heartbeat.json');
  const lockPath = path.join(userData, 'watchdog.json');
  const stopPath = path.join(userData, 'watchdog-stop.json');
  const logPath = path.join(userData, 'watchdog.log');
  if (!acquireLock(lockPath)) return false;

  let lastRestartAt = 0;
  const cleanup = () => { try { releaseLock(lockPath); } catch {} };
  const check = () => {
    if (fs.existsSync(stopPath)) {
      try { fs.unlinkSync(stopPath); } catch {}
      appendWatchdogLog(logPath, 'watchdog.stop_requested');
      cleanup();
      process.exit(0);
    }
    const now = Date.now();
    if (heartbeatIsFresh(heartbeatPath, now)) return;
    if (now - lastRestartAt < RESTART_COOLDOWN_MS) return;
    lastRestartAt = now;
    try {
      const pid = launchAgent(agentExecutable);
      appendWatchdogLog(logPath, 'agent.restart_requested', { pid });
    } catch (error) {
      appendWatchdogLog(logPath, 'agent.restart_failed', { error: error.message });
    }
  };

  process.once('exit', cleanup);
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  process.once('SIGINT', () => { cleanup(); process.exit(0); });
  appendWatchdogLog(logPath, 'watchdog.started', { pid: process.pid });
  check();
  setInterval(check, CHECK_INTERVAL_MS);
  return true;
}

if (require.main === module) {
  const userData = process.argv[2] || process.env.REMOTE_CODEX_USER_DATA;
  const agentExecutable = process.argv[3] || process.env.REMOTE_CODEX_AGENT_EXE;
  try {
    if (!runWatchdog({ userData, agentExecutable })) process.exit(0);
  } catch (error) {
    try { appendWatchdogLog(path.join(userData || '.', 'watchdog.log'), 'watchdog.failed', { error: error.message }); } catch {}
    process.exit(1);
  }
}

module.exports = {
  CHECK_INTERVAL_MS,
  HEARTBEAT_MAX_AGE_MS,
  RESTART_COOLDOWN_MS,
  acquireLock,
  heartbeatIsFresh,
  processIsRunning,
  releaseLock,
  runWatchdog,
};
