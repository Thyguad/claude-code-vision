#!/usr/bin/env node
import { resolvePaths } from "../core/paths.mjs";
import { createProviderStore } from "../core/provider-store.mjs";
import { doctor, EXIT, foreground, restart, start, status, stop, upstream } from "./controller.mjs";

const command = process.argv[2] || "status";
const json = process.argv.includes("--json");
const paths = resolvePaths();
const providerStore = createProviderStore(paths);

function emit(value, fallback) {
  if (json || typeof value !== "string") console.log(JSON.stringify(value, null, 2));
  else console.log(value || fallback);
}
try {
  switch (command) {
    case "start": emit(await start(paths, providerStore), "running"); break;
    case "foreground": process.exitCode = await foreground(paths, providerStore); break;
    case "stop": await stop(paths, providerStore); emit(json ? { running: false } : "stopped"); break;
    case "restart": emit(await restart(paths, providerStore), "running"); break;
    case "status": {
      const result = await status(paths);
      emit(json ? result : result.running ? "running" : "stopped");
      if (!result.running) process.exitCode = EXIT.NOT_RUNNING;
      break;
    }
    case "doctor": emit(await doctor(paths, providerStore)); break;
    case "upstream": emit(upstream(paths) || {}); break;
    default:
      console.error("Usage: cli.mjs {start|foreground|stop|restart|status|doctor|upstream} [--json]");
      process.exitCode = 2;
  }
} catch (error) {
  if (json) console.error(JSON.stringify({ error: { code: error.code || "SERVICE_ERROR", message: error.message } }));
  else console.error(error.message);
  process.exitCode = error.exitCode || EXIT.INTERNAL;
}
