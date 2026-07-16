import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = resolve(ROOT, "extension/dist");

describe("build-ext-static", () => {
  it("emits only static bundles + maps and clears stale artifacts", () => {
    mkdirSync(DIST, { recursive: true });
    writeFileSync(resolve(DIST, "bridge-client.js"), "// stale\n"); // must be removed by rmSync
    execFileSync("node", ["scripts/build-ext-static.mjs"], { cwd: ROOT, stdio: "pipe" });

    expect(existsSync(resolve(DIST, "connector.js"))).toBe(true);
    expect(existsSync(resolve(DIST, "sessid-shim.js"))).toBe(true);
    expect(existsSync(resolve(DIST, "connector.js.map"))).toBe(true);
    expect(existsSync(resolve(DIST, "sessid-shim.js.map"))).toBe(true);
    // stale artifact gone (rmSync before build)
    expect(existsSync(resolve(DIST, "bridge-client.js"))).toBe(false);
    // static-only: this build emits NO per-user files
    expect(existsSync(resolve(DIST, "config.json"))).toBe(false);
    expect(existsSync(resolve(DIST, "manifest.json"))).toBe(false);
    // real bundle content
    expect(readFileSync(resolve(DIST, "connector.js"), "utf8").length).toBeGreaterThan(100);
  });
});
