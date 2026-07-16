import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PORT,
  createInitialConfig,
  readServerConfig,
  writeServerConfig,
  addPortal,
  removePortal,
  setPort,
  rotateToken,
  setDefaultPortal,
} from "./config-core.js";

describe("createInitialConfig", () => {
  it("generates a 64-hex token, single portal, matching defaultPortal, default port", () => {
    const cfg = createInitialConfig({ origin: "https://acme.bitrix24.ru/", alias: "acme" });
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.defaultPortal).toBe("acme");
    expect(cfg.portals).toEqual({ acme: { origin: "https://acme.bitrix24.ru" } }); // trailing slash stripped
  });

  it("honors an explicit port", () => {
    const cfg = createInitialConfig({ origin: "https://acme.bitrix24.ru", alias: "acme", port: 40000 });
    expect(cfg.port).toBe(40000);
  });

  it("rejects an invalid alias and a non-http origin", () => {
    expect(() => createInitialConfig({ origin: "https://x.bitrix24.ru", alias: "bad alias" })).toThrow(/alias/i);
    expect(() => createInitialConfig({ origin: "ftp://x", alias: "acme" })).toThrow(/origin/i);
  });
});

describe("read/write server config", () => {
  it("returns null when no config.json exists", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-"));
    expect(readServerConfig(home)).toBeNull();
  });

  it("round-trips pretty JSON with a trailing newline", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-"));
    const cfg = { token: "deadbeef", port: 39917, defaultPortal: "acme", portals: { acme: { origin: "https://acme.bitrix24.ru" } } };
    writeServerConfig(home, cfg);
    const raw = readFileSync(join(home, "config.json"), "utf8");
    expect(raw).toBe(JSON.stringify(cfg, null, 2) + "\n");
    expect(readServerConfig(home)).toEqual(cfg);
  });
});

import { mkdtempSync as _mkdtempSync, writeFileSync as _writeFileSync, mkdirSync as _mkdirSync, readFileSync as _readFileSync } from "node:fs";
import { buildManifest, materializeExtension } from "./config-core.js";

describe("buildManifest", () => {
  it("lists exactly the configured origins for one portal", () => {
    const cfg = createInitialConfig({ origin: "https://acme.bitrix24.ru", alias: "acme" });
    const m = buildManifest(cfg);
    expect(m.manifest_version).toBe(3);
    expect(m.host_permissions).toEqual(["https://acme.bitrix24.ru/*"]);
    expect(m.content_scripts[0]).toEqual({ matches: ["https://acme.bitrix24.ru/*"], js: ["connector.js"], world: "ISOLATED", run_at: "document_idle" });
    expect(m.content_scripts[1]).toEqual({ matches: ["https://acme.bitrix24.ru/*"], js: ["sessid-shim.js"], world: "MAIN", run_at: "document_idle" });
    expect(m.web_accessible_resources).toEqual([{ resources: ["config.json"], matches: ["https://acme.bitrix24.ru/*"], use_dynamic_url: true }]);
  });

  it("lists both origins for two portals across matches/host_permissions/WAR", () => {
    const two = addPortal(createInitialConfig({ origin: "https://acme.bitrix24.ru", alias: "acme" }), { alias: "beta", origin: "https://beta.bitrix24.ru" });
    const m = buildManifest(two);
    const expected = ["https://acme.bitrix24.ru/*", "https://beta.bitrix24.ru/*"];
    expect(m.host_permissions).toEqual(expected);
    expect(m.content_scripts[0].matches).toEqual(expected);
    expect(m.content_scripts[1].matches).toEqual(expected);
    expect(m.web_accessible_resources[0].matches).toEqual(expected);
  });
});

describe("materializeExtension", () => {
  it("copies static bundles, writes extension config.json + manifest.json", () => {
    const staticExtDir = _mkdtempSync(join(tmpdir(), "cc-static-"));
    for (const name of ["connector.js", "sessid-shim.js", "connector.js.map", "sessid-shim.js.map"]) {
      _writeFileSync(join(staticExtDir, name), `// ${name}\n`);
    }
    const home = _mkdtempSync(join(tmpdir(), "cc-home-"));
    const cfg = createInitialConfig({ origin: "https://acme.bitrix24.ru", alias: "acme" });
    const dest = materializeExtension({ home, config: cfg, staticExtDir });

    expect(dest).toBe(join(home, "extension"));
    expect(_readFileSync(join(dest, "connector.js"), "utf8")).toBe("// connector.js\n");
    expect(_readFileSync(join(dest, "sessid-shim.js.map"), "utf8")).toBe("// sessid-shim.js.map\n");
    expect(JSON.parse(_readFileSync(join(dest, "config.json"), "utf8"))).toEqual({ token: cfg.token, port: cfg.port });
    const manifest = JSON.parse(_readFileSync(join(dest, "manifest.json"), "utf8"));
    expect(manifest.content_scripts[0].matches).toEqual(["https://acme.bitrix24.ru/*"]);
  });

  it("throws a helpful error when a static bundle is missing", () => {
    const staticExtDir = _mkdtempSync(join(tmpdir(), "cc-empty-"));
    const home = _mkdtempSync(join(tmpdir(), "cc-home2-"));
    const cfg = createInitialConfig({ origin: "https://acme.bitrix24.ru", alias: "acme" });
    expect(() => materializeExtension({ home, config: cfg, staticExtDir })).toThrow(/bundle missing/i);
  });
});

describe("mutators (immutable)", () => {
  const base = () => createInitialConfig({ origin: "https://acme.bitrix24.ru", alias: "acme" });

  it("addPortal adds and strips slash; rejects duplicates", () => {
    const next = addPortal(base(), { alias: "beta", origin: "https://beta.bitrix24.ru/", catalog: "beta.json" });
    expect(next.portals.beta).toEqual({ origin: "https://beta.bitrix24.ru", catalog: "beta.json" });
    expect(next.defaultPortal).toBe("acme"); // unchanged
    expect(() => addPortal(next, { alias: "acme", origin: "https://x.bitrix24.ru" })).toThrow(/exists/i);
  });

  it("removePortal reassigns defaultPortal when it removed the default", () => {
    const two = addPortal(base(), { alias: "beta", origin: "https://beta.bitrix24.ru" });
    const next = removePortal(two, "acme");
    expect(Object.keys(next.portals)).toEqual(["beta"]);
    expect(next.defaultPortal).toBe("beta");
  });

  it("removePortal refuses the last portal and unknown aliases", () => {
    expect(() => removePortal(base(), "acme")).toThrow(/only portal/i);
    expect(() => removePortal(base(), "nope")).toThrow(/does not exist/i);
  });

  it("setPort validates the range", () => {
    expect(setPort(base(), 40000).port).toBe(40000);
    expect(() => setPort(base(), 0)).toThrow(/port/i);
    expect(() => setPort(base(), 70000)).toThrow(/port/i);
  });

  it("rotateToken changes the token, keeps everything else", () => {
    const before = base();
    const after = rotateToken(before);
    expect(after.token).not.toBe(before.token);
    expect(after.token).toMatch(/^[0-9a-f]{64}$/);
    expect(after.portals).toEqual(before.portals);
  });

  it("setDefaultPortal validates the alias", () => {
    const two = addPortal(base(), { alias: "beta", origin: "https://beta.bitrix24.ru" });
    expect(setDefaultPortal(two, "beta").defaultPortal).toBe("beta");
    expect(() => setDefaultPortal(two, "nope")).toThrow(/does not exist/i);
  });
});
