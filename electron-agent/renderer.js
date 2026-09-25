const status = document.querySelector('#status');
const log = document.querySelector('#log');
const dropzone = document.querySelector('#dropzone');
const workspace = document.querySelector('#workspace');
const updateStatus = document.querySelector('#updateStatus');
const installUpdate = document.querySelector('#installUpdate');
function renderUpdate(value) { updateStatus.textContent = value.message; const visible = ['downloading', 'ready'].includes(value.state); installUpdate.classList.toggle('hidden', !visible); installUpdate.disabled = value.state !== 'ready'; installUpdate.textContent = value.state === 'ready' ? '安装新版本' : '正在下载更新'; }
window.remoteCodex.getAgentState().then((state) => { document.querySelector('#deviceId').textContent = state.deviceId; status.textContent = state.status.message; workspace.textContent = state.workspace || '尚未选择文件夹'; renderUpdate(state.updateStatus); document.querySelector('#version').textContent = `v${state.appVersion}`; });
window.remoteCodex.onStatus((value) => { status.textContent = value.message; });
window.remoteCodex.getLog().then((value) => { log.textContent = value || '暂无日志'; log.scrollTop = log.scrollHeight; });
window.remoteCodex.onLog((entry) => { log.textContent += `${log.textContent ? '\n' : ''}${JSON.stringify(entry)}`; log.scrollTop = log.scrollHeight; });
document.querySelector('#openLog').addEventListener('click', () => window.remoteCodex.openLog());
for (const event of ['dragenter', 'dragover']) dropzone.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) dropzone.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.remove('dragging'); });
dropzone.addEventListener('drop', async (event) => { const file = event.dataTransfer.files[0]; if (!file) return; try { workspace.textContent = await window.remoteCodex.setWorkspace(window.remoteCodex.getPathForFile(file)); } catch (error) { workspace.textContent = `选择失败：${error.message}`; } });
window.remoteCodex.onWorkspace((value) => { workspace.textContent = value; });
window.remoteCodex.onUpdateStatus(renderUpdate);
document.querySelector('#checkUpdate').addEventListener('click', () => window.remoteCodex.checkUpdate());
installUpdate.addEventListener('click', () => window.remoteCodex.installUpdate());
