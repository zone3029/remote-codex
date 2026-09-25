const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SERVICE_ID = 'RemoteCodexAgentService';
const SERVICE_NAME = 'Remote Codex Agent Service';
const AUTHORIZATION_VERSION = 2;

function sharedUserDataPath(environment = process.env) {
  const root = environment.PROGRAMDATA || environment.ProgramData || 'C:\\ProgramData';
  return path.win32.join(root, 'Remote Codex Agent');
}

function authorizationIsCurrent(directory) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, 'authorization.json'), 'utf8'));
    return value.accepted === true && Number(value.version) >= AUTHORIZATION_VERSION;
  } catch { return false; }
}

function sharedDataIsReady(directory) {
  try {
    const identity = JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8'));
    return authorizationIsCurrent(directory)
      && /^[a-z0-9][a-z0-9-]{7,63}$/.test(identity.deviceId)
      && /^[a-f0-9]{64}$/i.test(identity.agentToken);
  } catch { return false; }
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildServiceXml({ executable, appRoot, userData }) {
  const workingDirectory = path.win32.dirname(appRoot);
  return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>${SERVICE_ID}</id>
  <name>${SERVICE_NAME}</name>
  <description>在 Windows 登录前维持 Remote Codex 的授权连接、任务与文件传输。</description>
  <executable>${xmlEscape(executable)}</executable>
  <argument>${xmlEscape(path.win32.join(appRoot, 'service-host.js'))}</argument>
  <workingdirectory>${xmlEscape(workingDirectory)}</workingdirectory>
  <env name="ELECTRON_RUN_AS_NODE" value="1" />
  <env name="REMOTE_CODEX_USER_DATA" value="${xmlEscape(userData)}" />
  <env name="REMOTE_CODEX_APP_ROOT" value="${xmlEscape(appRoot)}" />
  <logpath>${xmlEscape(path.win32.join(userData, 'service-logs'))}</logpath>
  <logmode>rotate</logmode>
  <stoptimeout>20sec</stoptimeout>
</service>
`;
}

function serviceState() {
  if (process.platform !== 'win32') return 'unsupported';
  const result = spawnSync('sc.exe', ['query', SERVICE_ID], { encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0) return /1060|does not exist|不存在/i.test(output) ? 'missing' : 'unknown';
  if (/STATE\s*:\s*4\s+RUNNING/i.test(output)) return 'running';
  if (/STATE\s*:\s*2\s+START_PENDING/i.test(output)) return 'starting';
  if (/STATE\s*:\s*3\s+STOP_PENDING/i.test(output)) return 'stopping';
  return 'stopped';
}

function powershellQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function buildInstallScript({ wrapperSource, wrapperConfigSource, xmlSource, serviceDirectory, dataDirectory, sourceDataDirectory, userSid, resultPath }) {
  const copyNames = ['identity.json', 'authorization.json', 'workspace.json', 'operation-history.json', 'agent.log'];
  const copies = copyNames.map((name) => `Copy-IfMissing ${powershellQuote(path.join(sourceDataDirectory, name))} ${powershellQuote(path.join(dataDirectory, name))}`).join('\n  ');
  const serviceExe = path.join(serviceDirectory, `${SERVICE_ID}.exe`);
  const serviceConfig = `${serviceExe}.config`;
  const serviceXml = path.join(serviceDirectory, `${SERVICE_ID}.xml`);
  return `$ErrorActionPreference = 'Stop'
$resultPath = ${powershellQuote(resultPath)}
try {
  function Copy-IfMissing([string]$Source, [string]$Destination) {
    if ((Test-Path -LiteralPath $Source -PathType Leaf) -and -not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
      Copy-Item -LiteralPath $Source -Destination $Destination -Force
    }
  }
  function Repair-DataAcl([string]$Root) {
    & icacls.exe $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ${powershellQuote(`*${userSid}:(OI)(CI)M`)} | Out-Null
    if ($LASTEXITCODE -gt 1) { throw "无法设置共享数据根目录权限，退出码 $LASTEXITCODE" }
    $children = Join-Path $Root '*'
    if (Test-Path -Path $children) {
      & icacls.exe $children /inheritance:e /T /C | Out-Null
      if ($LASTEXITCODE -gt 1) { throw "无法修复共享数据子项权限，退出码 $LASTEXITCODE" }
    }
  }
  New-Item -ItemType Directory -Path ${powershellQuote(dataDirectory)} -Force | Out-Null
  New-Item -ItemType Directory -Path ${powershellQuote(path.join(dataDirectory, 'service-logs'))} -Force | Out-Null
  New-Item -ItemType Directory -Path ${powershellQuote(serviceDirectory)} -Force | Out-Null
  Repair-DataAcl ${powershellQuote(dataDirectory)}
  ${copies}
  Remove-Item -LiteralPath ${powershellQuote(path.join(dataDirectory, 'computer-use-consent.json'))} -Force -ErrorAction SilentlyContinue

  $existing = Get-Service -Name ${powershellQuote(SERVICE_ID)} -ErrorAction SilentlyContinue
  if ($existing -and $existing.Status -ne 'Stopped') {
    Stop-Service -Name ${powershellQuote(SERVICE_ID)} -Force
    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(25))
  }

  Copy-Item -LiteralPath ${powershellQuote(wrapperSource)} -Destination ${powershellQuote(serviceExe)} -Force
  Copy-Item -LiteralPath ${powershellQuote(wrapperConfigSource)} -Destination ${powershellQuote(serviceConfig)} -Force
  Copy-Item -LiteralPath ${powershellQuote(xmlSource)} -Destination ${powershellQuote(serviceXml)} -Force

  if (-not $existing) {
    & ${powershellQuote(serviceExe)} install | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "服务安装失败，退出码 $LASTEXITCODE" }
  }
  & sc.exe config ${SERVICE_ID} start= delayed-auto | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "无法设置服务启动类型，退出码 $LASTEXITCODE" }
  & sc.exe failure ${SERVICE_ID} reset= 86400 actions= restart/5000/restart/15000/restart/30000 | Out-Null
  & sc.exe failureflag ${SERVICE_ID} 1 | Out-Null

  Start-Service -Name ${powershellQuote(SERVICE_ID)}
  (Get-Service -Name ${powershellQuote(SERVICE_ID)}).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  @{ ok = $true; service = ${powershellQuote(SERVICE_ID)}; state = 'running' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
  exit 0
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
  exit 1
}
`;
}

function currentUserSid() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true });
  const sid = String(result.stdout || '').trim();
  if (result.status !== 0 || !/^S-1-5-(?:\d+-)+\d+$/.test(sid)) throw new Error('无法读取当前 Windows 用户 SID');
  return sid;
}

function runElevatedScript(script) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-service-'));
  const scriptPath = path.join(directory, 'install-service.ps1');
  const resultPath = path.join(directory, 'result.json');
  fs.writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script.replaceAll('__RESULT_PATH__', resultPath), 'utf8')]));
  const command = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath.replaceAll("'", "''")}"'; exit $p.ExitCode`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      try {
        const value = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''));
        fs.rmSync(directory, { recursive: true, force: true });
        if (!value.ok) reject(new Error(value.error || '系统服务安装失败'));
        else resolve(value);
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        reject(new Error(code === 1223 ? '用户取消了系统服务授权' : (errors.trim() || error.message || `服务安装进程退出码 ${code}`)));
      }
    });
  });
}

async function ensureWindowsService({ resourcesPath, executable, appRoot, sourceDataDirectory, dataDirectory = sharedUserDataPath() }) {
  if (process.platform !== 'win32') return { state: 'unsupported', migrated: false };
  const existingState = serviceState();
  if (existingState === 'running' && sharedDataIsReady(dataDirectory)) return { state: 'running', migrated: sourceDataDirectory !== dataDirectory };

  const wrapperSource = path.join(resourcesPath, 'service', `${SERVICE_ID}.exe`);
  const wrapperConfigSource = `${wrapperSource}.config`;
  if (!fs.existsSync(wrapperSource) || !fs.existsSync(wrapperConfigSource)) throw new Error('安装包缺少 Windows 服务组件');
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-service-config-'));
  const xmlSource = path.join(temporaryDirectory, `${SERVICE_ID}.xml`);
  fs.writeFileSync(xmlSource, buildServiceXml({ executable, appRoot, userData: dataDirectory }));
  const serviceDirectory = path.join(dataDirectory, 'service');
  const script = buildInstallScript({ wrapperSource, wrapperConfigSource, xmlSource, serviceDirectory, dataDirectory, sourceDataDirectory, userSid: currentUserSid(), resultPath: '__RESULT_PATH__' });
  try {
    const result = await runElevatedScript(script);
    return { ...result, migrated: sourceDataDirectory !== dataDirectory, dataDirectory };
  } finally { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); }
}

module.exports = {
  AUTHORIZATION_VERSION,
  SERVICE_ID,
  authorizationIsCurrent,
  buildInstallScript,
  buildServiceXml,
  ensureWindowsService,
  serviceState,
  sharedDataIsReady,
  sharedUserDataPath,
  xmlEscape,
};
