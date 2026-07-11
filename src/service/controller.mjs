import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { readJson, writeJsonAtomic } from "../core/json-store.mjs";
import { captureUpstream, restoreRouting, routeToLocal } from "../core/routing.mjs";

export const EXIT = Object.freeze({ OK: 0, NOT_RUNNING: 3, CONFIG: 4, PORT_IN_USE: 5, START_FAILED: 6, INTERNAL: 10 });

export function readPid(paths) {
  const value = Number.parseInt(fs.readFileSync(paths.pidFile, "utf8"), 10);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function processExists(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function health(paths, timeoutMs = 800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${paths.localBaseUrl}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

export async function portAvailable(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function status(paths) {
  const pid = readPidSafe(paths);
  const response = await health(paths);
  return { running: Boolean(response), pid: response ? pid || null : null, localBaseUrl: paths.localBaseUrl, health: response };
}

function readPidSafe(paths) {
  try { return readPid(paths); } catch { return 0; }
}

function runtimeEnv(paths, upstream = {}) {
  return {
    ...process.env,
    ...(upstream.env?.HTTPS_PROXY && !process.env.HTTPS_PROXY ? { HTTPS_PROXY: upstream.env.HTTPS_PROXY } : {}),
    ...(upstream.env?.HTTP_PROXY && !process.env.HTTP_PROXY ? { HTTP_PROXY: upstream.env.HTTP_PROXY } : {}),
    PROXY_PORT: String(paths.port),
    VISION_RUNTIME_DIR: paths.runtimeDir,
    VISION_UPSTREAM_CONFIG: paths.upstreamFile,
    VISION_STATE_FILE: paths.stateFile,
    VISION_PID_FILE: paths.pidFile,
    VISION_LOG_FILE: paths.logFile,
    VISION_MODEL_CONFIG: paths.visionModelFile,
    VISION_IMAGE_CACHE: paths.imageCacheFile,
    VISION_ROUTING_GATE_FILE: paths.readyFile,
    CLAUDE_SETTINGS_FILE: paths.settingsFile,
    CC_SWITCH_SETTINGS: paths.ccSwitchSettings,
    CC_SWITCH_DB: paths.ccSwitchDb,
  };
}

async function waitForHealth(paths, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await health(paths);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

export async function start(paths, providerStore, options = {}) {
  const existing = await status(paths);
  if (existing.running) return { ...existing, alreadyRunning: true };
  if (!(await portAvailable(paths.port))) {
    throw Object.assign(new Error(`Port ${paths.port} is already in use`), { exitCode: EXIT.PORT_IN_USE });
  }
  let upstream;
  try { upstream = captureUpstream(paths, providerStore); }
  catch (error) { error.exitCode = EXIT.CONFIG; throw error; }

  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.rmSync(paths.readyFile, { force: true });
  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });
  const log = fs.openSync(paths.logFile, "a");
  const child = spawn(options.node || process.execPath, [paths.proxyScript], {
    env: runtimeEnv(paths, upstream), detached: true, stdio: ["ignore", log, log], windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);
  fs.writeFileSync(paths.pidFile, `${child.pid}\n`);
  const response = await waitForHealth(paths);
  if (!response) {
    try { process.kill(child.pid); } catch { /* already exited */ }
    restoreRouting(paths, providerStore);
    fs.rmSync(paths.pidFile, { force: true });
    throw Object.assign(new Error("Vision proxy failed its health check"), { exitCode: EXIT.START_FAILED });
  }
  routeToLocal(paths, upstream);
  fs.writeFileSync(paths.readyFile, "ready\n");
  return { running: true, pid: child.pid, localBaseUrl: paths.localBaseUrl, health: response };
}

export async function foreground(paths, providerStore, options = {}) {
  if (!(await portAvailable(paths.port))) throw Object.assign(new Error(`Port ${paths.port} is already in use`), { exitCode: EXIT.PORT_IN_USE });
  const upstream = captureUpstream(paths, providerStore);
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.rmSync(paths.readyFile, { force: true });
  const child = spawn(options.node || process.execPath, [paths.proxyScript], {
    env: runtimeEnv(paths, upstream), stdio: "inherit", windowsHide: true,
  });
  fs.writeFileSync(paths.pidFile, `${child.pid}\n`);
  const response = await waitForHealth(paths);
  if (!response) {
    try { child.kill(); } catch { /* already exited */ }
    restoreRouting(paths, providerStore);
    throw Object.assign(new Error("Vision proxy failed its health check"), { exitCode: EXIT.START_FAILED });
  }
  routeToLocal(paths, upstream);
  fs.writeFileSync(paths.readyFile, "ready\n");
  const shutdown = () => child.kill();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 0)));
  restoreRouting(paths, providerStore);
  fs.rmSync(paths.pidFile, { force: true });
  fs.rmSync(paths.readyFile, { force: true });
  return exitCode;
}

export async function stop(paths, providerStore) {
  const pid = readPidSafe(paths);
  if (processExists(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* best effort */ }
  }
  restoreRouting(paths, providerStore);
  fs.rmSync(paths.pidFile, { force: true });
  fs.rmSync(paths.readyFile, { force: true });
  return { running: false, stoppedPid: pid || null };
}

export async function restart(paths, providerStore, options) {
  await stop(paths, providerStore);
  return start(paths, providerStore, options);
}

export function upstream(paths) {
  const value = readJson(paths.upstreamFile, null);
  return value ? { ...value, authToken: value.authToken ? "[redacted]" : "", env: redactEnv(value.env) } : null;
}

function redactEnv(env = {}) {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value ? "[redacted]" : value]));
}

export async function doctor(paths, providerStore) {
  const service = await status(paths);
  const settings = readJson(paths.settingsFile);
  const vision = readJson(paths.visionModelFile);
  const selected = providerStore?.current?.() || null;
  return {
    service,
    runtime: { platform: process.platform, arch: process.arch, nodePath: process.execPath, nodeVersion: process.version, proxyScript: paths.proxyScript, logFile: paths.logFile },
    claudeSettings: { path: paths.settingsFile, exists: fs.existsSync(paths.settingsFile), baseUrl: settings.env?.ANTHROPIC_BASE_URL || "", hasAuthToken: Boolean(settings.env?.ANTHROPIC_AUTH_TOKEN) },
    ccSwitch: { settingsPath: paths.ccSwitchSettings, dbPath: paths.ccSwitchDb, currentProviderId: readJson(paths.ccSwitchSettings).currentProviderClaude || "", currentProviderName: selected?.name || "" },
    upstream: upstream(paths),
    visionModel: { path: paths.visionModelFile, provider: vision.provider || "gemini", baseUrl: vision.baseUrl || "", model: vision.model || "", hasApiKey: Boolean(vision.apiKey), hasCustomPrompt: Boolean(vision.prompt) },
    errors: [],
  };
}
