#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const publishDirectory = process.env.WINDOWS_TRAY_PUBLISH_DIR || path.join(root, "build", "windows-tray");
const runtimeDirectory = path.join(root, "dist", "windows-runtime");
const output = path.join(root, "dist", "ClaudeCode-Vision-windows-x64");
if (!fs.existsSync(path.join(publishDirectory, "ClaudeCode-Vision.exe"))) throw new Error(`Windows tray publish output not found: ${publishDirectory}`);
if (!fs.existsSync(path.join(runtimeDirectory, "service", "cli.mjs"))) throw new Error("Run package:windows-runtime first");
fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(publishDirectory, output, { recursive: true });
fs.cpSync(runtimeDirectory, path.join(output, "runtime"), { recursive: true });
fs.writeFileSync(path.join(output, "BUILD-INFO.json"), `${JSON.stringify({
  name: project.name,
  version: project.version,
  platform: "win32",
  arch: "x64",
  bundledNode: fs.existsSync(path.join(output, "runtime", "node", "node.exe")),
}, null, 2)}\n`);
fs.writeFileSync(path.join(output, "README-Windows.txt"), [
  "ClaudeCode-Vision for Windows",
  "",
  "Run ClaudeCode-Vision.exe. The application starts in the system tray.",
  "Configure the vision provider from the tray menu before sending images.",
  "Exit from the tray menu to stop the proxy and restore Claude Code routing.",
  "",
].join("\r\n"));
console.log(output);
