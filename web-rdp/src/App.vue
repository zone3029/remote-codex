<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import Guacamole from 'guacamole-common-js';

const apiBase = '/remote-codex/web-rdp/api';
const loginPassword = ref('');
const authenticated = ref(false);
const devices = ref([]);
const selectedDevice = ref('');
const windowsUsername = ref('');
const windowsPassword = ref('');
const ttlSeconds = ref(43200);
const busy = ref(false);
const message = ref('');
const error = ref('');
const display = ref(null);
const connected = ref(false);
const connectionId = ref('');
const activeDevice = ref('');
const sidebarCollapsed = ref(false);
const desktopReady = ref(false);
let client;
let tunnel;
let keyboard;
let mouse;
let displayResizeObserver;

const selected = computed(() => devices.value.find((device) => device.id === selectedDevice.value));

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

async function refreshDevices() {
  const body = await request('/devices');
  devices.value = body.devices;
  if (!selectedDevice.value && body.devices.length) chooseDevice(body.devices[0]);
}

function chooseDevice(device) {
  selectedDevice.value = device.id;
  windowsUsername.value = device.username || '';
}

async function login() {
  busy.value = true;
  error.value = '';
  try {
    await request('/login', { method: 'POST', body: JSON.stringify({ password: loginPassword.value }) });
    authenticated.value = true;
    loginPassword.value = '';
    await refreshDevices();
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = false;
  }
}

function clearDisplay() {
  for (const keysym of Object.keys(keyboard?.pressed || {})) keyboard.release(Number(keysym));
  keyboard = undefined;
  mouse = undefined;
  displayResizeObserver?.disconnect();
  displayResizeObserver = undefined;
  client = undefined;
  tunnel = undefined;
  desktopReady.value = false;
  if (display.value) display.value.replaceChildren();
}

function sendDisplaySize() {
  if (!client || !display.value) return;
  const width = Math.max(800, Math.floor(display.value.clientWidth));
  const height = Math.max(600, Math.floor(display.value.clientHeight));
  client.sendSize(width, height);
}

function watchDisplaySize() {
  displayResizeObserver?.disconnect();
  displayResizeObserver = new ResizeObserver(() => sendDisplaySize());
  displayResizeObserver.observe(display.value);
  requestAnimationFrame(sendDisplaySize);
}

async function connect() {
  if (!selectedDevice.value || !windowsUsername.value || !windowsPassword.value) {
    error.value = '请填写设备、Windows 用户名和密码。';
    return;
  }
  busy.value = true;
  error.value = '';
  message.value = '正在建立远程桌面会话';
  try {
    const result = await request('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: selectedDevice.value,
        username: windowsUsername.value,
        password: windowsPassword.value,
        ttlSeconds: Number(ttlSeconds.value),
      }),
    });
    windowsPassword.value = '';
    connectionId.value = result.id;
    activeDevice.value = result.deviceName || selected.value?.hostname || selectedDevice.value;
    desktopReady.value = false;
    await nextTick();
    clearDisplay();
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    tunnel = new Guacamole.WebSocketTunnel(`${scheme}://${window.location.host}${result.websocketPath}`);
    client = new Guacamole.Client(tunnel);
    client.onstatechange = (state) => {
      if (state === 3) {
        connected.value = true;
        message.value = `已连接到 ${activeDevice.value}`;
        requestAnimationFrame(sendDisplaySize);
      }
      if (state === 5) {
        connected.value = false;
        desktopReady.value = false;
        message.value = '远程桌面已断开';
      }
    };
    client.onsync = () => { desktopReady.value = true; };
    client.onerror = (status) => { error.value = status?.message || '远程桌面连接失败'; };
    display.value.appendChild(client.getDisplay().getElement());
    watchDisplaySize();
    keyboard = new Guacamole.Keyboard(document);
    keyboard.onkeydown = (keysym) => client.sendKeyEvent(1, keysym);
    keyboard.onkeyup = (keysym) => client.sendKeyEvent(0, keysym);
    mouse = new Guacamole.Mouse(client.getDisplay().getElement());
    mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state) => client.sendMouseState(state);
    client.connect();
  } catch (cause) {
    error.value = cause.message;
    message.value = '';
  } finally {
    busy.value = false;
  }
}

async function disconnect() {
  const id = connectionId.value;
  client?.disconnect();
  clearDisplay();
  connected.value = false;
  connectionId.value = '';
  if (id) await request(`/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  message.value = '远程桌面已关闭';
}

async function logout() {
  if (connected.value) await disconnect();
  await request('/logout', { method: 'POST' }).catch(() => {});
  authenticated.value = false;
  devices.value = [];
}

onBeforeUnmount(() => { client?.disconnect(); });
</script>

<template>
  <main class="app-shell">
    <section v-if="!authenticated" class="login-panel">
      <div class="brand-mark">RC</div>
      <h1>Remote Codex</h1>
      <p>网页远程桌面</p>
      <form @submit.prevent="login">
        <label>访问口令<input v-model="loginPassword" type="password" autocomplete="current-password" autofocus /></label>
        <button :disabled="busy">进入控制台</button>
      </form>
      <small v-if="error" class="error">{{ error }}</small>
    </section>

    <template v-else>
      <header class="topbar">
        <div><strong>Remote Codex</strong><span>网页远程桌面</span></div>
        <div class="topbar-actions"><button class="icon-button" :title="sidebarCollapsed ? '展开设备栏' : '收起设备栏'" :aria-expanded="!sidebarCollapsed" @click="sidebarCollapsed = !sidebarCollapsed">☰</button><button class="icon-button" title="刷新设备" @click="refreshDevices">↻</button><button class="text-button" @click="logout">退出</button></div>
      </header>
      <div class="workspace" :class="{ collapsed: sidebarCollapsed }">
        <aside class="sidebar" :aria-hidden="sidebarCollapsed">
          <div class="section-label">设备</div>
          <button v-for="device in devices" :key="device.id" class="device" :class="{ selected: device.id === selectedDevice }" @click="chooseDevice(device)">
            <span class="status" :class="{ online: device.online }"></span><span><b>{{ device.hostname || device.id }}</b><small>{{ device.id }}</small></span>
          </button>
          <p v-if="!devices.length" class="muted">没有已注册设备</p>
        </aside>
        <section class="desktop-area">
          <div v-if="!connected" class="connection-panel">
            <h2>连接 Windows</h2>
            <p>{{ selected?.hostname || '请选择设备' }}</p>
            <label>Windows 用户名<input v-model="windowsUsername" placeholder="DESKTOP-XXXX\username" autocomplete="username" /></label>
            <label>Windows 密码<input v-model="windowsPassword" type="password" autocomplete="current-password" /></label>
            <label>会话时长<select v-model="ttlSeconds"><option :value="3600">1 小时</option><option :value="43200">12 小时</option><option :value="86400">24 小时</option><option :value="0">永不失效</option></select></label>
            <button class="primary" :disabled="busy || !selectedDevice" @click="connect">{{ busy ? '正在连接' : '连接远程桌面' }}</button>
            <small v-if="message" class="message">{{ message }}</small><small v-if="error" class="error">{{ error }}</small>
          </div>
          <div v-else class="remote-toolbar"><span><i></i>{{ activeDevice }}</span><span>{{ message }}</span><button class="danger" @click="disconnect">断开连接</button></div>
          <div ref="display" class="remote-display" :class="{ active: connected }"><span v-if="connected && !desktopReady" class="stream-status">正在接收桌面画面</span></div>
        </section>
      </div>
    </template>
  </main>
</template>
