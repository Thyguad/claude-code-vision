import os from "node:os";
import path from "node:path";

export function resolvePaths(env = process.env, home = os.homedir()) {
  const claudeDir = env.CLAUDE_DIR || path.join(home, ".claude");
  const runtimeDir = env.VISION_RUNTIME_DIR || path.join(claudeDir, "vision-proxy");
  const ccSwitchDir = env.CC_SWITCH_DIR || path.join(home, ".cc-switch");
  const port = Number.parseInt(env.PROXY_PORT || "18090", 10);
  return {
    home,
    claudeDir,
    runtimeDir,
    settingsFile: env.CLAUDE_SETTINGS_FILE || path.join(claudeDir, "settings.json"),
    proxyScript: env.VISION_PROXY_SCRIPT || path.join(runtimeDir, "proxy.mjs"),
    upstreamFile: env.VISION_UPSTREAM_CONFIG || path.join(runtimeDir, "upstream.json"),
    stateFile: env.VISION_STATE_FILE || path.join(runtimeDir, "state.json"),
    pidFile: env.VISION_PID_FILE || path.join(runtimeDir, "proxy.pid"),
    readyFile: env.VISION_ROUTING_GATE_FILE || path.join(runtimeDir, "routing.ready"),
    imageCacheFile: env.VISION_IMAGE_CACHE || path.join(runtimeDir, "image-cache.json"),
    visionModelFile: env.VISION_MODEL_CONFIG || path.join(runtimeDir, "vision-model.json"),
    logFile: env.VISION_LOG_FILE || path.join(claudeDir, "vision-proxy.log"),
    ccSwitchSettings: env.CC_SWITCH_SETTINGS || path.join(ccSwitchDir, "settings.json"),
    ccSwitchDb: env.CC_SWITCH_DB || path.join(ccSwitchDir, "cc-switch.db"),
    port,
    localBaseUrl: `http://127.0.0.1:${port}`,
  };
}
