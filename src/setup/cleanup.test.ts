import { describe, it, expect, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeObsoleteFiles } from "./cleanup.js";

const tempHome = () => mkdtempSync(join(tmpdir(), "bridge-cleanup-"));

describe("removeObsoleteFiles", () => {
  it("removes both obsolete files and returns their paths", () => {
    const home = tempHome();
    writeFileSync(join(home, "actions.json"), "{}");
    writeFileSync(join(home, "catalog-state.json"), "{}");
    const removed = removeObsoleteFiles(home);
    expect(removed.sort()).toEqual([join(home, "actions.json"), join(home, "catalog-state.json")]);
    expect(existsSync(join(home, "actions.json"))).toBe(false);
    expect(existsSync(join(home, "catalog-state.json"))).toBe(false);
  });

  it("returns [] when nothing is there", () => {
    expect(removeObsoleteFiles(tempHome())).toEqual([]);
  });

  it("logs a file it could not remove and carries on with the rest", () => {
    const home = tempHome();
    // A non-empty directory under the obsolete name: rmSync without recursive refuses it.
    mkdirSync(join(home, "actions.json"));
    writeFileSync(join(home, "actions.json", "inner"), "x");
    writeFileSync(join(home, "catalog-state.json"), "{}");
    const log = mock((_line: string) => {});

    const removed = removeObsoleteFiles(home, log);

    expect(removed).toEqual([join(home, "catalog-state.json")]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toStartWith(`[cleanup] could not remove ${join(home, "actions.json")}: `);
  });

  it("leaves unrelated files untouched", () => {
    const home = tempHome();
    mkdirSync(join(home, "downloads"));
    mkdirSync(join(home, "extension"));
    const keep = ["config.json", "downloads/x.bin", "extension/manifest.json", "notes.txt"].map((p) => join(home, p));
    for (const p of keep) writeFileSync(p, "x");
    writeFileSync(join(home, "actions.json"), "{}");
    removeObsoleteFiles(home);
    for (const p of keep) expect(existsSync(p)).toBe(true);
  });
});
