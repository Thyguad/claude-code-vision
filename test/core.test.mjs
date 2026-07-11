import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readJson, writeJsonAtomic } from "../src/core/json-store.mjs";
import { resolvePaths } from "../src/core/paths.mjs";
import { captureUpstream, isLocalProxyUrl, restoreRouting, routeToLocal } from "../src/core/routing.mjs";
import { doctor, start, status, stop, upstream } from "../src/service/controller.mjs";

function fixture(t, name = "用户 With Space") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `vision-${name}-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = resolvePaths({}, home);
  fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
  writeJsonAtomic(paths.settingsFile, { env: { ANTHROPIC_BASE_URL: "https://upstream.example/v1", ANTHROPIC_AUTH_TOKEN: "secret" } });
  return paths;
}

test("JSON store returns fallback for missing and damaged files", (t) => {
  const paths = fixture(t);
  assert.deepEqual(readJson(path.join(paths.runtimeDir, "missing.json"), { ok: true }), { ok: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(paths.runtimeDir, "bad.json"), "{");
  assert.deepEqual(readJson(path.join(paths.runtimeDir, "bad.json"), []), []);
});

test("JSON store writes atomically without leaving temporary files", (t) => {
  const paths = fixture(t);
  writeJsonAtomic(paths.upstreamFile, { value: "中文" });
  assert.deepEqual(readJson(paths.upstreamFile), { value: "中文" });
  assert.deepEqual(fs.readdirSync(paths.runtimeDir).filter((name) => name.endsWith(".tmp")), []);
});

test("routing captures, routes, and restores settings", (t) => {
  const paths = fixture(t);
  const store = { current: () => null };
  const captured = captureUpstream(paths, store, () => 1_700_000_000_000);
  assert.equal(captured.baseUrl, "https://upstream.example/v1");
  routeToLocal(paths, captured);
  assert.equal(readJson(paths.settingsFile).env.ANTHROPIC_BASE_URL, paths.localBaseUrl);
  assert.equal(restoreRouting(paths, store), true);
  assert.equal(readJson(paths.settingsFile).env.ANTHROPIC_BASE_URL, "https://upstream.example/v1");
});

test("cc-switch provider takes precedence and secrets are redacted", (t) => {
  const paths = fixture(t);
  const provider = { providerId: "p1", name: "Provider", baseUrl: "https://provider.example", authToken: "token", env: { ANTHROPIC_BASE_URL: "https://provider.example", ANTHROPIC_AUTH_TOKEN: "token" } };
  captureUpstream(paths, { current: () => provider });
  const result = upstream(paths);
  assert.equal(result.authToken, "[redacted]");
  assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, "[redacted]");
});

test("local proxy URL detection is port-specific", () => {
  assert.equal(isLocalProxyUrl("http://localhost:18090", 18090), true);
  assert.equal(isLocalProxyUrl("http://127.0.0.1:18091", 18090), false);
  assert.equal(isLocalProxyUrl("https://example.com", 18090), false);
});

test("status, doctor and repeated stop are safe in an isolated home", async (t) => {
  const paths = fixture(t);
  const store = { current: () => null };
  const current = await status(paths);
  assert.equal(current.running, false);
  const report = await doctor(paths, store);
  assert.deepEqual(Object.keys(report), ["service", "runtime", "claudeSettings", "ccSwitch", "upstream", "visionModel", "errors"]);
  assert.equal(report.claudeSettings.hasAuthToken, true);
  await stop(paths, store);
  await stop(paths, store);
  assert.equal(readJson(paths.settingsFile).env.ANTHROPIC_BASE_URL, "https://upstream.example/v1");
});

test("Windows-style override paths are preserved", () => {
  const paths = resolvePaths({ CLAUDE_SETTINGS_FILE: "C:\\Users\\测试 User\\.claude\\settings.json", PROXY_PORT: "18091" }, "C:\\Users\\测试 User");
  assert.equal(paths.settingsFile, "C:\\Users\\测试 User\\.claude\\settings.json");
  assert.equal(paths.localBaseUrl, "http://127.0.0.1:18091");
});

test("CLI status has stable JSON output and not-running exit code", (t) => {
  const paths = fixture(t, "cli");
  const result = spawnSync(process.execPath, [path.resolve("src/service/cli.mjs"), "status", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_DIR: paths.claudeDir,
      VISION_RUNTIME_DIR: paths.runtimeDir,
      CLAUDE_SETTINGS_FILE: paths.settingsFile,
      PROXY_PORT: "18191",
    },
  });
  assert.equal(result.status, 3);
  const value = JSON.parse(result.stdout);
  assert.equal(value.running, false);
  assert.equal(value.localBaseUrl, "http://127.0.0.1:18191");
});

test("service starts only after health and restores routing on stop", async (t) => {
  const paths = fixture(t, "lifecycle");
  let probe;
  try {
    probe = await import("node:net").then(({ createServer }) => new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    }));
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("environment does not permit local TCP listeners");
      return;
    }
    throw error;
  }
  paths.port = probe;
  paths.localBaseUrl = `http://127.0.0.1:${probe}`;
  paths.proxyScript = path.join(paths.runtimeDir, "fake-proxy.mjs");
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.writeFileSync(paths.proxyScript, `
    import http from "node:http";
    const server = http.createServer((req, res) => {
      if (req.url === "/health") { res.setHeader("content-type", "application/json"); res.end('{"status":"ok"}'); }
      else { res.statusCode = 404; res.end(); }
    });
    server.listen(Number(process.env.PROXY_PORT), "127.0.0.1");
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `);
  const store = { current: () => null };
  const running = await start(paths, store);
  assert.equal(running.running, true);
  assert.equal(readJson(paths.settingsFile).env.ANTHROPIC_BASE_URL, paths.localBaseUrl);
  assert.equal(fs.existsSync(paths.readyFile), true);
  await stop(paths, store);
  assert.equal(readJson(paths.settingsFile).env.ANTHROPIC_BASE_URL, "https://upstream.example/v1");
  assert.equal(fs.existsSync(paths.readyFile), false);
});
