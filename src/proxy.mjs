#!/usr/bin/env node
/**
 * Claude Code Vision Proxy
 *
 * Sits between Claude Code and the currently selected Anthropic-compatible API.
 * Detects images in requests → describes them via Gemini (free tier) →
 * replaces images with text descriptions → forwards to the upstream provider.
 *
 * Usage:
 *   export GEMINI_API_KEY="your-gemini-key"
 *   node ~/.claude/vision-proxy/proxy.mjs
 *
 * Then in another terminal:
 *   export ANTHROPIC_BASE_URL=http://localhost:18090
 *   claude
 */

import http from "node:http";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProxyAgent } from "undici";

// ── Config ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.PROXY_PORT || "18090", 10);
const LOCAL_BASE_URL = `http://127.0.0.1:${PORT}`;
const UPSTREAM_CONFIG = process.env.VISION_UPSTREAM_CONFIG
  || path.join(os.homedir(), ".claude", "vision-proxy", "upstream.json");
const CLAUDE_SETTINGS_FILE = process.env.CLAUDE_SETTINGS_FILE
  || path.join(os.homedir(), ".claude", "settings.json");
const CC_SWITCH_SETTINGS = process.env.CC_SWITCH_SETTINGS
  || path.join(os.homedir(), ".cc-switch", "settings.json");
const CC_SWITCH_DB = process.env.CC_SWITCH_DB
  || path.join(os.homedir(), ".cc-switch", "cc-switch.db");
const IMAGE_CACHE_FILE = process.env.VISION_IMAGE_CACHE
  || path.join(os.homedir(), ".claude", "vision-proxy", "image-cache.json");
const VISION_MODEL_CONFIG = process.env.VISION_MODEL_CONFIG
  || path.join(os.homedir(), ".claude", "vision-proxy", "vision-model.json");
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_IMAGE_BYTES = parseInt(process.env.VISION_MAX_IMAGE_BYTES || `${20 * 1024 * 1024}`, 10);
const CACHE_VERSION = 1;

let imageCache = loadImageCache();
let lastSettingsMtimeMs = 0;
let lastCcSwitchProviderId = "";
let lastRoutingCheckKey = "";

// ── Proxy setup ──────────────────────────────────────────────────
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
let dispatcher = undefined;
if (PROXY_URL) {
  try {
    dispatcher = new ProxyAgent(PROXY_URL);
    log(`🔗 Using proxy: ${PROXY_URL}`);
  } catch (e) {
    log(`⚠️  Failed to create ProxyAgent: ${e.message}`);
  }
}

// Helper: fetch with proxy dispatcher
function proxyFetch(url, options = {}) {
  if (dispatcher) {
    options.dispatcher = dispatcher;
  }
  return fetch(url, options);
}

// ── Helpers ──────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().split("T")[1].split(".")[0];
  process.stderr.write(`[${ts}] ${msg}\n`);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function loadImageCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(IMAGE_CACHE_FILE, "utf8"));
    if (parsed?.version === CACHE_VERSION && typeof parsed.items === "object") {
      return parsed;
    }
  } catch {
    // Start with an empty cache if the file is missing or invalid.
  }
  return { version: CACHE_VERSION, items: {} };
}

function saveImageCache() {
  try {
    fs.mkdirSync(path.dirname(IMAGE_CACHE_FILE), { recursive: true });
    const tmp = `${IMAGE_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(imageCache, null, 2)}\n`);
    fs.renameSync(tmp, IMAGE_CACHE_FILE);
  } catch (e) {
    log(`⚠️  Failed to save image cache: ${e.message}`);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function imageCacheKey(mediaType, base64data) {
  return `sha256:${sha256(`${mediaType}\n${base64data}`)}`;
}

function urlCacheKey(imageUrl) {
  return `url:${sha256(imageUrl)}`;
}

function getCachedDescription(key) {
  const item = imageCache.items[key];
  if (item?.description) {
    item.lastUsedAt = Date.now();
    item.hits = (item.hits || 0) + 1;
    return item.description;
  }
  return "";
}

function setCachedDescription(key, mediaType, description) {
  if (!description || description.startsWith("[Image could not be analyzed:")) {
    return;
  }
  imageCache.items[key] = {
    mediaType,
    description,
    createdAt: imageCache.items[key]?.createdAt || Date.now(),
    lastUsedAt: Date.now(),
    hits: imageCache.items[key]?.hits || 0,
  };
}

function readVisionModelConfig() {
  const fileConfig = readJsonFile(VISION_MODEL_CONFIG);
  const provider = fileConfig.provider || process.env.VISION_PROVIDER || "gemini";
  const config = {
    provider,
    baseUrl: trimTrailingSlash(fileConfig.baseUrl || process.env.VISION_BASE_URL || ""),
    apiKey: fileConfig.apiKey || process.env.VISION_API_KEY || GEMINI_KEY,
    model: fileConfig.model || process.env.VISION_MODEL || GEMINI_MODEL,
    prompt: fileConfig.prompt || process.env.VISION_PROMPT || "",
    maxOutputTokens: Number(fileConfig.maxOutputTokens || process.env.VISION_MAX_OUTPUT_TOKENS || 2048),
  };
  return {
    ...config,
    configured: isVisionModelConfigured(config),
  };
}

function isPlaceholderVisionValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized
    || normalized === "your_vision_api_key"
    || normalized === "your_gemini_api_key"
    || normalized === "vision-model-name"
    || normalized.includes("api.example.com");
}

function isVisionModelConfigured(config) {
  if (!config || isPlaceholderVisionValue(config.apiKey) || isPlaceholderVisionValue(config.model)) {
    return false;
  }
  if (config.provider === "openai-compatible" && isPlaceholderVisionValue(config.baseUrl)) {
    return false;
  }
  return true;
}

function requestPath(req) {
  try {
    return new URL(req.url || "/", "http://127.0.0.1").pathname;
  } catch {
    return req.url || "/";
  }
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function isLocalProxyUrl(value) {
  const normalized = trimTrailingSlash(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    const hostname = url.hostname.toLowerCase();
    return (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1")
      && String(url.port || (url.protocol === "https:" ? "443" : "80")) === String(PORT);
  } catch {
    return normalized === LOCAL_BASE_URL;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function writeUpstreamConfigFromSettings(settings, reason) {
  const env = { ...(settings.env || {}) };
  const baseUrl = trimTrailingSlash(env.ANTHROPIC_BASE_URL || "");
  if (!baseUrl || isLocalProxyUrl(baseUrl)) {
    return false;
  }

  const upstream = {
    capturedAt: Math.floor(Date.now() / 1000),
    baseUrl,
    authToken: env.ANTHROPIC_AUTH_TOKEN || "",
    env,
    model: defaultModelFromEnv(env),
    modelOverride: process.env.VISION_MODEL_OVERRIDE || "",
    name: env.CC_SWITCH_PROVIDER_NAME || "cc-switch current provider",
    source: reason,
  };
  writeJsonFile(UPSTREAM_CONFIG, upstream);
  log(`🔁 Upstream switched to ${baseUrl} (${reason})`);
  return true;
}

function writeUpstreamConfigFromProvider(providerId, reason) {
  if (!providerId || !fs.existsSync(CC_SWITCH_DB)) {
    return false;
  }
  try {
    const script = `
import json
import sqlite3
import sys
from urllib.parse import urlparse

db_path, provider_id, local_base = sys.argv[1:4]

def is_local_proxy_url(value):
    value = (value or "").rstrip("/")
    if not value:
        return False
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        actual_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        local_port = urlparse(local_base).port or 80
        return host in ("127.0.0.1", "localhost", "::1") and str(actual_port) == str(local_port)
    except Exception:
        return value == local_base

conn = sqlite3.connect(db_path)
row = conn.execute(
    "select name, settings_config from providers where app_type='claude' and id=?",
    (provider_id,),
).fetchone()
if not row:
    conn.close()
    raise SystemExit(1)
name, settings_config = row
settings = json.loads(settings_config)
env = settings.get("env", {})
base_url = env.get("ANTHROPIC_BASE_URL", "")
endpoint_row = conn.execute(
    "select url from provider_endpoints where app_type='claude' and provider_id=? order by id limit 1",
    (provider_id,),
).fetchone()
endpoint_url = endpoint_row[0] if endpoint_row else ""
if (not base_url or is_local_proxy_url(base_url)) and endpoint_url:
    base_url = endpoint_url
    env["ANTHROPIC_BASE_URL"] = endpoint_url
    settings["env"] = env
    conn.execute(
        "update providers set settings_config=? where app_type='claude' and id=?",
        (json.dumps(settings, ensure_ascii=False), provider_id),
    )
    conn.commit()
conn.close()
if not base_url or is_local_proxy_url(base_url):
    raise SystemExit(2)
model = (
    env.get("ANTHROPIC_MODEL")
    or env.get("ANTHROPIC_DEFAULT_SONNET_MODEL")
    or env.get("ANTHROPIC_DEFAULT_OPUS_MODEL")
    or env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
    or ""
)
print(json.dumps({
    "providerId": provider_id,
    "name": name,
    "baseUrl": base_url,
    "authToken": env.get("ANTHROPIC_AUTH_TOKEN", ""),
    "env": env,
    "model": model,
}, ensure_ascii=False))
`;
    const output = execFileSync("/usr/bin/python3", ["-", CC_SWITCH_DB, providerId, LOCAL_BASE_URL], {
      input: script,
      encoding: "utf8",
      timeout: 3000,
    });
    const provider = JSON.parse(output);
    const upstream = {
      capturedAt: Math.floor(Date.now() / 1000),
      source: reason,
      modelOverride: process.env.VISION_MODEL_OVERRIDE || "",
      ...provider,
      baseUrl: trimTrailingSlash(provider.baseUrl),
    };
    writeJsonFile(UPSTREAM_CONFIG, upstream);
    log(`🔁 Upstream switched to ${upstream.baseUrl} (${upstream.name}, ${reason})`);
    return upstream;
  } catch (e) {
    log(`⚠️  Failed to read cc switch provider ${providerId}: ${e.message}`);
    return null;
  }
}

function readCurrentCcSwitchProviderId() {
  try {
    return readJsonFile(CC_SWITCH_SETTINGS).currentProviderClaude || "";
  } catch {
    return "";
  }
}

function syncUpstreamFromCcSwitchIfNeeded() {
  const providerId = readCurrentCcSwitchProviderId();
  if (!providerId || providerId === lastCcSwitchProviderId) {
    return;
  }
  lastCcSwitchProviderId = providerId;

  const upstream = writeUpstreamConfigFromProvider(providerId, "cc-switch-provider-change");
  if (upstream) {
    pointSettingsBackToLocalFromUpstream("cc-switch-provider-change");
  } else {
    syncUpstreamFromSettingsIfNeeded(true);
  }
}

function pointSettingsBackToLocal(settings) {
  const next = { ...settings, env: { ...(settings.env || {}) } };
  next.env.ANTHROPIC_BASE_URL = LOCAL_BASE_URL;
  writeJsonFile(CLAUDE_SETTINGS_FILE, next);
}

function pointSettingsBackToLocalFromUpstream(reason) {
  const upstream = readJsonFile(UPSTREAM_CONFIG);
  const upstreamEnv = upstream.env || {};
  if (!upstream.baseUrl && !upstreamEnv.ANTHROPIC_BASE_URL) {
    return false;
  }

  const current = readJsonFile(CLAUDE_SETTINGS_FILE);
  const nextEnv = {
    ...(current.env || {}),
    ...upstreamEnv,
    ANTHROPIC_BASE_URL: LOCAL_BASE_URL,
  };
  const next = { ...current, env: nextEnv };
  const currentEnv = current.env || {};
  const routingKey = JSON.stringify({
    base: currentEnv.ANTHROPIC_BASE_URL || "",
    token: currentEnv.ANTHROPIC_AUTH_TOKEN || "",
    model: currentEnv.ANTHROPIC_MODEL || "",
    sonnet: currentEnv.ANTHROPIC_DEFAULT_SONNET_MODEL || "",
  });
  const nextKey = JSON.stringify({
    base: nextEnv.ANTHROPIC_BASE_URL || "",
    token: nextEnv.ANTHROPIC_AUTH_TOKEN || "",
    model: nextEnv.ANTHROPIC_MODEL || "",
    sonnet: nextEnv.ANTHROPIC_DEFAULT_SONNET_MODEL || "",
  });
  if (routingKey === nextKey) {
    return false;
  }

  writeJsonFile(CLAUDE_SETTINGS_FILE, next);
  log(`🔌 Claude Code routed through local vision proxy (${reason})`);
  try {
    lastSettingsMtimeMs = fs.statSync(CLAUDE_SETTINGS_FILE).mtimeMs;
  } catch {
    // Ignore.
  }
  return true;
}

function syncUpstreamFromSettingsIfNeeded(force = false) {
  let stat;
  try {
    stat = fs.statSync(CLAUDE_SETTINGS_FILE);
  } catch {
    return;
  }
  if (!force && stat.mtimeMs === lastSettingsMtimeMs) {
    return;
  }
  lastSettingsMtimeMs = stat.mtimeMs;

  const settings = readJsonFile(CLAUDE_SETTINGS_FILE);
  const currentBaseUrl = trimTrailingSlash(settings?.env?.ANTHROPIC_BASE_URL || "");
  if (!currentBaseUrl || isLocalProxyUrl(currentBaseUrl)) {
    return;
  }

  if (writeUpstreamConfigFromSettings(settings, "settings-change")) {
    pointSettingsBackToLocal(settings);
    try {
      lastSettingsMtimeMs = fs.statSync(CLAUDE_SETTINGS_FILE).mtimeMs;
    } catch {
      // Ignore.
    }
  }
}

function maintainLocalRouting(reason = "watcher") {
  const providerId = readCurrentCcSwitchProviderId();
  const settings = readJsonFile(CLAUDE_SETTINGS_FILE);
  const currentBaseUrl = trimTrailingSlash(settings?.env?.ANTHROPIC_BASE_URL || "");
  const settingsMtimeMs = (() => {
    try {
      return fs.statSync(CLAUDE_SETTINGS_FILE).mtimeMs;
    } catch {
      return 0;
    }
  })();
  const checkKey = `${providerId}|${currentBaseUrl}|${settingsMtimeMs}`;
  if (checkKey === lastRoutingCheckKey) {
    return;
  }
  lastRoutingCheckKey = checkKey;

  syncUpstreamFromCcSwitchIfNeeded();
  syncUpstreamFromSettingsIfNeeded();
  if (!isLocalProxyUrl(readJsonFile(CLAUDE_SETTINGS_FILE)?.env?.ANTHROPIC_BASE_URL || "")) {
    pointSettingsBackToLocalFromUpstream(reason);
  }
}

function readUpstreamConfig() {
  maintainLocalRouting("request");
  let config = {};
  config = readJsonFile(UPSTREAM_CONFIG);

  const env = config.env || {};
  const baseUrl = trimTrailingSlash(
    config.baseUrl
      || env.ANTHROPIC_BASE_URL
      || process.env.UPSTREAM_BASE_URL
      || process.env.ANTHROPIC_BASE_URL
      || "https://api.anthropic.com"
  );
  const authToken = config.authToken
    || env.ANTHROPIC_AUTH_TOKEN
    || process.env.UPSTREAM_AUTH_TOKEN
    || process.env.ANTHROPIC_AUTH_TOKEN
    || "";

  return {
    baseUrl,
    authToken,
    name: config.name || "Current provider",
    modelOverride: process.env.VISION_MODEL_OVERRIDE || config.modelOverride || "",
  };
}

function defaultModelFromEnv(env) {
  return env?.ANTHROPIC_DEFAULT_SONNET_MODEL
    || env?.ANTHROPIC_MODEL
    || env?.ANTHROPIC_DEFAULT_OPUS_MODEL
    || env?.ANTHROPIC_DEFAULT_HAIKU_MODEL
    || "";
}

function upstreamUrl(pathname) {
  const upstream = readUpstreamConfig();
  return {
    upstream,
    url: `${upstream.baseUrl}${pathname}`,
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf-8");
  if (!rawBody.trim()) return {};
  return JSON.parse(rawBody);
}

function normalizeBodyForUpstream(body) {
  const upstream = readUpstreamConfig();
  const modifiedBody = { ...body };
  if (upstream.modelOverride) {
    if (modifiedBody.model && modifiedBody.model !== upstream.modelOverride) {
      log(`🔁 Model mapped: ${modifiedBody.model} -> ${upstream.modelOverride}`);
    }
    modifiedBody.model = upstream.modelOverride;
  }
  return modifiedBody;
}

function estimateTokensFromContent(content) {
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => {
    if (block?.type === "text" && typeof block.text === "string") {
      return total + Math.ceil(block.text.length / 4);
    }
    if (block?.type === "image") {
      return total + 1200;
    }
    return total;
  }, 0);
}

function estimateInputTokens(body) {
  const systemTokens = estimateTokensFromContent(body.system);
  const messageTokens = Array.isArray(body.messages)
    ? body.messages.reduce((total, message) => total + estimateTokensFromContent(message.content) + 4, 0)
    : 0;
  return Math.max(1, systemTokens + messageTokens);
}

/**
 * Walk through the messages array and collect all image blocks.
 * Returns { imageBlocks: [{msgIdx, blockIdx, mediaType, base64data}], totalImages }.
 */
function findImages(messages) {
  const imageBlocks = [];
  if (!Array.isArray(messages)) return { imageBlocks, totalImages: 0 };

  for (let mi = 0; mi < messages.length; mi++) {
    const content = messages[mi]?.content;
    if (!Array.isArray(content)) continue;
    for (let bi = 0; bi < content.length; bi++) {
      const block = content[bi];
      if (block?.type === "image" && block?.source?.data) {
        imageBlocks.push({
          msgIdx: mi,
          blockIdx: bi,
          mediaType: block.source.media_type || "image/png",
          base64data: block.source.data,
          sourceType: block.source.type || "base64",
        });
      }
      // Also handle URL-based images (source.type === "url")
      if (block?.type === "image" && block?.source?.type === "url" && block?.source?.url) {
        imageBlocks.push({
          msgIdx: mi,
          blockIdx: bi,
          mediaType: block.source.media_type || "image/png",
          base64data: null,
          imageUrl: block.source.url,
          sourceType: "url",
        });
      }
    }
  }
  return { imageBlocks, totalImages: imageBlocks.length };
}

/**
 * Describe an image (base64) using Gemini Vision API.
 */
async function describeImageBase64(mediaType, base64data, userPrompt) {
  const config = readVisionModelConfig();
  if (config.provider === "openai-compatible") {
    return describeImageOpenAICompatible(config, mediaType, base64data, userPrompt);
  }
  return describeImageGemini(config, mediaType, base64data, userPrompt);
}

function visionPrompt(config, userPrompt) {
  if (config.prompt) {
    return userPrompt
      ? `${config.prompt}\n\nUser question: ${userPrompt}`
      : config.prompt;
  }
  return userPrompt
    ? `The user sent this image with the following question: "${userPrompt}". Describe this image in detail, in Chinese. Focus on what is visible and relevant to answering the user's question.`
    : "Describe this image in detail, in Chinese. Describe everything that is visible including text, UI elements, people, objects, colors, layout, etc.";
}

async function describeImageGemini(config, mediaType, base64data, userPrompt) {
  const baseUrl = config.baseUrl || GEMINI_BASE;
  const url = `${baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`;
  const promptText = userPrompt
    ? visionPrompt(config, userPrompt)
    : visionPrompt(config, "");

  const body = {
    contents: [
      {
        parts: [
          { inlineData: { mimeType: mediaType, data: base64data } },
          { text: promptText },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: config.maxOutputTokens,
    },
  };

  const resp = await proxyFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    throw new Error(`Gemini returned no text: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return text;
}

async function describeImageOpenAICompatible(config, mediaType, base64data, userPrompt) {
  const baseUrl = config.baseUrl || "https://api.openai.com/v1";
  const url = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;
  const promptText = visionPrompt(config, userPrompt);
  const body = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          {
            type: "image_url",
            image_url: { url: `data:${mediaType};base64,${base64data}` },
          },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: config.maxOutputTokens,
  };

  const resp = await proxyFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Vision API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) {
    throw new Error(`Vision API returned no text: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return text;
}

/**
 * Download an image from URL and get base64 data.
 */
async function downloadImageAsBase64(imageUrl) {
  const resp = await proxyFetch(imageUrl);
  if (!resp.ok) {
    throw new Error(`Failed to download image: ${resp.status}`);
  }
  const contentLength = Number(resp.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large: ${Math.round(contentLength / 1024 / 1024)}MB`);
  }
  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large: ${Math.round(buffer.byteLength / 1024 / 1024)}MB`);
  }
  const base64 = Buffer.from(buffer).toString("base64");
  const contentType = resp.headers.get("content-type") || "image/png";
  return { base64, mediaType: contentType };
}

/**
 * Extract user text prompt from the same message that contains images.
 */
function extractUserPrompt(messages, msgIdx) {
  const content = messages[msgIdx]?.content;
  if (!Array.isArray(content)) return "";
  const textParts = content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return textParts;
}

// ── Request processor ────────────────────────────────────────────
async function processRequest(body) {
  const startTime = Date.now();
  const messages = body.messages || [];
  const { imageBlocks, totalImages } = findImages(messages);

  if (totalImages === 0) {
    // No images — pass through unchanged
    return { body, imagesProcessed: 0 };
  }

  const visionConfig = readVisionModelConfig();
  if (!visionConfig.configured) {
    log(`⚠️  Found ${totalImages} image(s), but the vision model is not configured.`);
    const modifiedMessages = JSON.parse(JSON.stringify(messages));
    for (let i = imageBlocks.length - 1; i >= 0; i--) {
      const img = imageBlocks[i];
      modifiedMessages[img.msgIdx].content[img.blockIdx] = {
        type: "text",
        text: "[图片未分析] 识图模型尚未配置。请点击菜单栏 ClaudeCode-Vision 图标，选择“识图模型设置...”，填写视觉模型 API Key 和模型名称后重试。",
      };
    }
    return {
      body: normalizeBodyForUpstream({ ...body, messages: modifiedMessages }),
      imagesProcessed: totalImages,
    };
  }
  log(`📸 Found ${totalImages} image(s) in request, describing via ${visionConfig.provider}...`);

  // Process each image
  const descriptions = [];
  let cacheChanged = false;
  let cacheHits = 0;
  let analyzedImages = 0;
  for (let i = 0; i < imageBlocks.length; i++) {
    const img = imageBlocks[i];
    let base64data = img.base64data;
    let mediaType = img.mediaType;
    let cacheKey = "";

    // Handle URL-based images
    if (img.sourceType === "url" && img.imageUrl) {
      const cachedByUrl = getCachedDescription(urlCacheKey(img.imageUrl));
      if (cachedByUrl) {
        log(`  ♻️  Cache hit for image URL ${i + 1}/${totalImages}`);
        cacheHits++;
        descriptions.push(cachedByUrl);
        continue;
      }
      try {
        log(`  ⬇️  Downloading image from URL...`);
        const downloaded = await downloadImageAsBase64(img.imageUrl);
        base64data = downloaded.base64;
        mediaType = downloaded.mediaType;
      } catch (e) {
        log(`  ⚠️  Failed to download image URL: ${e.message}`);
        descriptions.push(`[Image URL could not be downloaded: ${img.imageUrl}]`);
        continue;
      }
    }

    cacheKey = imageCacheKey(mediaType, base64data);
    const cachedDescription = getCachedDescription(cacheKey);
    if (cachedDescription) {
      log(`  ♻️  Cache hit for image ${i + 1}/${totalImages}`);
      cacheHits++;
      descriptions.push(cachedDescription);
      continue;
    }

    const userPrompt = extractUserPrompt(messages, img.msgIdx);

    try {
      log(`  🖼️  Describing image ${i + 1}/${totalImages} (${mediaType}, ${Math.round(base64data.length * 0.75 / 1024)}KB)...`);
      const description = await describeImageBase64(mediaType, base64data, userPrompt);
      log(`  ✅ Image ${i + 1}/${totalImages} described (${description.length} chars)`);
      analyzedImages++;
      setCachedDescription(cacheKey, mediaType, description);
      if (img.sourceType === "url" && img.imageUrl) {
        setCachedDescription(urlCacheKey(img.imageUrl), mediaType, description);
      }
      cacheChanged = true;
      descriptions.push(description);
    } catch (e) {
      log(`  ❌ Failed to describe image ${i + 1}: ${e.message}`);
      descriptions.push(`[Image could not be analyzed: ${e.message}]`);
    }
  }

  if (cacheChanged) {
    saveImageCache();
  }

  // Replace image blocks with text descriptions
  // Process in reverse order to preserve indices
  const modifiedMessages = JSON.parse(JSON.stringify(messages));

  // First, collect all descriptions by (msgIdx, blockIdx)
  // Actually, let's replace inline: for each image block, replace with text
  // We need to handle multiple images in the same message properly
  for (let i = imageBlocks.length - 1; i >= 0; i--) {
    const img = imageBlocks[i];
    const content = modifiedMessages[img.msgIdx].content;

    if (typeof descriptions[i] === "string" && descriptions[i].length > 0) {
      // Replace image block with a text block containing the description
      content[img.blockIdx] = {
        type: "text",
        text: `[📷 图片分析结果]\n${descriptions[i]}`,
      };
    } else {
      // Remove the image block if we couldn't describe it
      content.splice(img.blockIdx, 1);
    }
  }

  const modifiedBody = normalizeBodyForUpstream({ ...body, messages: modifiedMessages });

  const elapsed = Date.now() - startTime;
  log(`⏱️  ${totalImages} image block(s) handled in ${elapsed}ms (${cacheHits} cached, ${analyzedImages} analyzed)`);

  return { body: modifiedBody, imagesProcessed: totalImages };
}

// ── Proxy to upstream provider (streaming) ───────────────────────
async function proxyToUpstream(modifiedBody, clientReq, clientRes) {
  const { upstream, url } = upstreamUrl("/v1/messages");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${upstream.authToken}`,
    "x-api-key": upstream.authToken,
  };
  for (const header of ["anthropic-version", "anthropic-beta", "user-agent"]) {
    if (clientReq.headers[header]) headers[header] = clientReq.headers[header];
  }

  const resp = await proxyFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(modifiedBody),
    redirect: "follow",
  });

  if (!resp.ok) {
    const errText = await resp.text();
    log(`❌ Upstream API error ${resp.status} (${upstream.name}): ${errText.slice(0, 300)}`);
    clientRes.writeHead(resp.status, { "Content-Type": "application/json" });
    clientRes.end(errText);
    return;
  }

  // Forward response headers (especially for SSE streaming)
  const contentType = resp.headers.get("content-type") || "application/json";
  clientRes.writeHead(resp.status, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Stream the response body
  const reader = resp.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      clientRes.write(value);
    }
  } finally {
    reader.releaseLock();
  }
  clientRes.end();
}

// ── Server ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const path = requestPath(req);

  // CORS for potential browser use
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && (path === "/health" || path === "/")) {
    const visionConfig = readVisionModelConfig();
    sendJson(res, 200, {
      status: "ok",
      upstream: readUpstreamConfig().baseUrl,
      provider: readUpstreamConfig().name,
      visionProvider: visionConfig.provider,
      visionModel: visionConfig.model,
      visionConfigured: visionConfig.configured,
    });
    return;
  }

  // Model listing
  if (req.method === "GET" && path === "/v1/models") {
    const { upstream, url } = upstreamUrl("/v1/models");
    try {
      const upstreamResp = await proxyFetch(url, {
        headers: {
          Authorization: `Bearer ${upstream.authToken}`,
          "x-api-key": upstream.authToken,
        },
      });
      const text = await upstreamResp.text();
      res.writeHead(upstreamResp.status, {
        "Content-Type": upstreamResp.headers.get("content-type") || "application/json",
      });
      res.end(text);
      return;
    } catch (e) {
      sendJson(res, 200, { data: [] });
      return;
    }
  }

  if (req.method === "POST" && path === "/v1/messages/count_tokens") {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, { input_tokens: estimateInputTokens(body) });
    } catch {
      sendJson(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON" } });
    }
    return;
  }

  // Main endpoint: POST /v1/messages
  if (req.method === "POST" && path === "/v1/messages") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON" } });
      return;
    }

    try {
      const { body: processedBody, imagesProcessed } = await processRequest(body);
      const modifiedBody = imagesProcessed > 0
        ? processedBody
        : normalizeBodyForUpstream(processedBody);
      if (imagesProcessed > 0) {
        log(`📝 Forwarding to upstream with text descriptions...`);
      }
      await proxyToUpstream(modifiedBody, req, res);
    } catch (e) {
      log(`❌ Proxy error: ${e.message}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { type: "api_error", message: e.message } });
      }
    }
    return;
  }

  // 404
  sendJson(res, 404, { error: { type: "not_found_error", message: `Not found: ${req.method} ${path}` } });
});

// ── Startup ───────────────────────────────────────────────────────
server.listen(PORT, "127.0.0.1", () => {
  maintainLocalRouting("startup");
  console.log(`
╔══════════════════════════════════════════════════╗
║     Claude Code Vision Proxy                    ║
╠══════════════════════════════════════════════════╣
║  Listening:  http://127.0.0.1:${PORT}              ║
║  Upstream:   ${readUpstreamConfig().baseUrl}           ║
║  Vision:     ${readVisionModelConfig().provider} (${readVisionModelConfig().model})              ║
║  Vision Key: ${readVisionModelConfig().apiKey ? "✅ configured" : "❌ MISSING"}                       ║
╚══════════════════════════════════════════════════╝

To connect Claude Code, run in another terminal:

  export ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT}
  claude
`);
});

setInterval(() => {
  try {
    maintainLocalRouting("watcher");
  } catch (e) {
    log(`⚠️  Routing watcher failed: ${e.message}`);
  }
}, 1000).unref();

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`❌ Port ${PORT} is already in use. Try: PROXY_PORT=18091 node ~/.claude/vision-proxy/proxy.mjs`);
  } else {
    log(`❌ Server error: ${e.message}`);
  }
  process.exit(1);
});
