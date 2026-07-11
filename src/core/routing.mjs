import { readJson, writeJsonAtomic } from "./json-store.mjs";

export function isLocalProxyUrl(value, port = 18090) {
  try {
    const url = new URL(String(value || ""));
    const actualPort = url.port || (url.protocol === "https:" ? "443" : "80");
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase())
      && String(actualPort) === String(port);
  } catch { return false; }
}
function modelFromEnv(env = {}) {
  return env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL
    || env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "";
}

export function captureUpstream(paths, providerStore, now = Date.now) {
  const current = readJson(paths.settingsFile);
  let env = { ...(current.env || {}) };
  let provider = providerStore?.current?.() || null;
  let baseUrl = provider?.baseUrl || env.ANTHROPIC_BASE_URL || "";
  if (isLocalProxyUrl(baseUrl, paths.port)) {
    const existing = readJson(paths.upstreamFile);
    baseUrl = existing.baseUrl || existing.env?.ANTHROPIC_BASE_URL || "";
    if (!provider) provider = existing;
  }
  if (!baseUrl || isLocalProxyUrl(baseUrl, paths.port)) {
    throw Object.assign(new Error("No valid upstream provider is configured"), { code: "NO_UPSTREAM" });
  }
  if (provider?.env) env = { ...env, ...provider.env };
  env.ANTHROPIC_BASE_URL = baseUrl;
  const upstream = {
    capturedAt: Math.floor(now() / 1000),
    providerId: provider?.providerId || "",
    baseUrl,
    authToken: provider?.authToken || env.ANTHROPIC_AUTH_TOKEN || "",
    env,
    model: modelFromEnv(env),
    name: provider?.name || env.CC_SWITCH_PROVIDER_NAME || "cc-switch current provider",
    source: provider ? "cc-switch-current-provider" : "claude-settings",
  };
  writeJsonAtomic(paths.upstreamFile, upstream);
  writeJsonAtomic(paths.stateFile, { startedAt: Math.floor(now() / 1000), originalBaseUrl: baseUrl, originalEnv: env });
  return upstream;
}

export function routeToLocal(paths, upstream = readJson(paths.upstreamFile)) {
  const settings = readJson(paths.settingsFile);
  const env = { ...(settings.env || {}), ...(upstream.env || {}), ANTHROPIC_BASE_URL: paths.localBaseUrl };
  writeJsonAtomic(paths.settingsFile, { ...settings, env });
}

export function restoreRouting(paths, providerStore) {
  const settings = readJson(paths.settingsFile);
  const provider = providerStore?.current?.() || null;
  const state = readJson(paths.stateFile);
  const upstream = readJson(paths.upstreamFile);
  const originalEnv = provider?.env || state.originalEnv || upstream.env || {};
  const baseUrl = provider?.baseUrl || state.originalBaseUrl || upstream.baseUrl || originalEnv.ANTHROPIC_BASE_URL;
  if (!baseUrl || isLocalProxyUrl(baseUrl, paths.port)) return false;
  writeJsonAtomic(paths.settingsFile, {
    ...settings,
    env: { ...originalEnv, ANTHROPIC_BASE_URL: baseUrl },
  });
  return true;
}
