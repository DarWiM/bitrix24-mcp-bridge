import { describe, it, expect } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

describe("dist bundle smoke (node --daemon)", () => {
  it("boots the bundled daemon on plain node from a foreign cwd", async () => {
    execFileSync("node", ["scripts/build-dist.mjs"], { cwd: ROOT, stdio: "pipe" });
    const home = mkdtempSync(resolve(tmpdir(), "br24smoke-"));
    const child = spawn("node", [resolve(ROOT, "dist/cli.js"), "--daemon"], {
      cwd: tmpdir(), // foreign cwd — proves no cwd-relative path assumptions
      env: {
        ...process.env,
        BITRIX24_MCP_BRIDGE_HOME: home,
        BITRIX_MCP_TOKEN: "smoke-token",
        BITRIX_ORIGIN: "https://smoke.bitrix24.ru",
        BITRIX_MCP_PORT: "0", // ephemeral — avoids collisions with other tests/processes
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const line = await new Promise<string>((res, rej) => {
        const t = setTimeout(() => rej(new Error("daemon did not announce startup in 8s")), 8000);
        let buf = "";
        child.stderr.on("data", (c) => {
          buf += c.toString();
          if (/\[daemon\] ws :\d+/.test(buf)) { clearTimeout(t); res(buf); }
        });
        child.on("exit", (code) => { clearTimeout(t); rej(new Error(`daemon exited early (${code}): ${buf}`)); });
      });
      const match = line.match(/\[daemon\] ws :(\d+)/);
      expect(match).not.toBeNull();
      const port = Number(match![1]);
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThan(0);
    } finally {
      child.kill("SIGTERM");
    }
  });
});
