import { describe, it, expect } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

describe("setup first-run smoke", () => {
  it("bootstraps config + extension in a temp home from piped answers", async () => {
    // ensure the shipped static bundles exist for materialization
    execFileSync("node", ["scripts/build-ext-static.mjs"], { cwd: ROOT, stdio: "pipe" });
    const home = mkdtempSync(join(tmpdir(), "br24setup-"));
    const child = spawn("bun", ["run", "src/index.ts", "setup"], {
      cwd: ROOT,
      env: { ...process.env, BITRIX24_MCP_BRIDGE_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // first-run prompts: portal origin, then alias
    child.stdin.write("https://acme.bitrix24.ru\nacme\n");
    child.stdin.end();

    const code: number = await new Promise((res) => {
      const t = setTimeout(() => { child.kill("SIGTERM"); res(-1); }, 20000);
      child.on("exit", (c) => { clearTimeout(t); res(c ?? -1); });
    });
    expect(code).toBe(0);

    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.defaultPortal).toBe("acme");
    expect(cfg.portals.acme.origin).toBe("https://acme.bitrix24.ru");
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);

    expect(existsSync(join(home, "actions.json"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(home, "extension/manifest.json"), "utf8"));
    expect(manifest.content_scripts[0].matches).toEqual(["https://acme.bitrix24.ru/*"]);
    const extCfg = JSON.parse(readFileSync(join(home, "extension/config.json"), "utf8"));
    expect(extCfg.token).toBe(cfg.token);
    expect(extCfg.port).toBe(39917);
    expect(existsSync(join(home, "extension/connector.js"))).toBe(true);
  });
});
