const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  AUTHORIZATION_VERSION,
  authorizationIsCurrent,
  buildInstallScript,
  buildServiceXml,
  sharedDataIsReady,
  sharedUserDataPath,
} = require('../service-manager');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-service-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('shared data requires the system-service authorization version and a valid identity', (t) => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'identity.json'), JSON.stringify({ deviceId: 'win-desktop-test-12345678', agentToken: 'a'.repeat(64) }));
  fs.writeFileSync(path.join(directory, 'authorization.json'), JSON.stringify({ accepted: true, version: AUTHORIZATION_VERSION - 1 }));
  assert.equal(authorizationIsCurrent(directory), false);
  assert.equal(sharedDataIsReady(directory), false);
  fs.writeFileSync(path.join(directory, 'authorization.json'), JSON.stringify({ accepted: true, version: AUTHORIZATION_VERSION }));
  assert.equal(authorizationIsCurrent(directory), true);
  assert.equal(sharedDataIsReady(directory), true);
});

test('service XML runs the packaged worker as a LocalSystem-compatible Node process', () => {
  const xml = buildServiceXml({
    executable: 'C:\\Program Files\\Remote Codex Agent\\Remote Codex Agent.exe',
    appRoot: 'C:\\Program Files\\Remote Codex Agent\\resources\\app.asar',
    userData: 'C:\\ProgramData\\Remote Codex Agent',
  });
  assert.match(xml, /<id>RemoteCodexAgentService<\/id>/);
  assert.match(xml, /service-host\.js<\/argument>/);
  assert.match(xml, /ELECTRON_RUN_AS_NODE/);
  assert.match(xml, /C:\\ProgramData\\Remote Codex Agent/);
  assert.match(xml, /<workingdirectory>C:\\Program Files\\Remote Codex Agent\\resources<\/workingdirectory>/);
  assert.doesNotMatch(xml, /<workingdirectory>[^<]*app\.asar<\/workingdirectory>/);
  assert.doesNotMatch(xml, /agentToken|controllerToken/);
});

test('service install script preserves identity, applies narrow ACLs, and configures recovery', () => {
  const script = buildInstallScript({
    wrapperSource: 'C:\\source\\winsw.exe',
    wrapperConfigSource: 'C:\\source\\winsw.exe.config',
    xmlSource: 'C:\\temp\\service.xml',
    serviceDirectory: 'C:\\ProgramData\\Remote Codex Agent\\service',
    dataDirectory: 'C:\\ProgramData\\Remote Codex Agent',
    sourceDataDirectory: 'C:\\Users\\test\\AppData\\Roaming\\remote-codex-agent',
    userSid: 'S-1-5-21-1-2-3-1001',
    resultPath: '__RESULT_PATH__',
  });
  assert.match(script, /identity\.json/);
  assert.match(script, /start= delayed-auto/);
  assert.match(script, /restart\/5000\/restart\/15000\/restart\/30000/);
  assert.match(script, /\*S-1-5-21-1-2-3-1001:\(OI\)\(CI\)M/);
  assert.match(script, /icacls\.exe \$children \/inheritance:e \/T \/C/);
  assert.ok(script.indexOf('Repair-DataAcl') < script.indexOf("Copy-Item -LiteralPath 'C:\\source\\winsw.exe'"));
  assert.doesNotMatch(script, /\/grant:r[^\n]+\/T \/C/);
  assert.doesNotMatch(script, /BUILTIN\\Users.*\(OI\)\(CI\)F/);
});

test('shared ProgramData path does not depend on the signed-in profile', () => {
  assert.equal(sharedUserDataPath({ PROGRAMDATA: 'D:\\SystemData' }), 'D:\\SystemData\\Remote Codex Agent');
});
