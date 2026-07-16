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
    const port = "39972"; // test-only free port
    const child = spawn("node", [resolve(ROOT, "dist/cli.js"), "--daemon"], {
      cwd: tmpdir(), // foreign cwd — proves no cwd-relative path assumptions
      env: {
        ...process.env,
        BITRIX24_MCP_BRIDGE_HOME: home,
        BITRIX_MCP_TOKEN: "smoke-token",
        BITRIX_ORIGIN: "https://smoke.bitrix24.ru",
        BITRIX_MCP_PORT: port,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const line = await new Promise<string>((res, rej) => {
        const t = setTimeout(() => rej(new Error("daemon did not announce startup in 8s")), 8000);
        let buf = "";
        child.stderr.on("data", (c) => {
          buf += c.toString();
          if (buf.includes("[daemon] ws :")) { clearTimeout(t); res(buf); }
        });
        child.on("exit", (code) => { clearTimeout(t); rej(new Error(`daemon exited early (${code}): ${buf}`)); });
      });
      expect(line).toContain(`[daemon] ws :${port}`);
    } finally {
      child.kill("SIGTERM");
    }
  });
});
