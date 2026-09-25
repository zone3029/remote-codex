const status = document.querySelector('#status');
const systemServiceStatus = document.querySelector('#systemServiceStatus');
const log = document.querySelector('#log');
const dropzone = document.querySelector('#dropzone');
const workspace = document.querySelector('#workspace');
const updateStatus = document.querySelector('#updateStatus');
const installUpdate = document.querySelector('#installUpdate');
const rdpStatus = document.querySelector('#rdpStatus');
const rdpInfo = document.querySelector('#rdpInfo');
const rdpAddress = document.querySelector('#rdpAddress');
const rdpUsername = document.querySelector('#rdpUsername');
const rdpExpires = document.querySelector('#rdpExpires');
const startRdp = document.querySelector('#startRdp');
const rdpTtl = document.querySelector('#rdpTtl');
const terminateTask = document.querySelector('#terminateTask');
const taskFilter = document.querySelector('#taskFilter');
const taskSummary = document.querySelector('#taskSummary');
const deviceAlias = document.querySelector('#deviceAlias');
const saveAlias = document.querySelector('#saveAlias');
const aliasHint = document.querySelector('#aliasHint');
const computerUseToggle = document.querySelector('#computerUseToggle');
const computerUseStatus = document.querySelector('#computerUseStatus');
const lanLabel = document.createElement('dt');
const lanAddresses = document.createElement('dd');
lanLabel.textContent = '局域网直连';
lanAddresses.id = 'lanAddresses';
document.querySelector('#deviceId').after(lanLabel, lanAddresses);
let currentRdp = { state: 'idle', sessionId: '' };
let taskEntries = [];
function isTaskLog(entry) { return /^command\./.test(String(entry?.event || '')) || /^worker\.(active_task|task_tree)/.test(String(entry?.event || '')); }
function commandId(entry) { return String(entry?.commandId || ''); }
function shortCommandId(id) { return id ? id.slice(0, 8) : ''; }
function formatTaskEntry(entry) {
  const event = String(entry?.event || '');
  const time = entry?.time ? new Date(entry.time).toLocaleTimeString() : '--:--:--';
  if (event === 'command.stdout' || event === 'command.stderr') {
    const stream = event.endsWith('stderr') ? 'stderr' : 'stdout';
    return `[${time}] [${stream}] ${String(entry.text || '').replace(/\r?\n$/, '')}`;
  }
  if (event === 'command.execution_started') return `[${time}] 开始执行 | 工作目录: ${entry.cwd || '(默认)'} | 超时: ${entry.timeoutSeconds || '-'} 秒`;
  if (event === 'command.start') return `[${time}] PowerShell 已启动 | 工作目录: ${entry.cwd || '(默认)'}`;
  if (event === 'command.execution_finished') return `[${time}] 执行结束 | 退出码: ${entry.exitCode} | ${entry.cancelled ? '已取消' : entry.timedOut ? '已超时' : entry.exitCode === 0 ? '成功' : '失败'}`;
  if (event === 'command.execution_failed') return `[${time}] 执行回传失败 | ${entry.error?.message || entry.error || '未知错误'}`;
  if (event === 'command.cancellation_requested') return `[${time}] 已请求结束任务树`;
  return `[${time}] ${JSON.stringify(entry)}`;
}
function taskStatus(entries) {
  const latest = entries[entries.length - 1] || {};
  if (latest.event === 'command.execution_finished') return latest.exitCode === 0 ? '已完成' : '失败';
  if (latest.event === 'command.execution_failed') return '回传失败';
  return '运行中';
}
function renderTaskFilter() {
  const ids = [...new Set(taskEntries.map(commandId).filter(Boolean))];
  const selected = taskFilter.value;
  taskFilter.replaceChildren(new Option('全部任务', ''));
  for (const id of ids) taskFilter.appendChild(new Option(`${shortCommandId(id)} · ${taskStatus(taskEntries.filter((entry) => commandId(entry) === id))}`, id));
  taskFilter.value = ids.includes(selected) ? selected : '';
}
function renderTaskLog(scroll = true) {
  renderTaskFilter();
  const selected = taskFilter.value;
  const visible = selected ? taskEntries.filter((entry) => commandId(entry) === selected) : taskEntries;
  log.textContent = visible.length ? visible.map(formatTaskEntry).join('\n') : '暂无任务日志';
  if (selected) {
    const selectedEntries = taskEntries.filter((entry) => commandId(entry) === selected);
    taskSummary.textContent = `${shortCommandId(selected)} · ${taskStatus(selectedEntries)} · ${selectedEntries.length} 条日志`;
  } else taskSummary.textContent = taskEntries.length ? `${new Set(taskEntries.map(commandId).filter(Boolean)).size} 个任务 · ${taskEntries.length} 条日志` : '暂无任务日志';
  if (scroll) log.scrollTop = log.scrollHeight;
}
function appendTaskLog(entry) { if (!isTaskLog(entry)) return; taskEntries.push(entry); if (taskEntries.length > 500) taskEntries.splice(0, taskEntries.length - 500); renderTaskLog(); }
function renderStatus(value) { status.textContent = value.message; terminateTask.classList.toggle('hidden', value.state !== 'running'); terminateTask.disabled = value.state === 'stopping'; }
function hasActiveRdp(value) { return Boolean(value?.sessionId) && !['idle', 'closed', 'error'].includes(value.state); }
function renderUpdate(value) { updateStatus.textContent = value.message; const visible = ['downloading', 'ready'].includes(value.state); installUpdate.classList.toggle('hidden', !visible); installUpdate.disabled = value.state !== 'ready'; installUpdate.textContent = value.state === 'ready' ? '安装新版本' : '正在下载更新'; }
function renderRdp(value) { currentRdp = value || currentRdp; rdpStatus.textContent = currentRdp.message; const active = hasActiveRdp(currentRdp); startRdp.textContent = active ? '关闭远程桌面' : '启动远程桌面'; startRdp.disabled = ['requesting', 'stopping'].includes(currentRdp.state); rdpTtl.disabled = active; const ready = currentRdp.host && currentRdp.port; rdpInfo.classList.toggle('hidden', !ready); if (ready) { rdpAddress.textContent = `${currentRdp.host}:${currentRdp.port}`; rdpUsername.textContent = currentRdp.username || '当前 Windows 用户'; rdpExpires.textContent = currentRdp.expiresAt ? new Date(currentRdp.expiresAt).toLocaleString() : (currentRdp.ttlSeconds === 0 ? '永不失效' : '连接关闭时'); } }
function renderComputerUse(value) { const enabled = Boolean(value?.enabled); computerUseToggle.checked = enabled; computerUseStatus.textContent = value?.message || (enabled ? '已授权' : '未授权'); computerUseStatus.classList.toggle('enabled', enabled); }
window.remoteCodex.getAgentState().then((state) => { document.querySelector('#deviceId').textContent = state.deviceId; lanAddresses.textContent = state.lanAddresses?.length && state.lanPort ? `任务、文件与界面控制：${state.lanAddresses.map((address) => `${address}:${state.lanPort}`).join('，')}（同网段自动优先）` : '局域网直连尚未就绪，将使用公网中继'; deviceAlias.value = state.alias || ''; systemServiceStatus.textContent = state.systemServiceStatus?.message || '系统服务状态未知'; systemServiceStatus.className = `status ${state.systemServiceStatus?.state === 'running' ? 'online' : 'error'}`; renderStatus(state.status); workspace.textContent = state.workspace || '尚未选择文件夹'; renderUpdate(state.updateStatus); renderRdp(state.rdpStatus); renderComputerUse(state.computerUseStatus); document.querySelector('#version').textContent = `v${state.appVersion}`; document.querySelector('#checkUpdate').disabled = !state.canCheckUpdate; document.querySelector('#startRdp').disabled = !state.canStartRdp; computerUseToggle.disabled = !state.canUseComputer; });
window.remoteCodex.onStatus(renderStatus);
window.remoteCodex.getLog().then((value) => { taskEntries = String(value || '').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(isTaskLog).slice(-500); renderTaskLog(); });
window.remoteCodex.onLog(appendTaskLog);
taskFilter.addEventListener('change', () => renderTaskLog(false));
document.querySelector('#openLog').addEventListener('click', () => window.remoteCodex.openLog());
for (const event of ['dragenter', 'dragover']) dropzone.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) dropzone.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.remove('dragging'); });
dropzone.addEventListener('drop', async (event) => { const file = event.dataTransfer.files[0]; if (!file) return; try { workspace.textContent = await window.remoteCodex.setWorkspace(window.remoteCodex.getPathForFile(file)); } catch (error) { workspace.textContent = `选择失败：${error.message}`; } });
window.remoteCodex.onWorkspace((value) => { workspace.textContent = value; });
window.remoteCodex.onUpdateStatus(renderUpdate);
window.remoteCodex.onRdpStatus(renderRdp);
window.remoteCodex.onComputerUseStatus(renderComputerUse);
async function saveDeviceAlias() {
  try {
    saveAlias.disabled = true;
    const alias = await window.remoteCodex.setDeviceAlias(deviceAlias.value);
    deviceAlias.value = alias;
    aliasHint.textContent = alias ? '已保存，将在几秒内同步' : '已清空别称';
  } catch (error) { aliasHint.textContent = `保存失败：${error.message}`; }
  finally { saveAlias.disabled = false; }
}
saveAlias.addEventListener('click', saveDeviceAlias);
deviceAlias.addEventListener('keydown', (event) => { if (event.key === 'Enter') saveDeviceAlias(); });
document.querySelector('#checkUpdate').addEventListener('click', () => window.remoteCodex.checkUpdate());
installUpdate.addEventListener('click', () => window.remoteCodex.installUpdate());
startRdp.addEventListener('click', async () => {
  try {
    startRdp.disabled = true;
    if (hasActiveRdp(currentRdp)) await window.remoteCodex.stopRdp();
    else await window.remoteCodex.startRdp(rdpTtl.value);
  } catch (error) { rdpStatus.textContent = `${hasActiveRdp(currentRdp) ? '关闭' : '启动'}失败：${error.message}`; }
  finally { if (!['requesting', 'stopping'].includes(currentRdp.state)) startRdp.disabled = false; }
});
computerUseToggle.addEventListener('change', async () => {
  const requested = computerUseToggle.checked;
  try { computerUseToggle.disabled = true; renderComputerUse(await window.remoteCodex.setComputerUseEnabled(requested)); }
  catch (error) { computerUseToggle.checked = !requested; computerUseStatus.textContent = `设置失败：${error.message}`; }
  finally { computerUseToggle.disabled = false; }
});
terminateTask.addEventListener('click', async () => {
  try { terminateTask.disabled = true; await window.remoteCodex.terminateTaskTree(); }
  catch (error) { status.textContent = `结束任务失败：${error.message}`; terminateTask.disabled = false; }
});

const relayButton = document.createElement('button');
relayButton.id = 'openRelayConfig';
relayButton.textContent = '中转服务器';
relayButton.title = '修改中转服务器';
document.querySelector('.title-row .version').before(relayButton);
const relayModal = document.createElement('dialog');
relayModal.className = 'relay-modal';
relayModal.innerHTML = '<form method="dialog"><h2>中转服务器</h2><p class="section-note">导入管理员提供的配置文件，软件会自动读取并连接。</p><label>配置文件<input id="relayFile" type="file" accept=".json,.env,.txt" required></label><p class="section-note">支持 JSON 或 relay.env 文件，文件仅在本机读取，不会上传。</p><p id="relayHint" class="relay-hint"></p><div class="relay-actions"><button type="button" id="exportRelay">导出配置</button><button value="cancel">取消</button><button type="button" id="testRelay">测试连接</button><button type="submit" id="saveRelay" class="primary">保存并重新连接</button></div></form>';
document.body.append(relayModal);
const relayFile = relayModal.querySelector('#relayFile');
const relayHint = relayModal.querySelector('#relayHint');
const testRelay = relayModal.querySelector('#testRelay');
const saveRelay = relayModal.querySelector('#saveRelay');
const exportRelay = relayModal.querySelector('#exportRelay');
let relayDraft = null;
function showRelayHint(message, error = false) { relayHint.textContent = message; relayHint.classList.toggle('error', error); }
async function loadRelayForm() {
  const value = await window.remoteCodex.getRelayConfig();
  relayFile.value = '';
  relayDraft = value.server && value.certificateFingerprint256 ? value : null;
  showRelayHint(value.enrollmentTokenConfigured ? '当前配置已保存在软件内，可直接测试或重新连接；需要更换时再导入新文件。' : '尚未保存配置，请选择配置文件。');
}
relayButton.addEventListener('click', async () => { try { await loadRelayForm(); relayModal.showModal(); } catch (error) { showRelayHint(error.message, true); } });
relayModal.addEventListener('close', () => { relayDraft = null; relayFile.value = ''; });
exportRelay.addEventListener('click', async () => { try { const result = await window.remoteCodex.exportRelayConfig(); if (!result.canceled) showRelayHint('配置已导出。'); } catch (error) { showRelayHint(error.message, true); } });
relayFile.addEventListener('change', async () => {
  const file = relayFile.files[0];
  if (!file) return;
  try {
    relayDraft = await window.remoteCodex.loadRelayConfigFile(window.remoteCodex.getPathForFile(file));
    showRelayHint(`已读取 ${file.name}。保存后配置会存入软件，不再依赖此文件。`);
  } catch (error) {
    relayDraft = null;
    showRelayHint(error.message, true);
  }
});
function currentRelayDraft() { if (!relayDraft) throw new Error('尚未保存配置，请先选择配置文件'); return relayDraft; }
testRelay.addEventListener('click', async () => {
  try {
    testRelay.disabled = true;
    showRelayHint('正在检查服务器和证书...');
    await window.remoteCodex.testRelayConfig(currentRelayDraft());
    showRelayHint('连接正常，证书指纹匹配。');
  } catch (error) { showRelayHint(error.message, true); }
  finally { testRelay.disabled = false; }
});
saveRelay.addEventListener('click', async (event) => {
  event.preventDefault();
  try {
    saveRelay.disabled = true;
    showRelayHint('正在保存并重新连接...');
    relayDraft = await window.remoteCodex.saveRelayConfig(currentRelayDraft());
    relayModal.close();
  } catch (error) { showRelayHint(error.message, true); }
  finally { saveRelay.disabled = false; }
});
