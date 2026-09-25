const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, nativeImage, session, shell, powerMonitor, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const netSocket = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { autoUpdater } = require('electron-updater');
const { privateIpv4Addresses } = require('./network-addresses');
const { appendLog, readLogTail } = require('./log-file');
const { startInteractiveBridge } = require('./interactive-bridge');
const {
  AUTHORIZATION_VERSION,
  ensureWindowsService,
  serviceState,
  sharedDataIsReady,
  sharedUserDataPath,
} = require('./service-manager');
const embeddedConfig = require('./embedded-config.json');

const legacyUserDataPath = app.getPath('userData');
const systemUserDataPath = sharedUserDataPath();
if (process.platform === 'win32' && sharedDataIsReady(systemUserDataPath)) app.setPath('userData', systemUserDataPath);

const MAX_OUTPUT = 2 * 1024 * 1024;
let tray;
let window;
let config = null;
let polling = false;
let controlPolling = false;
let stopRequested = false;
let status = { state: 'not-configured', message: '需要配置中继服务器' };
let selectedWorkspace = '';
let updateStatus = { state: 'idle', message: '尚未检查更新' };
let rdpStatus = { state: 'starting', message: '正在自动启动永久远程桌面', sessionId: '', host: '', port: 0, username: '', expiresAt: '', ttlSeconds: 0 };
let computerUseStatus = { enabled: false, message: '未授权', enabledAt: null, sessionId: null };
let rdpTunnel = null;
let rdpPowerSaveBlockerId = null;
let lastPollStartedAt = null;
let lastPollCompletedAt = null;
let workerPid = null;
let workerStateTimer = null;
let mainHeartbeatTimer = null;
let recoveryTimer = null;
let watchdogPid = null;
let interactiveBridge = null;
let systemServiceStatus = { state: process.platform === 'win32' ? serviceState() : 'unsupported', message: '尚未配置系统服务' };
let logWatcherOffset = 0;
const verifiedCertificateHosts = new Set();
const isPrimaryInstance = app.requestSingleInstanceLock();

if (!isPrimaryInstance) app.quit();
else app.on('second-instance', (_event, argv) => {
  if (!argv.includes('--hidden')) openWindow();
});

function logPath() { return path.join(app.getPath('userData'), 'agent.log'); }
function mainHeartbeatPath() { return path.join(app.getPath('userData'), 'main-heartbeat.json'); }
function watchdogStatePath() { return path.join(app.getPath('userData'), 'watchdog.json'); }
function watchdogStopPath() { return path.join(app.getPath('userData'), 'watchdog-stop.json'); }
function workspacePath() { return path.join(app.getPath('userData'), 'workspace.json'); }
function readWorkspace() { try { const value = JSON.parse(fs.readFileSync(workspacePath(), 'utf8')).path; return fs.statSync(value).isDirectory() ? value : ''; } catch { return ''; } }
function saveWorkspace(value) {
  const resolved = path.resolve(String(value || ''));
  if (!fs.statSync(resolved).isDirectory()) throw new Error('拖入的内容不是文件夹');
  selectedWorkspace = resolved;
  fs.writeFileSync(workspacePath(), JSON.stringify({ path: resolved }, null, 2), { mode: 0o600 });
  writeLog('info', 'workspace.changed', { path: resolved });
  if (window && !window.isDestroyed()) window.webContents.send('workspace', resolved);
  return resolved;
}
function serializeError(error) {
  if (!error) return null;
  return { name: error.name, message: error.message, code: error.code, errno: error.errno, stack: error.stack, cause: error.cause ? serializeError(error.cause) : null };
}
function writeLog(level, event, details = {}) {
  const entry = { time: new Date().toISOString(), level, event, ...details };
  appendLog(logPath(), entry);
  if (window && !window.isDestroyed()) window.webContents.send('log-entry', entry);
  console.log(JSON.stringify(entry));
}
function emitLogLines(text) {
  if (!window || window.isDestroyed()) return;
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    try { window.webContents.send('log-entry', JSON.parse(line)); } catch { window.webContents.send('log-entry', { time: new Date().toISOString(), level: 'error', event: 'log.parse_failed', text: line }); }
  }
}
function startLogWatcher() {
  try { logWatcherOffset = fs.statSync(logPath()).size; } catch { logWatcherOffset = 0; }
  fs.watchFile(logPath(), { interval: 500 }, (current) => {
    try {
      if (current.size < logWatcherOffset) logWatcherOffset = 0;
      if (current.size <= logWatcherOffset) return;
      const available = current.size - logWatcherOffset;
      const length = Math.min(available, 1024 * 1024);
      if (available > length) logWatcherOffset = current.size - length;
      const buffer = Buffer.alloc(length);
      const descriptor = fs.openSync(logPath(), 'r');
      fs.readSync(descriptor, buffer, 0, length, logWatcherOffset);
      fs.closeSync(descriptor);
      logWatcherOffset = current.size;
      emitLogLines(buffer.toString('utf8'));
    } catch (error) { console.error('log watcher failed', error); }
  });
}

function writeMainHeartbeat() {
  const destination = mainHeartbeatPath();
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString(), appVersion: app.getVersion() })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    writeLog('error', 'watchdog.heartbeat_failed', { error: serializeError(error) });
  }
}

function startMainHeartbeat() {
  writeMainHeartbeat();
  if (mainHeartbeatTimer) clearInterval(mainHeartbeatTimer);
  mainHeartbeatTimer = setInterval(writeMainHeartbeat, 5000);
}

function stopMainHeartbeat() {
  if (mainHeartbeatTimer) clearInterval(mainHeartbeatTimer);
  mainHeartbeatTimer = null;
  try {
    const value = JSON.parse(fs.readFileSync(mainHeartbeatPath(), 'utf8'));
    if (Number(value.pid) === process.pid) fs.unlinkSync(mainHeartbeatPath());
  } catch {}
}

function startWatchdog() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try { fs.unlinkSync(watchdogStopPath()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const existingPid = Number(JSON.parse(fs.readFileSync(watchdogStatePath(), 'utf8')).pid);
    process.kill(existingPid, 0);
    watchdogPid = existingPid;
    writeLog('info', 'watchdog.reused', { pid: watchdogPid });
    return;
  } catch {}
  const child = spawn(process.execPath, [path.join(__dirname, 'watchdog.js'), app.getPath('userData'), process.execPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  watchdogPid = child.pid;
  child.unref();
  writeLog('info', 'watchdog.spawned', { pid: watchdogPid });
}

function stopWatchdog() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try { fs.writeFileSync(watchdogStopPath(), `${JSON.stringify({ requestedAt: new Date().toISOString(), mainPid: process.pid })}\n`, { mode: 0o600 }); }
  catch (error) { writeLog('error', 'watchdog.stop_request_failed', { error: serializeError(error) }); }
}

function identityPath() { return path.join(app.getPath('userData'), 'identity.json'); }
function relayConfigPath() { return path.join(app.getPath('userData'), 'relay-config.json'); }
function normalizeServerUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (parsed.protocol !== 'https:') throw new Error('中继服务器必须使用 HTTPS 地址');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('中继服务器地址不能包含账号、查询参数或片段');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}
function normalizeCertificateFingerprint(value) {
  const normalized = String(value || '').replace(/[\s:-]/g, '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) throw new Error('证书 SHA-256 指纹必须是 64 位十六进制字符');
  return normalized.match(/.{2}/g).join(':');
}
function validateRelayConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const server = normalizeServerUrl(source.server);
  const enrollmentToken = String(source.enrollmentToken || '').trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(enrollmentToken)) throw new Error('注册令牌至少需要 32 个字母、数字、下划线或短横线');
  return { server, enrollmentToken, certificateFingerprint256: normalizeCertificateFingerprint(source.certificateFingerprint256), allowInsecure: false, updatedAt: new Date().toISOString() };
}
function readRelayConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(relayConfigPath(), 'utf8'));
    return validateRelayConfig(value);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`relay-config ignored: ${error.message}`);
    return null;
  }
}
function publicRelayConfig() {
  const value = config || {};
  const token = String(value.enrollmentToken || '');
  return {
    server: value.server || '',
    enrollmentTokenConfigured: token.length >= 32,
    certificateFingerprint256: value.certificateFingerprint256 || '',
    allowInsecure: false,
  };
}
function saveRelayConfig(value) {
  const source = { ...(value || {}) };
  if (!String(source.enrollmentToken || '').trim()) source.enrollmentToken = config?.enrollmentToken || '';
  const normalized = validateRelayConfig(source);
  const destination = relayConfigPath();
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  config = { ...config, ...normalized };
  writeLog('info', 'relay_config.changed', { server: normalized.server, certificateFingerprint256: normalized.certificateFingerprint256 });
  return publicRelayConfig();
}
function normalizeDeviceAlias(value) {
  const alias = String(value || '').trim().replace(/\s+/g, ' ');
  if (alias.length > 64) throw new Error('别称最多 64 个字符');
  if (/[\u0000-\u001f\u007f]/.test(alias)) throw new Error('别称不能包含控制字符');
  return alias;
}
function saveDeviceAlias(value) {
  const alias = normalizeDeviceAlias(value);
  const identity = JSON.parse(fs.readFileSync(identityPath(), 'utf8'));
  identity.alias = alias;
  fs.writeFileSync(identityPath(), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  config.alias = alias;
  writeLog('info', 'device.alias_changed', { deviceId: config.deviceId, alias });
  return alias;
}
function authorizationPath() { return path.join(app.getPath('userData'), 'authorization.json'); }
function interactiveUserDataPath() { return process.platform === 'win32' ? systemUserDataPath : app.getPath('userData'); }
function computerUseConsentPath() { return path.join(interactiveUserDataPath(), 'computer-use-consent.json'); }
function computerUseScriptPath() { return path.join(interactiveUserDataPath(), 'remote-computer-use.ps1'); }
function publishComputerUseStatus(next) {
  computerUseStatus = { ...computerUseStatus, ...next };
  if (window && !window.isDestroyed()) window.webContents.send('computer-use-status', computerUseStatus);
  return computerUseStatus;
}
function disableComputerUse(reason = 'user') {
  try { fs.unlinkSync(computerUseConsentPath()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  writeLog('info', 'computer_use.disabled', { reason });
  return publishComputerUseStatus({ enabled: false, message: '未授权', enabledAt: null, sessionId: null });
}
function enableComputerUse(reason = 'user') {
  if (process.platform !== 'win32') throw new Error('界面控制仅支持 Windows');
  const value = { enabled: true, enabledAt: new Date().toISOString(), controllerPid: process.pid, sessionId: crypto.randomUUID() };
  fs.writeFileSync(computerUseConsentPath(), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  writeLog('info', 'computer_use.enabled', { sessionId: value.sessionId, reason });
  return publishComputerUseStatus({ enabled: true, message: '已授权本机 Codex 控制当前桌面', enabledAt: value.enabledAt, sessionId: value.sessionId });
}
function installComputerUseScript() {
  const source = fs.readFileSync(path.join(__dirname, 'remote-computer-use.ps1'));
  const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const body = source.subarray(0, 3).equals(utf8Bom) ? source.subarray(3) : source;
  fs.writeFileSync(computerUseScriptPath(), Buffer.concat([utf8Bom, body]), { mode: 0o600 });
  writeLog('info', 'computer_use.script_ready', { path: computerUseScriptPath() });
}
function authorizationAccepted() {
  try {
    const value = JSON.parse(fs.readFileSync(authorizationPath(), 'utf8'));
    return value.accepted === true && Number(value.version) >= AUTHORIZATION_VERSION;
  } catch { return false; }
}
function uninstallAfterAuthorizationRejected() {
  stopRequested = true;
  const uninstaller = path.join(path.dirname(process.execPath), 'Uninstall Remote Codex Agent.exe');
  if (app.isPackaged && process.platform === 'win32' && fs.existsSync(uninstaller)) {
    // Wait for this executable to exit before NSIS removes the installation directory.
    const command = `ping 127.0.0.1 -n 2 > nul & "${uninstaller}" /S`;
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  app.exit(0);
}
async function requestAuthorization() {
  if (!app.isPackaged || process.platform !== 'win32' || authorizationAccepted()) return true;
  try {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '系统级远程管理授权确认',
      message: '请确认是否授权此电脑在开机后接受远程管理',
      detail: '选择“同意并启用系统服务”即表示您明确授权 Remote Codex 安装 Windows 系统服务。该服务会在用户登录前以 LocalSystem 身份连接中转服务器，并可执行远程 PowerShell 任务、传输指定文件以及建立远程桌面隧道。系统级命令具有管理员权限，请只在您信任管理者和中转服务器时启用。\n\n用户登录并启动软件后，界面截图、鼠标和键盘控制会默认开启，可随时在软件界面关闭；它不能绕过 Windows 登录界面或安全桌面。远程桌面会话默认永不失效，直到用户或管理端主动关闭。软件不会读取、保存或显示 Windows 密码。\n\n选择“拒绝并卸载”或直接关闭本提示，将关闭并卸载本软件。',
      buttons: ['同意并启用系统服务', '拒绝并卸载'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) {
      writeLog('info', 'authorization.rejected');
      await stopWorker();
      uninstallAfterAuthorizationRejected();
      return false;
    }
    fs.writeFileSync(authorizationPath(), `${JSON.stringify({ accepted: true, acceptedAt: new Date().toISOString(), version: AUTHORIZATION_VERSION, systemService: true }, null, 2)}\n`, { mode: 0o600 });
    writeLog('info', 'authorization.accepted');
    return true;
  } catch (error) {
    writeLog('error', 'authorization.prompt_failed', { error: serializeError(error) });
    await stopWorker();
    uninstallAfterAuthorizationRejected();
    return false;
  }
}
function publishStatus(next) {
  status = { ...status, ...next, at: new Date().toISOString() };
  if (window && !window.isDestroyed()) window.webContents.send('status', status);
  if (tray) tray.setToolTip(`Remote Codex Agent: ${status.message}`);
}
function readConfig() {
  let identity;
  try {
    identity = JSON.parse(fs.readFileSync(identityPath(), 'utf8'));
    if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(identity.deviceId) || !/^[a-f0-9]{64}$/i.test(identity.agentToken)) throw new Error('invalid identity');
  } catch {
    const prefix = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
    const hostname = os.hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'computer';
    const suffix = crypto.randomBytes(4).toString('hex');
    const maxHostnameLength = 64 - prefix.length - suffix.length - 2;
    identity = {
      deviceId: `${prefix}-${hostname.slice(0, maxHostnameLength)}-${suffix}`,
      agentToken: crypto.randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(identityPath()), { recursive: true });
    fs.writeFileSync(identityPath(), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  }
  if (process.platform === 'win32' && os.userInfo().username.toUpperCase() !== 'SYSTEM') {
    const windowsUsername = `${os.hostname()}\\${os.userInfo().username}`;
    if (identity.windowsUsername !== windowsUsername) {
      identity.windowsUsername = windowsUsername;
      fs.writeFileSync(identityPath(), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    }
  }
  return { ...embeddedConfig, ...(readRelayConfig() || {}), ...identity, alias: normalizeDeviceAlias(identity.alias) };
}
function openWindow() {
  if (window && !window.isDestroyed()) { window.show(); return; }
  window = new BrowserWindow({ width: 760, height: 620, minWidth: 640, minHeight: 500, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.on('close', (event) => {
    writeLog('info', 'window.close_requested', { stopRequested });
    if (!stopRequested && config) { event.preventDefault(); window.hide(); }
  });
  window.on('minimize', (event) => {
    event.preventDefault();
    window.hide();
    writeLog('info', 'window.minimized_to_tray');
  });
  window.on('show', () => writeLog('debug', 'window.shown'));
  window.on('hide', () => writeLog('debug', 'window.hidden'));
  window.on('unresponsive', () => writeLog('error', 'window.unresponsive'));
  window.on('responsive', () => writeLog('info', 'window.responsive'));
  window.on('closed', () => writeLog('error', 'window.closed'));
  window.webContents.on('render-process-gone', (_, details) => writeLog('error', 'renderer.process_gone', details));
}

function keepRdpProcessAwake() {
  if (rdpPowerSaveBlockerId == null) rdpPowerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
}

function releaseRdpProcessAwake() {
  if (rdpPowerSaveBlockerId != null && powerSaveBlocker.isStarted(rdpPowerSaveBlockerId)) powerSaveBlocker.stop(rdpPowerSaveBlockerId);
  rdpPowerSaveBlockerId = null;
}
function workerStatePath() { return path.join(app.getPath('userData'), 'worker-state.json'); }
function workerCommandDirectory() { return path.join(app.getPath('userData'), 'worker-commands'); }
function readWorkerState() {
  try { return JSON.parse(fs.readFileSync(workerStatePath(), 'utf8')); } catch { return null; }
}
function refreshWorkerState() {
  const value = readWorkerState();
  if (!value || !value.updatedAt || Date.now() - Date.parse(value.updatedAt) > 20000) return;
  if (value.status) publishStatus(value.status);
  if (value.rdpStatus) setRdpStatus(value.rdpStatus);
}
function workerIsHealthy() {
  const value = readWorkerState();
  if (!value?.pid || !value?.updatedAt || Date.now() - Date.parse(value.updatedAt) >= 15000) return false;
  if (['running', 'starting'].includes(serviceState())) return true;
  try { process.kill(Number(value.pid), 0); return true; } catch { return false; }
}
function startWorker() {
  const currentServiceState = serviceState();
  if (['running', 'starting'].includes(currentServiceState)) {
    workerPid = readWorkerState()?.pid || null;
    writeLog('info', 'worker.owned_by_service', { serviceState: currentServiceState, pid: workerPid });
    return;
  }
  if (workerIsHealthy()) {
    workerPid = readWorkerState().pid;
    writeLog('info', 'worker.reused', { pid: workerPid });
    return;
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'worker.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', REMOTE_CODEX_USER_DATA: app.getPath('userData'), REMOTE_CODEX_APP_VERSION: app.getVersion(), REMOTE_CODEX_APP_ROOT: __dirname },
  });
  workerPid = child.pid;
  child.unref();
  writeLog('info', 'worker.spawned', { pid: workerPid });
}

async function configureSystemService() {
  if (!app.isPackaged || process.platform !== 'win32') {
    systemServiceStatus = { state: 'unsupported', message: '开发预览不安装 Windows 服务' };
    return { relaunch: false };
  }
  systemServiceStatus = { state: 'installing', message: '正在安装 Windows 系统服务' };
  try {
    const result = await ensureWindowsService({
      resourcesPath: process.resourcesPath,
      executable: process.execPath,
      appRoot: __dirname,
      sourceDataDirectory: app.getPath('userData'),
      dataDirectory: systemUserDataPath,
    });
    systemServiceStatus = { state: result.state || 'running', message: '系统服务运行中，登录前保持在线' };
    writeLog('info', 'service.ready', { state: result.state, migrated: result.migrated, dataDirectory: result.dataDirectory || systemUserDataPath });
    if (app.getPath('userData') !== systemUserDataPath) {
      writeLog('info', 'service.relaunch_for_shared_data', { from: app.getPath('userData'), to: systemUserDataPath });
      app.relaunch({ args: process.argv.slice(1) });
      stopRequested = true;
      app.exit(0);
      return { relaunch: true };
    }
    return { relaunch: false };
  } catch (error) {
    systemServiceStatus = { state: 'error', message: `系统服务未启用：${error.message}` };
    writeLog('error', 'service.install_failed', { error: serializeError(error) });
    return { relaunch: false, error };
  }
}
function scheduleRecovery(reason) {
  if (stopRequested) return;
  writeMainHeartbeat();
  if (recoveryTimer) clearTimeout(recoveryTimer);
  writeLog('info', 'power.recovery_scheduled', { reason });
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (stopRequested) return;
    const healthy = workerIsHealthy();
    if (!healthy) startWorker();
    writeLog('info', 'power.recovery_completed', { reason, workerHealthyBeforeRecovery: healthy, workerPid });
  }, 2000);
}
function setupPowerRecovery() {
  if (process.platform !== 'win32') return;
  powerMonitor.on('resume', () => scheduleRecovery('resume'));
  powerMonitor.on('unlock-screen', () => scheduleRecovery('unlock-screen'));
}
function requestWorkerCommand(type, values = {}, timeoutMs = 25000) {
  const id = crypto.randomUUID();
  const directory = workerCommandDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const requestPath = path.join(directory, `request-${id}.json`);
  const temporaryPath = `${requestPath}.tmp`;
  const responsePath = path.join(directory, `response-${id}.json`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ id, type, ...values })}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, requestPath);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      try {
        if (fs.existsSync(responsePath)) {
          const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
          fs.unlinkSync(responsePath);
          clearInterval(timer);
          if (response.ok) resolve(response.value || true);
          else reject(new Error(response.error || '后台命令执行失败'));
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(new Error('后台连接未响应，请稍后重试'));
        }
      } catch (error) { clearInterval(timer); reject(error); }
    }, 150);
  });
}
async function stopWorker() {
  if (!workerIsHealthy()) return;
  try { await requestWorkerCommand('stop', {}, 5000); } catch (error) { writeLog('error', 'worker.stop_failed', { error: serializeError(error) }); }
}
function terminateProcessTree(pid) {
  return new Promise((resolve, reject) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output.trim() || `taskkill 退出码 ${code}`)));
  });
}
async function terminateCurrentTaskTree(commandId = '') {
  if (!app.isPackaged || process.platform !== 'win32') throw new Error('仅 Windows 安装包可结束后台任务');
  const worker = readWorkerState();
  const pid = Number(worker?.pid);
  if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) throw new Error('未找到可结束的后台任务');
  publishStatus({ state: 'stopping', message: '正在结束当前任务及其子进程' });
  writeLog('info', 'worker.task_tree_termination_requested', { pid, taskState: worker?.status?.state || '' });
  try {
    const result = await requestWorkerCommand('cancel-active-task', { commandId, reason: 'ui-or-controller' }, 5000);
    if (result?.cancelled) {
      writeLog('info', 'worker.active_task_cancelled', { pid, commandIds: result.commandIds || [] });
      return result;
    }
    publishStatus({ state: 'online', message: '中继连接正常，等待任务' });
    return result;
  } catch (error) {
    writeLog('error', 'worker.active_task_cancellation_failed', { pid, error: serializeError(error) });
  }
  // A non-responsive Worker cannot cancel its child itself. Restart it as the
  // fallback so the existing emergency recovery path remains available.
  try { await terminateProcessTree(pid); }
  catch (error) { writeLog('error', 'worker.task_tree_termination_failed', { pid, error: serializeError(error) }); throw new Error(`结束任务失败：${error.message}`); }
  try { fs.unlinkSync(workerStatePath()); } catch {}
  workerPid = null;
  setRdpStatus({ state: 'idle', message: '未启动', sessionId: '', host: '', port: 0, username: '', expiresAt: '' });
  await wait(500);
  startWorker();
  publishStatus({ state: 'starting', message: '任务已结束，正在恢复后台连接' });
  writeLog('info', 'worker.task_tree_terminated', { pid });
  return { pid };
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function endpoint(pathname) { return `${config.server}${pathname}`; }
function authHeaders(extra = {}) { return { Authorization: `Bearer ${config.agentToken}`, ...extra }; }
function testRelayConfig(value) {
  const normalized = validateRelayConfig(value);
  const target = new URL(normalized.server + '/health');
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: 'GET',
      rejectUnauthorized: false,
      servername: netSocket.isIP(target.hostname) ? undefined : target.hostname,
    }, (response) => {
      response.resume();
      response.once('end', () => response.statusCode === 200 ? resolve({ ok: true, status: response.statusCode }) : reject(new Error('健康检查失败：HTTP ' + response.statusCode)));
    });
    request.once('socket', (socket) => socket.once('secureConnect', () => {
      try {
        const expected = normalized.certificateFingerprint256.replaceAll(':', '');
        const actual = crypto.createHash('sha256').update(socket.getPeerCertificate(true).raw).digest('hex').toUpperCase();
        if (actual !== expected) throw new Error('中继证书指纹不匹配');
      } catch (error) { request.destroy(error); reject(error); }
    }));
    request.setTimeout(10000, () => request.destroy(new Error('健康检查超时')));
    request.once('error', reject);
    request.end();
  });
}
async function registerDevice() {
  if (String(config.enrollmentToken || '').length < 32) throw new Error('安装包缺少设备注册凭据');
  publishStatus({ state: 'registering', message: '正在注册此电脑' });
  const response = await fetchWithTimeout(endpoint('/v1/agent/register'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.enrollmentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: config.deviceId, agentToken: config.agentToken, hostname: os.hostname(), username: rdpUsername(), platform: process.platform, arch: process.arch, appVersion: app.getVersion(), alias: config.alias || '', lanAddresses: privateIpv4Addresses() }),
  }, 15000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.deviceId !== config.deviceId) throw new Error(`注册失败：HTTP ${response.status}${body.error ? ` ${body.error}` : ''}`);
  writeLog('info', 'device.registered', { deviceId: config.deviceId, registeredAt: body.registeredAt });
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const target = new URL(url);
  const method = options.method || 'GET';
  if (target.protocol !== 'https:') throw new Error('中继服务器必须使用 HTTPS');
  const body = options.body == null ? null : (Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body)));
  const headers = { ...(options.headers || {}) };
  if (body && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) headers['Content-Length'] = String(body.length);
  const routineRequest = /\/v1\/agent\/(?:poll|cancel)$/.test(target.pathname);
  if (!routineRequest) writeLog('debug', 'http.request', { method, url, timeoutMs, transport: 'node-https' });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      writeLog('error', 'http.error', { method, url, transport: 'node-https', error: serializeError(error) });
      reject(error);
    };
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent: false,
      rejectUnauthorized: false,
      servername: netSocket.isIP(target.hostname) ? undefined : target.hostname,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', fail);
      response.once('end', () => {
        if (settled) return;
        settled = true;
        const responseBody = Buffer.concat(chunks);
        const headerValue = (name) => {
          const value = response.headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : (value == null ? null : String(value));
        };
        const result = {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers: { get: headerValue },
          json: async () => JSON.parse(responseBody.toString('utf8')),
          text: async () => responseBody.toString('utf8'),
        };
        if (!routineRequest) writeLog('debug', 'http.response', { method, url, transport: 'node-https', status: result.status, statusText: result.statusText });
        resolve(result);
      });
    });
    request.once('socket', (socket) => socket.once('secureConnect', () => {
      try {
        const expected = String(config.certificateFingerprint256 || '').replaceAll(':', '').toUpperCase();
        const certificate = socket.getPeerCertificate(true);
        const actual = crypto.createHash('sha256').update(certificate.raw).digest('hex').toUpperCase();
        const accepted = Boolean(expected) && actual === expected;
        if (!accepted || !verifiedCertificateHosts.has(target.hostname)) {
          writeLog(accepted ? 'info' : 'error', 'certificate.verify', { hostname: target.hostname, transport: 'node-https', expectedFingerprint256: expected, actualFingerprint256: actual, accepted });
          if (accepted) verifiedCertificateHosts.add(target.hostname);
        }
        if (!accepted) {
          const error = new Error('中继证书指纹不匹配');
          request.destroy(error);
          fail(error);
        }
      } catch (error) { request.destroy(error); fail(error); }
    }));
    request.setTimeout(timeoutMs, () => {
      const error = new Error('请求超时');
      request.destroy(error);
      fail(error);
    });
    request.once('error', fail);
    if (body) request.write(body);
    request.end();
  });
}
async function pollLoop() {
  if (polling) return;
  polling = true;
  writeLog('info', 'poll.loop_started');
  while (!stopRequested && config) {
    try {
      const query = new URLSearchParams({ device_id: config.deviceId, hostname: os.hostname(), workspace_path: selectedWorkspace, device_alias: config.alias || '', lan_addresses: privateIpv4Addresses().join(',') });
      lastPollStartedAt = new Date().toISOString();
      const response = await fetchWithTimeout(endpoint(`/v1/agent/poll?${query}`), { method: 'POST', headers: authHeaders() });
      lastPollCompletedAt = new Date().toISOString();
      const rdpSessionId = response.headers.get('x-rdp-session-id');
      if (rdpSessionId) {
        const rdpSession = { id: rdpSessionId, host: response.headers.get('x-rdp-host') || new URL(config.server).hostname, port: Number(response.headers.get('x-rdp-port')) || 0 };
        openRdpTunnel(rdpSession).catch((error) => {
          writeLog('error', 'rdp.tunnel_failed', { sessionId: rdpSession.id, error: serializeError(error) });
          setRdpStatus({ state: 'error', message: `远程桌面隧道失败：${error.message}`, sessionId: rdpSession.id, host: rdpSession.host, port: rdpSession.port });
        });
      }
      if (response.status === 204) {
        publishStatus({ state: 'online', message: '中继连接正常，等待任务' });
      } else if (response.status === 200) {
        const id = response.headers.get('x-command-id');
        const cwd = Buffer.from(response.headers.get('x-cwd-base64') || '', 'base64').toString('utf8');
        const timeout = Math.max(1, Math.min(3600, Number(response.headers.get('x-timeout-seconds')) || 300));
        publishStatus({ state: 'running', message: `正在执行任务 ${id}` });
        const command = await response.text();
        const result = await execute(command, cwd || selectedWorkspace, timeout, id);
        await fetchWithTimeout(endpoint(`/v1/agent/result/${encodeURIComponent(id)}?device_id=${encodeURIComponent(config.deviceId)}`), {
          method: 'POST', headers: authHeaders({ 'Content-Type': 'application/octet-stream', 'X-Exit-Code': String(result.exitCode), 'X-Timed-Out': String(result.timedOut) }), body: result.output,
        });
      } else if (response.status === 401 || response.status === 403) {
        writeLog('error', 'relay.authentication_rejected', { status: response.status, deviceId: config.deviceId });
        publishStatus({ state: 'error', message: '设备令牌被中继拒绝' });
        await wait(10000);
      } else {
        publishStatus({ state: 'error', message: `中继返回 HTTP ${response.status}` });
        await wait(5000);
      }
    } catch (error) {
      writeLog('error', 'poll.failed', { error: serializeError(error) });
      publishStatus({ state: 'offline', message: `连接失败：${error.name === 'AbortError' ? '请求超时' : error.message}` });
      await wait(5000);
    }
    await wait(2000);
  }
  polling = false;
  writeLog('error', 'poll.loop_stopped', { stopRequested, hasConfig: Boolean(config), lastPollStartedAt, lastPollCompletedAt });
}

async function controlLoop() {
  if (controlPolling) return;
  controlPolling = true;
  writeLog('info', 'control.loop_started');
  while (!stopRequested && config) {
    try {
      const response = await fetchWithTimeout(endpoint(`/v1/agent/cancel?device_id=${encodeURIComponent(config.deviceId)}`), { method: 'GET', headers: authHeaders() }, 15000);
      if (response.status === 200) {
        const cancellation = await response.json();
        if (!/^[a-f0-9-]{36}$/i.test(String(cancellation.id || ''))) throw new Error('中继返回了无效的取消请求');
        writeLog('info', 'control.cancellation_received', { cancellationId: cancellation.id, commandId: cancellation.commandId || '' });
        await terminateCurrentTaskTree(cancellation.commandId || '');
        const acknowledgement = await fetchWithTimeout(endpoint(`/v1/agent/cancel/ack?device_id=${encodeURIComponent(config.deviceId)}`), {
          method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ id: cancellation.id }),
        }, 15000);
        if (!acknowledgement.ok) throw new Error(`取消确认失败：HTTP ${acknowledgement.status}`);
        writeLog('info', 'control.cancellation_acknowledged', { cancellationId: cancellation.id });
      } else if (response.status !== 204) {
        throw new Error(`取消通道返回 HTTP ${response.status}`);
      }
    } catch (error) {
      writeLog('error', 'control.poll_failed', { error: serializeError(error) });
    }
    await wait(2000);
  }
  controlPolling = false;
  writeLog('info', 'control.loop_stopped', { stopRequested, hasConfig: Boolean(config) });
}

function setupDiagnostics() {
  const reportError = (event, error) => writeLog('error', event, { error: serializeError(error instanceof Error ? error : new Error(String(error))) });
  process.on('uncaughtException', (error) => reportError('process.uncaught_exception', error));
  process.on('unhandledRejection', (reason) => reportError('process.unhandled_rejection', reason));
  process.on('warning', (warning) => reportError('process.warning', warning));
  process.on('beforeExit', (code) => writeLog('error', 'process.before_exit', { code }));
  process.on('exit', (code) => writeLog('error', 'process.exit', { code }));
  process.on('SIGTERM', () => { writeLog('error', 'process.signal', { signal: 'SIGTERM' }); app.quit(); });
  process.on('SIGINT', () => { writeLog('error', 'process.signal', { signal: 'SIGINT' }); app.quit(); });
  app.on('child-process-gone', (_, details) => writeLog('error', 'app.child_process_gone', details));
  let expectedAt = Date.now() + 10000;
  setInterval(() => {
    const now = Date.now();
    writeLog('debug', 'agent.watchdog', { eventLoopLagMs: Math.max(0, now - expectedAt), polling, lastPollStartedAt, lastPollCompletedAt, windowVisible: Boolean(window && !window.isDestroyed() && window.isVisible()) });
    expectedAt = now + 10000;
  }, 10000).unref();
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
    const chunks = [];
    let length = 0;
    const append = (chunk) => { if (length >= MAX_OUTPUT) return; const kept = chunk.subarray(0, MAX_OUTPUT - length); chunks.push(kept); length += kept.length; };
    const recordOutput = (stream, chunk) => { const text = Buffer.from(chunk).toString('utf8'); writeLog('info', `command.${stream}`, { commandId, text: text.slice(0, 4096), truncated: text.length > 4096 }); };
    child.stdout.on('data', (chunk) => { append(chunk); recordOutput('stdout', chunk); });
    child.stderr.on('data', (chunk) => { append(Buffer.from(`\r\n[stderr]\r\n`)); append(chunk); recordOutput('stderr', chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutSeconds * 1000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: -1, timedOut, output: Buffer.from(`无法启动 PowerShell：${error.message}`) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: timedOut ? 124 : (code ?? -1), timedOut, output: Buffer.concat(chunks).subarray(0, MAX_OUTPUT) }); });
  });
}
function rdpUsername() { return `${os.hostname()}\\${os.userInfo().username}`; }
function frameClientWebSocket(payload, opcode = 2) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}
function parseRelayWebSocketFrames(state, chunk, onFrame) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    let offset = 2;
    let length = second & 0x7f;
    if (length === 126) {
      if (state.buffer.length < 4) return;
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) return;
      const largeLength = state.buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(8 * 1024 * 1024)) throw new Error('RDP 数据帧过大');
      length = Number(largeLength);
      offset = 10;
    }
    const masked = Boolean(second & 0x80);
    const maskLength = masked ? 4 : 0;
    const total = offset + maskLength + length;
    if (state.buffer.length < total) return;
    const payloadStart = offset + maskLength;
    const payload = Buffer.from(state.buffer.subarray(payloadStart, payloadStart + length));
    if (masked) {
      const mask = state.buffer.subarray(offset, offset + 4);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    state.buffer = state.buffer.subarray(total);
    onFrame(first & 0x0f, payload);
  }
}
function openRdpWebSocket(sessionId) {
  return new Promise((resolve, reject) => {
    const relay = new URL(config.server);
    const expectedFingerprint = String(config.certificateFingerprint256 || '').replaceAll(':', '').toUpperCase();
    const socket = tls.connect({ host: relay.hostname, port: Number(relay.port || 443), servername: netSocket.isIP(relay.hostname) ? undefined : relay.hostname, rejectUnauthorized: false });
    let settled = false;
    let handshakeComplete = false;
    let handshakeBuffer = Buffer.alloc(0);
    const frameState = { buffer: Buffer.alloc(0) };
    const fail = (error) => {
      if (!settled) { settled = true; reject(error); }
      socket.destroy();
    };
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      try {
        const certificate = socket.getPeerCertificate(true);
        const actualFingerprint = crypto.createHash('sha256').update(certificate.raw).digest('hex').toUpperCase();
        if (!expectedFingerprint || actualFingerprint !== expectedFingerprint) throw new Error('RDP 中继证书指纹不匹配');
        const key = crypto.randomBytes(16).toString('base64');
        const requestPath = `${relay.pathname.replace(/\/$/, '')}/v1/agent/rdp?device_id=${encodeURIComponent(config.deviceId)}&session_id=${encodeURIComponent(sessionId)}`;
        socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${relay.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${config.agentToken}\r\n\r\n`);
      } catch (error) { fail(error); }
    });
    const connection = {
      send: (payload, opcode = 2) => socket.write(frameClientWebSocket(payload, opcode)),
      close: () => socket.end(frameClientWebSocket(Buffer.alloc(0), 8)),
      onBinary: null,
      onControl: null,
      controls: [],
      onClose: null,
    };
    socket.on('data', (chunk) => {
      try {
        if (!handshakeComplete) {
          handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
          const boundary = handshakeBuffer.indexOf('\r\n\r\n');
          if (boundary === -1) return;
          const header = handshakeBuffer.subarray(0, boundary).toString('utf8');
          if (!/^HTTP\/1\.1 101\b/m.test(header)) return fail(new Error(`RDP 中继升级失败：${header.split('\r\n')[0]}`));
          handshakeComplete = true;
          chunk = handshakeBuffer.subarray(boundary + 4);
          handshakeBuffer = Buffer.alloc(0);
          if (!settled) { settled = true; resolve(connection); }
        }
        if (chunk.length) parseRelayWebSocketFrames(frameState, chunk, (opcode, payload) => {
          if (opcode === 2 && connection.onBinary) connection.onBinary(payload);
          else if (opcode === 1) {
            const control = JSON.parse(payload.toString('utf8'));
            if (connection.onControl) connection.onControl(control);
            else connection.controls.push(control);
          }
          else if (opcode === 9) connection.send(payload, 10);
          else if (opcode === 8) socket.end();
        });
      } catch (error) { fail(error); }
    });
    socket.on('close', () => { if (connection.onClose) connection.onClose(); if (!settled) fail(new Error('RDP 中继连接已关闭')); });
  });
}
async function openRdpTunnel(session) {
  if (rdpTunnel?.sessionId === session.id) return;
  if (rdpTunnel) rdpTunnel.close();
  keepRdpProcessAwake();
  setRdpStatus({ state: 'waiting', message: '等待远程桌面连接', sessionId: session.id, host: session.host, port: session.port, username: rdpUsername() });
  const relaySocket = await openRdpWebSocket(session.id);
  writeLog('info', 'rdp.tunnel_opened', { sessionId: session.id, host: session.host, port: session.port });
  let localSocket = null;
  let closed = false;
  const tunnel = {
    sessionId: session.id,
    close: () => { closed = true; if (localSocket) localSocket.destroy(); relaySocket.close(); },
  };
  rdpTunnel = tunnel;
  const closeLocalSocket = () => {
    if (!localSocket) return;
    const socket = localSocket;
    localSocket = null;
    socket.destroy();
  };
  const connectLocalRdp = () => {
    if (closed || localSocket || rdpTunnel !== tunnel) return;
    setRdpStatus({ state: 'connecting', message: '正在连接本机远程桌面服务' });
    const socket = netSocket.createConnection({ host: '127.0.0.1', port: 3389 });
    localSocket = socket;
    socket.on('connect', () => {
      if (localSocket !== socket) return;
      writeLog('info', 'rdp.local_connected', { sessionId: session.id, localAddress: socket.localAddress, localPort: socket.localPort });
      setRdpStatus({ state: 'active', message: `远程桌面已就绪：${session.host}:${session.port}` });
    });
    socket.on('data', (chunk) => { if (!closed) relaySocket.send(chunk); });
    socket.on('error', (error) => {
      if (localSocket !== socket) return;
      localSocket = null;
      writeLog('error', 'rdp.local_error', { sessionId: session.id, error: serializeError(error) });
      relaySocket.close();
      if (rdpTunnel === tunnel) { rdpTunnel = null; setRdpStatus({ state: 'error', message: `本机远程桌面不可用：${error.message}` }); }
    });
    socket.on('close', () => {
      if (localSocket === socket) localSocket = null;
      writeLog('debug', 'rdp.local_closed', { sessionId: session.id });
    });
  };
  relaySocket.onBinary = (payload) => { if (localSocket) localSocket.write(payload); };
  relaySocket.onControl = (control) => {
    writeLog('debug', 'rdp.control', { sessionId: session.id, type: control?.type || 'unknown' });
    if (control?.type === 'client-connected') connectLocalRdp();
    if (control?.type === 'client-disconnected') {
      closeLocalSocket();
      if (!closed) setRdpStatus({ state: 'waiting', message: '等待远程桌面重新连接' });
    }
  };
  relaySocket.onClose = () => {
    closed = true;
    writeLog('info', 'rdp.tunnel_closed', { sessionId: session.id });
    closeLocalSocket();
    if (rdpTunnel === tunnel) {
      rdpTunnel = null;
      releaseRdpProcessAwake();
      setRdpStatus({ state: 'closed', message: '远程桌面会话已关闭' });
    }
  };
  for (const control of relaySocket.controls.splice(0)) relaySocket.onControl(control);
}
async function startRdpSession(ttlSeconds) {
  if (!app.isPackaged || process.platform !== 'win32') throw new Error('远程桌面仅在 Windows 安装包中可用');
  const requestedTtl = Number(ttlSeconds) === 0 ? 0 : (Number(ttlSeconds) || 0);
  setRdpStatus({ state: 'requesting', message: '正在分配远程桌面端口', ttlSeconds: requestedTtl });
  const response = await fetchWithTimeout(endpoint(`/v1/agent/rdp/start?device_id=${encodeURIComponent(config.deviceId)}`), {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ username: rdpUsername(), ttlSeconds }),
  }, 15000);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `RDP 会话创建失败：HTTP ${response.status}`);
  setRdpStatus({ state: value.state, message: `端口已分配，正在建立隧道`, sessionId: value.id, host: value.host, port: value.port, username: value.username || rdpUsername(), expiresAt: value.expiresAt, ttlSeconds: requestedTtl });
  await openRdpTunnel({ id: value.id, host: value.host, port: Number(value.port) || 0 });
  return value;
}

// The renderer must still be able to release a stale relay session when the
// detached worker is unavailable. This path only clears the RDP session; it
// does not execute commands or touch the Windows RDP service.
async function stopRdpDirect() {
  const response = await fetchWithTimeout(endpoint(`/v1/agent/rdp/stop?device_id=${encodeURIComponent(config.deviceId)}`), {
    method: 'POST',
    headers: authHeaders(),
  }, 15000);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `RDP 会话关闭失败：HTTP ${response.status}`);
  if (rdpTunnel) rdpTunnel.close();
  rdpTunnel = null;
  releaseRdpProcessAwake();
  setRdpStatus({ state: 'idle', message: '未启动', sessionId: '', host: '', port: 0, username: '', expiresAt: '' });
  writeLog('info', 'rdp.stopped_direct_fallback', { state: value.state || 'idle' });
  return value;
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip('Remote Codex Agent');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开状态', click: openWindow }, { label: '打开日志文件', click: () => shell.showItemInFolder(logPath()) }, { type: 'separator' }, { label: '退出代理', click: () => { stopRequested = true; stopWorker().finally(() => app.quit()); } }]));
  tray.on('double-click', openWindow);
}
function setUpdateStatus(next) {
  updateStatus = { ...updateStatus, ...next, at: new Date().toISOString() };
  if (window && !window.isDestroyed()) window.webContents.send('update-status', updateStatus);
}
function setRdpStatus(next) {
  rdpStatus = { ...rdpStatus, ...next, at: new Date().toISOString() };
  if (window && !window.isDestroyed()) window.webContents.send('rdp-status', rdpStatus);
}
function configureCertificateVerifier(targetSession) {
  targetSession.setCertificateVerifyProc((request, callback) => {
    const expected = String(config.certificateFingerprint256 || '').replaceAll(':', '').toUpperCase();
    let actual = '';
    try {
      actual = crypto.createHash('sha256').update(new crypto.X509Certificate(request.certificate.data).raw).digest('hex').toUpperCase();
    } catch (error) {
      writeLog('error', 'certificate.fingerprint_failed', { error: serializeError(error) });
    }
    const isRelay = request.hostname === new URL(config.server).hostname;
    const accepted = isRelay && Boolean(expected) && expected === actual;
    writeLog(accepted ? 'info' : 'error', 'certificate.verify', { hostname: request.hostname, verificationResult: request.verificationResult, errorCode: request.errorCode, expectedFingerprint256: expected, actualFingerprint256: actual, accepted });
    callback(isRelay ? (accepted ? 0 : -2) : -3);
  });
}
function setupAutoUpdate() {
  if (!app.isPackaged || process.platform !== 'win32') {
    setUpdateStatus({ state: 'unsupported', message: '当前为 macOS 开发预览，更新仅在 Windows 安装包启用' });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.requestHeaders = { Authorization: `Bearer ${config.agentToken}` };
  configureCertificateVerifier(autoUpdater.netSession);
  autoUpdater.setFeedURL({ provider: 'generic', url: `${config.server}/updates/windows` });
  autoUpdater.on('checking-for-update', () => setUpdateStatus({ state: 'checking', message: '正在检查更新' }));
  autoUpdater.on('update-available', (info) => { writeLog('info', 'update.available', { version: info.version }); setUpdateStatus({ state: 'downloading', message: `发现 ${info.version}，正在下载` }); });
  autoUpdater.on('update-not-available', () => setUpdateStatus({ state: 'current', message: `当前已是最新版本 ${app.getVersion()}` }));
  autoUpdater.on('download-progress', (progress) => setUpdateStatus({ state: 'downloading', message: `正在下载更新 ${Math.round(progress.percent)}%` }));
  autoUpdater.on('update-downloaded', (info) => { writeLog('info', 'update.downloaded', { version: info.version }); setUpdateStatus({ state: 'ready', version: info.version, message: `${info.version} 已下载，可以安装` }); });
  autoUpdater.on('error', (error) => { writeLog('error', 'update.failed', { error: serializeError(error) }); setUpdateStatus({ state: 'error', message: `更新失败：${error.message}` }); });
  autoUpdater.checkForUpdates().catch((error) => writeLog('error', 'update.check_failed', { error: serializeError(error) }));
  setInterval(() => autoUpdater.checkForUpdates().catch((error) => writeLog('error', 'update.check_failed', { error: serializeError(error) })), 30 * 60 * 1000).unref();
}
function configureLoginStartup() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const options = { openAtLogin: true, path: process.execPath, args: ['--hidden'] };
  app.setLoginItemSettings(options);
  const settings = app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] });
  writeLog('info', 'startup.configured', {
    openAtLogin: settings.openAtLogin,
    executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin,
    launchItems: settings.launchItems || [],
  });
}
if (isPrimaryInstance) app.whenReady().then(async () => {
  if (process.platform === 'win32') Menu.setApplicationMenu(null);
  if (!await requestAuthorization()) return;
  createTray();
  setupDiagnostics();
  config = readConfig();
  selectedWorkspace = readWorkspace();
  writeLog('info', 'agent.start', { appVersion: app.getVersion(), electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, deviceId: config.deviceId, server: config.server, logPath: logPath() });
  const service = await configureSystemService();
  if (service.relaunch) return;
  try {
    installComputerUseScript();
    if (process.platform === 'win32') enableComputerUse('app-start-default');
    else disableComputerUse('unsupported-platform');
  } catch (error) {
    disableComputerUse('default-enable-failed');
    writeLog('error', 'computer_use.default_enable_failed', { error: serializeError(error), userData: interactiveUserDataPath() });
  }
  ipcMain.handle('get-config', () => ({ deviceId: config.deviceId, status }));
  ipcMain.handle('open-config', () => { openWindow(); });
  configureLoginStartup();
  startMainHeartbeat();
  startWatchdog();
  configureCertificateVerifier(session.defaultSession);
  ipcMain.handle('get-agent-state', () => {
    const worker = readWorkerState();
    return { deviceId: config.deviceId, alias: config.alias || '', relayConfig: publicRelayConfig(), lanAddresses: worker?.lanAddresses || privateIpv4Addresses(), lanPort: worker?.lanPort || 0, status, systemServiceStatus, workspace: selectedWorkspace, updateStatus, rdpStatus, computerUseStatus, appVersion: app.getVersion(), canCheckUpdate: app.isPackaged && process.platform === 'win32', canStartRdp: app.isPackaged && process.platform === 'win32', canUseComputer: process.platform === 'win32' };
  });
  ipcMain.handle('get-relay-config', () => publicRelayConfig());
  ipcMain.handle('load-relay-config-file', (_, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('配置文件路径无效');
    const text = fs.readFileSync(filePath, 'utf8');
    let value;
    try { value = JSON.parse(text); }
    catch {
      value = {};
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*["']?([^"']*)["']?\s*$/i);
        if (match) value[match[1]] = match[2].trim();
      }
      const server = value.server || value.REMOTE_CODEX_SERVER || value.REMOTE_CODEX_PUBLIC_URL || (value.REMOTE_CODEX_PUBLIC_HOST ? `https://${value.REMOTE_CODEX_PUBLIC_HOST}:9443/remote-codex` : '');
      value = { server, enrollmentToken: value.enrollmentToken || value.REMOTE_CODEX_ENROLLMENT_TOKEN, certificateFingerprint256: value.certificateFingerprint256 || value.REMOTE_CODEX_CERTIFICATE_FINGERPRINT256 || value.REMOTE_CODEX_CERT_SHA256 };
    }
    return validateRelayConfig(value);
  });
  ipcMain.handle('export-relay-config', async () => {
    if (!config) throw new Error('尚未配置中转服务器');
    const result = await dialog.showSaveDialog(window, { title: '导出中转配置', defaultPath: 'remote-codex-relay.json', filters: [{ name: 'JSON 配置', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    const value = validateRelayConfig(config);
    fs.writeFileSync(result.filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle('test-relay-config', (_, value) => {
    const source = { ...(value || {}) };
    if (!String(source.enrollmentToken || '').trim()) source.enrollmentToken = config?.enrollmentToken || '';
    return testRelayConfig(source);
  });
  ipcMain.handle('save-relay-config', async (_, value) => {
    const saved = saveRelayConfig(value);
    if (app.isPackaged && process.platform === 'win32') {
      autoUpdater.setFeedURL({ provider: 'generic', url: config.server + '/updates/windows' });
    }
    publishStatus({ state: 'connecting', message: '中继配置已保存，正在重新连接' });
    if (!workerIsHealthy()) startWorker();
    else await requestWorkerCommand('reload-config', {}, 30000);
    return saved;
  });
  ipcMain.handle('set-device-alias', (_, value) => saveDeviceAlias(value));
  ipcMain.handle('set-workspace', (_, value) => saveWorkspace(value));
  ipcMain.handle('set-computer-use-enabled', (_, enabled) => enabled ? enableComputerUse() : disableComputerUse('user'));
  ipcMain.handle('check-update', () => {
    if (!app.isPackaged || process.platform !== 'win32') {
      setUpdateStatus({ state: 'unsupported', message: '当前为 macOS 开发预览，更新仅在 Windows 安装包启用' });
      return false;
    }
    setUpdateStatus({ state: 'checking', message: '正在检查更新' });
    return autoUpdater.checkForUpdates();
  });
  ipcMain.handle('install-update', () => {
    if (updateStatus.state !== 'ready') throw new Error('更新包尚未下载完成');
    writeLog('info', 'update.install_requested', { version: updateStatus.version });
    if (serviceState() !== 'missing') return autoUpdater.quitAndInstall(false, true);
    return stopWorker().finally(() => autoUpdater.quitAndInstall(false, true));
  });
  ipcMain.handle('start-rdp', async (_, ttlSeconds) => {
    if (!workerIsHealthy()) startWorker();
    return requestWorkerCommand('start-rdp', { ttlSeconds }, 30000);
  });
  ipcMain.handle('stop-rdp', async () => {
    try {
      return await requestWorkerCommand('stop-rdp', {}, 30000);
    } catch (error) {
      writeLog('error', 'rdp.worker_stop_failed', { error: serializeError(error), fallback: 'relay-direct' });
      return stopRdpDirect();
    }
  });
  ipcMain.handle('terminate-task-tree', () => terminateCurrentTaskTree());
  ipcMain.handle('get-log', () => readLogTail(logPath()).split('\n').filter(Boolean).slice(-300).join('\n'));
  ipcMain.handle('open-log', () => shell.showItemInFolder(logPath()));
  if (!app.isPackaged && process.platform !== 'win32') {
    publishStatus({ state: 'preview', message: 'macOS 界面预览，不连接中继' });
    setupAutoUpdate();
    openWindow();
    return;
  }
  publishStatus({ state: 'starting', message: '正在启动后台连接' });
  startWorker();
  setupPowerRecovery();
  workerStateTimer = setInterval(refreshWorkerState, 1000);
  interactiveBridge = startInteractiveBridge({ userData: interactiveUserDataPath(), execute, writeLog });
  controlLoop();
  startLogWatcher();
  setupAutoUpdate();
  if (!process.argv.includes('--hidden')) openWindow();
});
app.on('window-all-closed', (event) => event.preventDefault());
app.on('before-quit', () => {
  if (!isPrimaryInstance) return;
  stopRequested = true;
  try { disableComputerUse('app-quit'); } catch {}
  if (workerStateTimer) clearInterval(workerStateTimer);
  if (recoveryTimer) clearTimeout(recoveryTimer);
  if (interactiveBridge) interactiveBridge.close();
  stopMainHeartbeat();
  stopWatchdog();
  fs.unwatchFile(logPath());
  releaseRdpProcessAwake();
});
