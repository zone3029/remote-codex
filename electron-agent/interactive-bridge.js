const fs = require('node:fs');
const path = require('node:path');

const INTERACTIVE_MARKER = '# remote-codex-interactive-v1';

function directoryFor(userData) { return path.join(userData, 'interactive-commands'); }
function isInteractiveCommand(command) { return String(command || '').startsWith(INTERACTIVE_MARKER); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function writeJsonAtomically(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

async function executeInteractive({ userData, id, command, cwd, timeoutSeconds, cancelled = () => false }) {
  const directory = directoryFor(userData);
  const requestPath = path.join(directory, `request-${id}.json`);
  const responsePath = path.join(directory, `response-${id}.json`);
  writeJsonAtomically(requestPath, { id, command, cwd, timeoutSeconds, createdAt: new Date().toISOString() });
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (cancelled()) {
      writeJsonAtomically(path.join(directory, `cancel-${id}.json`), { id, cancelledAt: new Date().toISOString() });
      return { exitCode: 130, timedOut: false, output: Buffer.from('界面控制任务已取消') };
    }
    try {
      const value = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
      fs.unlinkSync(responsePath);
      return { exitCode: Number(value.exitCode), timedOut: Boolean(value.timedOut), output: Buffer.from(value.outputBase64 || '', 'base64') };
    } catch {}
    await sleep(150);
  }
  try { fs.unlinkSync(requestPath); } catch {}
  return { exitCode: 124, timedOut: true, output: Buffer.from('需要 Windows 用户登录并在 Agent 中开启界面控制') };
}

function startInteractiveBridge({ userData, execute, writeLog }) {
  const directory = directoryFor(userData);
  fs.mkdirSync(directory, { recursive: true });
  let stopped = false;
  let running = false;
  const timer = setInterval(async () => {
    if (stopped || running) return;
    running = true;
    try {
      const requests = fs.readdirSync(directory).filter((name) => /^request-[a-f0-9-]{36}\.json$/i.test(name));
      for (const filename of requests) {
        const requestPath = path.join(directory, filename);
        const processingPath = `${requestPath}.processing`;
        let request;
        try { fs.renameSync(requestPath, processingPath); request = JSON.parse(fs.readFileSync(processingPath, 'utf8')); } catch { continue; }
        const cancelPath = path.join(directory, `cancel-${request.id}.json`);
        let result;
        try {
          if (fs.existsSync(cancelPath)) result = { exitCode: 130, timedOut: false, output: Buffer.from('界面控制任务已取消') };
          else result = await execute(request.command, request.cwd, request.timeoutSeconds, request.id);
        } catch (error) { result = { exitCode: -1, timedOut: false, output: Buffer.from(error.message || String(error)) }; }
        writeJsonAtomically(path.join(directory, `response-${request.id}.json`), { exitCode: result.exitCode, timedOut: result.timedOut, outputBase64: Buffer.from(result.output || '').toString('base64') });
        try { fs.unlinkSync(processingPath); } catch {}
        try { fs.unlinkSync(cancelPath); } catch {}
        writeLog('info', 'interactive.command_finished', { commandId: request.id, exitCode: result.exitCode, timedOut: result.timedOut });
      }
    } catch (error) { writeLog('error', 'interactive.bridge_failed', { error: { message: error.message, stack: error.stack } }); }
    finally { running = false; }
  }, 250);
  return { close: () => { stopped = true; clearInterval(timer); } };
}

module.exports = { INTERACTIVE_MARKER, directoryFor, executeInteractive, isInteractiveCommand, startInteractiveBridge };
