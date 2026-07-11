import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { readJson } from "./json-store.mjs";

export class ProviderStore {
  current() { return null; }
}
export class NullProviderStore extends ProviderStore {}

export class PythonSqliteProviderStore extends ProviderStore {
  constructor({ settingsFile, dbFile, python = "/usr/bin/python3" }) {
    super();
    this.settingsFile = settingsFile;
    this.dbFile = dbFile;
    this.python = python;
  }

  current() {
    const providerId = readJson(this.settingsFile).currentProviderClaude || "";
    if (!providerId || !fs.existsSync(this.dbFile) || !fs.existsSync(this.python)) return null;
    const script = `
import json, sqlite3, sys
db, provider_id = sys.argv[1:3]
conn = sqlite3.connect(db)
row = conn.execute("select name, settings_config from providers where app_type='claude' and id=?", (provider_id,)).fetchone()
endpoint = conn.execute("select url from provider_endpoints where app_type='claude' and provider_id=? order by id limit 1", (provider_id,)).fetchone()
conn.close()
if not row: raise SystemExit(2)
name, raw = row
settings = json.loads(raw)
env = settings.get("env", {})
base = env.get("ANTHROPIC_BASE_URL", "") or (endpoint[0] if endpoint else "")
print(json.dumps({"providerId": provider_id, "name": name, "baseUrl": base, "authToken": env.get("ANTHROPIC_AUTH_TOKEN", ""), "env": env}, ensure_ascii=False))
`;
    try {
      return JSON.parse(execFileSync(this.python, ["-", this.dbFile, providerId], {
        input: script, encoding: "utf8", timeout: 3000,
      }));
    } catch {
      return null;
    }
  }
}

export function createProviderStore(paths, options = {}) {
  if (options.providerStore) return options.providerStore;
  if (process.platform !== "win32") {
    return new PythonSqliteProviderStore({
      settingsFile: paths.ccSwitchSettings,
      dbFile: paths.ccSwitchDb,
      python: options.python || process.env.VISION_PYTHON || "/usr/bin/python3",
    });
  }
  return new NullProviderStore();
}
