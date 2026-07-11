#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "windows-runtime");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, "src", "proxy.mjs"), path.join(output, "proxy.mjs"));
fs.cpSync(path.join(root, "src", "core"), path.join(output, "core"), { recursive: true });
fs.cpSync(path.join(root, "src", "service"), path.join(output, "service"), { recursive: true });
for (const name of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(root, name), path.join(output, name));
fs.copyFileSync(path.join(root, "examples", "vision-model.example.json"), path.join(output, "vision-model.example.json"));
if (fs.existsSync(path.join(root, "node_modules"))) {
  fs.cpSync(path.join(root, "node_modules"), path.join(output, "node_modules"), { recursive: true });
}
fs.mkdirSync(path.join(output, "node"), { recursive: true });
const embeddedNode = process.env.EMBEDDED_NODE_PATH;
if (embeddedNode && fs.existsSync(embeddedNode)) {
  fs.copyFileSync(embeddedNode, path.join(output, "node", "node.exe"));
  const nodeLicense = process.env.EMBEDDED_NODE_LICENSE;
  if (!nodeLicense || !fs.existsSync(nodeLicense)) throw new Error("EMBEDDED_NODE_LICENSE is required when embedding Node.js");
  fs.copyFileSync(nodeLicense, path.join(output, "node", "LICENSE"));
} else {
  fs.writeFileSync(path.join(output, "node", "README.txt"), "Place the pinned Windows Node.js runtime in this directory during installer packaging.\r\n");
}
console.log(output);
