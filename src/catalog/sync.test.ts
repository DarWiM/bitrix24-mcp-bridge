import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCatalogSync, serializeCatalog, syncCatalogWithPackage } from "./sync.js";

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "br24-sync-"));
  temps.push(dir);
  return dir;
}

const ENTRY = { endpoint: "/call/detail/{callId}", method: "GET", responseType: "text" };

describe("planCatalogSync", () => {
  it("adds shipped entries the install has never been offered", () => {
    const plan = planCatalogSync({ "tasks.list": {} }, { "tasks.list": {}, "call.detail": ENTRY }, ["tasks.list"]);
    expect(plan.toAdd).toEqual(["call.detail"]);
    expect(plan.delivered).toEqual(["tasks.list", "call.detail"]);
  });

  it("does not resurrect an entry the user deleted after it was delivered", () => {
    // "call.detail" was delivered earlier and is now absent — that is a removal, not a gap.
    const plan = planCatalogSync({ "tasks.list": {} }, { "tasks.list": {}, "call.detail": ENTRY }, ["tasks.list", "call.detail"]);
    expect(plan.toAdd).toEqual([]);
  });

  it("never overwrites an entry the user customised", () => {
    const custom = { endpoint: "/custom", method: "POST" };
    const plan = planCatalogSync({ "call.detail": custom }, { "call.detail": ENTRY }, []);
    expect(plan.toAdd).toEqual([]);
    expect(plan.delivered).toEqual(["call.detail"]); // recorded, so a later removal sticks
  });

  it("leaves entries the user added alone", () => {
    const plan = planCatalogSync({ "my.custom": {} }, { "tasks.list": {} }, []);
    expect(plan.toAdd).toEqual(["tasks.list"]);
    expect(plan.delivered).toEqual(["tasks.list"]);
  });
});

describe("serializeCatalog", () => {
  it("keeps the one-entry-per-line layout the file is written in by hand", () => {
    const text = serializeCatalog({ "tasks.list": { action: "tasks.task.list" }, "call.detail": ENTRY });
    expect(text.split("\n")[0]).toBe("{");
    expect(text).toContain('  "tasks.list": {"action":"tasks.task.list"},\n');
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ "tasks.list": { action: "tasks.task.list" }, "call.detail": ENTRY });
  });
});

describe("syncCatalogWithPackage", () => {
  function setup(catalog: Record<string, unknown>, shipped: Record<string, unknown>) {
    const dir = home();
    const paths = {
      catalogPath: join(dir, "actions.json"),
      examplePath: join(dir, "actions.example.json"),
      statePath: join(dir, "catalog-state.json"),
    };
    writeFileSync(paths.catalogPath, serializeCatalog(catalog));
    writeFileSync(paths.examplePath, serializeCatalog(shipped));
    return paths;
  }

  it("appends new entries and records what was delivered", () => {
    const paths = setup({ "tasks.list": { action: "tasks.task.list" } }, { "tasks.list": { action: "tasks.task.list" }, "call.detail": ENTRY });

    expect(syncCatalogWithPackage(paths)).toEqual(["call.detail"]);

    expect(JSON.parse(readFileSync(paths.catalogPath, "utf8"))["call.detail"]).toEqual(ENTRY);
    expect(JSON.parse(readFileSync(paths.statePath, "utf8")).deliveredEntries).toEqual(["tasks.list", "call.detail"]);
  });

  it("is idempotent — a second run changes nothing", () => {
    const paths = setup({ "tasks.list": {} }, { "tasks.list": {}, "call.detail": ENTRY });
    syncCatalogWithPackage(paths);
    const after = readFileSync(paths.catalogPath, "utf8");

    expect(syncCatalogWithPackage(paths)).toEqual([]);
    expect(readFileSync(paths.catalogPath, "utf8")).toBe(after);
  });

  it("respects a deletion made after delivery", () => {
    const paths = setup({ "tasks.list": {} }, { "tasks.list": {}, "call.detail": ENTRY });
    syncCatalogWithPackage(paths);
    writeFileSync(paths.catalogPath, serializeCatalog({ "tasks.list": {} })); // user removes it

    expect(syncCatalogWithPackage(paths)).toEqual([]);
    expect(JSON.parse(readFileSync(paths.catalogPath, "utf8"))["call.detail"]).toBeUndefined();
  });

  it("keeps the user's own entries and edits", () => {
    const paths = setup(
      { "tasks.list": { action: "MINE" }, "my.custom": { action: "x" } },
      { "tasks.list": { action: "tasks.task.list" }, "call.detail": ENTRY },
    );

    syncCatalogWithPackage(paths);

    const merged = JSON.parse(readFileSync(paths.catalogPath, "utf8"));
    expect(merged["tasks.list"]).toEqual({ action: "MINE" });
    expect(merged["my.custom"]).toEqual({ action: "x" });
    expect(merged["call.detail"]).toEqual(ENTRY);
  });

  it("does nothing when there is no catalog yet (fresh install seeds it instead)", () => {
    const dir = home();
    const paths = {
      catalogPath: join(dir, "actions.json"),
      examplePath: join(dir, "actions.example.json"),
      statePath: join(dir, "catalog-state.json"),
    };
    writeFileSync(paths.examplePath, serializeCatalog({ "call.detail": ENTRY }));

    expect(syncCatalogWithPackage(paths)).toEqual([]);
    expect(existsSync(paths.catalogPath)).toBe(false);
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it("survives a corrupt catalog without destroying it", () => {
    const dir = home();
    const paths = {
      catalogPath: join(dir, "actions.json"),
      examplePath: join(dir, "actions.example.json"),
      statePath: join(dir, "catalog-state.json"),
    };
    writeFileSync(paths.catalogPath, "{ broken");
    writeFileSync(paths.examplePath, serializeCatalog({ "call.detail": ENTRY }));

    expect(syncCatalogWithPackage(paths)).toEqual([]);
    expect(readFileSync(paths.catalogPath, "utf8")).toBe("{ broken");
  });
});
