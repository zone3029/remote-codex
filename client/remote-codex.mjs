#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const args = process.argv.slice(2);
const action = args.shift();
const configPath = process.env.REMOTE_CODEX_CONFIG
  || path.join(os.homedir(), ".config", "remote-codex", "config.json");

function fail(message) {
  console.error(`remote-codex: ${message}`);
  process.exit(1);
}

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function probeRdp(host, timeoutMs = 700) {
  const negotiation = Buffer.from("030000130ee000000000000100080003000000", "hex");
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: 3389 });
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (available) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.write(negotiation));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 6) return;
      const packetLength = received.readUInt16BE(2);
      if (received[0] === 3 && received[1] === 0 && packetLength >= 11 && received[5] === 0xd0) finish(true);
      else if (received.length >= packetLength) finish(false);
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

function ipv4Number(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function isOnLocalSubnet(address) {
  const target = ipv4Number(address);
  if (target == null) return false;
  return Object.values(os.networkInterfaces()).flat().some((entry) => {
    const family = typeof entry?.family === "string" ? entry.family : (entry?.family === 4 ? "IPv4" : String(entry?.family));
    const local = ipv4Number(entry?.address);
    const mask = ipv4Number(entry?.netmask);
    return family === "IPv4" && !entry.internal && local != null && mask != null && (local & mask) === (target & mask);
  });
}

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config.server || !config.controllerToken) throw new Error("missing server or controllerToken");
    return { ...config, server: config.server.replace(/\/$/, "") };
  } catch (error) {
    fail(`cannot load ${configPath}: ${error.message}`);
  }
}

async function request(config, pathname, init = {}) {
  const response = await fetch(`${config.server}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.controllerToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) fail(`HTTP ${response.status}: ${value.error || "request failed"}`);
  return value;
}

async function main() {
  if (!["devices", "exec", "rdp", "cancel"].includes(action)) {
    fail("usage: remote-codex devices | exec --device ID [--cwd PATH] [--timeout SECONDS] -- COMMAND | rdp --device ID [--ttl SECONDS] | cancel --command ID");
  }
  const config = loadConfig();
  if (action === "devices") {
    const { devices } = await request(config, "/v1/devices");
    for (const device of devices) {
      console.log(`${device.id}\t${device.online ? "online" : "offline"}\t${device.hostname}\t${device.workspacePath || "(no workspace)"}\tlast_rdp=${device.lastRdpConnectedAt || "never"}\tlast_seen=${device.lastSeenAt}`);
    }
    return;
  }

  if (action === "rdp") {
    const deviceId = option("--device", config.defaultDevice);
    const ttlSeconds = Number(option("--ttl", "43200"));
    if (!deviceId) fail("--device is required when defaultDevice is not configured");
    const { devices } = await request(config, "/v1/devices");
    const device = devices.find((item) => item.id === deviceId);
    if (!device) fail(`unknown device: ${deviceId}`);
    for (const host of device.online ? (device.lanAddresses || []).filter(isOnLocalSubnet) : []) {
      if (await probeRdp(host)) {
        console.log(`地址: ${host}:3389`);
        console.log(`用户名: ${device.username || "请查看远端 Agent 窗口"}`);
        console.log("密码: 使用该 Windows 账号的登录密码（软件不会读取或保存密码）");
        console.log("连接方式: 局域网直连");
        return;
      }
    }
    let session = await request(config, "/v1/rdp/sessions", {
      method: "POST",
      body: JSON.stringify({ deviceId, ttlSeconds }),
    });
    const deadline = Date.now() + 30_000;
    while (["queued", "connecting"].includes(session.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      session = await request(config, `/v1/rdp/sessions/${session.id}`);
    }
    console.log(`地址: ${session.host}:${session.port}`);
    console.log(`用户名: ${session.username || "请查看远端 Agent 窗口"}`);
    console.log("密码: 使用该 Windows 账号的登录密码（软件不会读取或保存密码）");
    console.log(`状态: ${session.state}`);
    console.log("连接方式: 公网中继");
    console.log(`失效时间: ${session.expiresAt}`);
    return;
  }

  if (action === "cancel") {
    const commandId = option("--command", "");
    if (!/^[a-f0-9-]{36}$/i.test(commandId)) fail("--command must be a command UUID");
    const result = await request(config, `/v1/commands/${commandId}`, { method: "DELETE" });
    console.log(result.remoteTerminationRequested ? "已请求远程设备结束任务树。" : "任务已取消。");
    return;
  }

  const deviceId = option("--device", config.defaultDevice);
  const cwd = option("--cwd", "");
  const timeoutSeconds = Number(option("--timeout", "300"));
  const separator = args.indexOf("--");
  if (separator !== -1) args.splice(separator, 1);
  const command = args.join(" ");
  if (!deviceId) fail("--device is required when defaultDevice is not configured");
  if (!command) fail("a PowerShell command is required after --");

  let result = await request(config, "/v1/commands", {
    method: "POST",
    body: JSON.stringify({ deviceId, cwd, timeoutSeconds, command }),
  });
  const waitDeadline = Date.now() + (timeoutSeconds + 90) * 1000;
  while (result.status !== "completed") {
    if (Date.now() > waitDeadline) fail(`timed out waiting for command ${result.id}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await request(config, `/v1/commands/${result.id}`);
  }
  if (result.output) process.stdout.write(result.output);
  process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1;
}

main().catch((error) => fail(error.message));
