import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

describe("build-dist", () => {
  it("produces an executable ESM bundle with a shebang and inlined api-notes", () => {
    execFileSync("node", ["scripts/build-dist.mjs"], { cwd: ROOT, stdio: "pipe" });
    const out = resolve(ROOT, "dist/cli.js");
    expect(existsSync(out)).toBe(true);
    const js = readFileSync(out, "utf8");
    expect(js.startsWith("#!/usr/bin/env node")).toBe(true);
    // api-notes text got inlined (a stable phrase from docs/api-notes.md)
    const notes = readFileSync(resolve(ROOT, "docs/api-notes.md"), "utf8");
    const marker = notes.split("\n").find((l) => l.trim().length > 12)!.trim().slice(0, 12);
    expect(js.includes(marker)).toBe(true);
    // executable bit
    expect(statSync(out).mode & 0o100).toBeTruthy();
  });
});
