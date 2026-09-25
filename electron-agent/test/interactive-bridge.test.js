const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { INTERACTIVE_MARKER, executeInteractive, isInteractiveCommand, startInteractiveBridge } = require('../interactive-bridge');

test('interactive commands are delegated to the signed-in Electron session', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-interactive-test-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const logs = [];
  const bridge = startInteractiveBridge({
    userData,
    execute: async (command, cwd) => ({ exitCode: 0, timedOut: false, output: Buffer.from(`${cwd}|${command.split('\n')[0]}`) }),
    writeLog: (...values) => logs.push(values),
  });
  t.after(() => bridge.close());
  const command = `${INTERACTIVE_MARKER}\nWrite-Output ok`;
  const result = await executeInteractive({ userData, id: '11111111-1111-4111-8111-111111111111', command, cwd: 'C:\\Work', timeoutSeconds: 5 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.toString(), `C:\\Work|${INTERACTIVE_MARKER}`);
  assert.equal(isInteractiveCommand(command), true);
  assert.equal(logs.some((entry) => entry[1] === 'interactive.command_finished'), true);
});

test('ordinary PowerShell commands stay in the service worker', () => {
  assert.equal(isInteractiveCommand('Get-ComputerInfo'), false);
});
