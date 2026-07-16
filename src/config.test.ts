import { describe, it, expect } from "bun:test";
import { isAbsolute } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadConfigState } from "./config.js";
import { runtimePaths } from "./paths.js";
import { createInitialConfig, writeServerConfig } from "./setup/config-core.js";
import { loadCatalog } from "./catalog/catalog.js";

describe("loadConfig", () => {
  it("builds a single-portal config from env (dev)", () => {
    const cfg = loadConfig({
      BITRIX_MCP_TOKEN: "secret",
      BITRIX_ORIGIN: "https://portal.bitrix24.ru/",
      BITRIX24_MCP_BRIDGE_HOME: "/tmp/br24-does-not-exist",
    });
    expect(cfg.token).toBe("secret");
    expect(cfg.defaultPortal).toBe("default");
    expect(cfg.portals.default.origin).toBe("https://portal.bitrix24.ru");
    expect(cfg.bitrixOrigin).toBe("https://portal.bitrix24.ru");
    expect(cfg.allowedOrigins).toEqual(["https://portal.bitrix24.ru"]);
    expect(cfg.port).toBe(39917);
  });

  it("reads portals from config.json and lets env override the token", () => {
    const home = mkdtempSync(join(tmpdir(), "br24-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      token: "file-token",
      port: 40000,
      defaultPortal: "acme",
      portals: {
        acme: { origin: "https://acme.bitrix24.ru" },
        beta: { origin: "https://beta.bitrix24.ru" },
      },
    }));
    const cfg = loadConfig({ BITRIX24_MCP_BRIDGE_HOME: home, BITRIX_MCP_TOKEN: "env-token" });
    expect(cfg.token).toBe("env-token");        // env wins
    expect(cfg.port).toBe(40000);               // from file
    expect(cfg.defaultPortal).toBe("acme");
    expect(cfg.allowedOrigins.sort()).toEqual(
      ["https://acme.bitrix24.ru", "https://beta.bitrix24.ru"],
    );
    expect(cfg.bitrixOrigin).toBe("https://acme.bitrix24.ru");
  });

  it("anchors an explicit relative catalog path at the project root", () => {
    const cfg = loadConfig({
      BITRIX_MCP_TOKEN: "secret",
      BITRIX_ORIGIN: "https://portal.bitrix24.ru",
      BITRIX24_MCP_BRIDGE_HOME: "/tmp/br24-does-not-exist",
      BITRIX_CATALOG: "actions.json",
    });
    expect(isAbsolute(cfg.catalogPath)).toBe(true);
    expect(cfg.catalogPath.endsWith("/actions.json")).toBe(true);
    expect(cfg.catalogPath).not.toBe(runtimePaths({ BITRIX24_MCP_BRIDGE_HOME: "/tmp/br24-does-not-exist" }).actionsJson);
  });

  it("defaults the catalog path to the runtime home when nothing is configured", () => {
    const env = { BITRIX24_MCP_BRIDGE_HOME: "/tmp/br24-does-not-exist" };
    const cfg = loadConfig({
      BITRIX_MCP_TOKEN: "secret",
      BITRIX_ORIGIN: "https://portal.bitrix24.ru",
      ...env,
    });
    expect(cfg.catalogPath).toBe(runtimePaths(env).actionsJson);
  });

  it("end-to-end: a setup-seeded actions.json at the runtime home is the catalog loadConfig resolves and loadCatalog can read", () => {
    const home = mkdtempSync(join(tmpdir(), "br24-e2e-"));
    const serverConfig = createInitialConfig({ origin: "https://acme.bitrix24.ru", alias: "acme" });
    writeServerConfig(home, serverConfig);
    writeFileSync(join(home, "actions.json"), JSON.stringify({ ping: { action: "ping" } }));

    const cfg = loadConfig({ BITRIX24_MCP_BRIDGE_HOME: home });
    expect(cfg.catalogPath).toBe(join(home, "actions.json"));
    expect(() => loadCatalog(cfg.catalogPath)).not.toThrow();
  });

  it("throws when no token is available", () => {
    expect(() => loadConfig({
      BITRIX_ORIGIN: "https://x.bitrix24.ru",
      BITRIX24_MCP_BRIDGE_HOME: "/tmp/br24-does-not-exist",
    })).toThrow(/token/i);
  });

  it("throws when no portal origin is available", () => {
    expect(() => loadConfig({
      BITRIX_MCP_TOKEN: "secret",
      BITRIX24_MCP_BRIDGE_HOME: "/tmp/br24-does-not-exist",
    })).toThrow(/portal|origin/i);
  });

  it("throws a descriptive error when a config.json portal is missing origin", () => {
    const home = mkdtempSync(join(tmpdir(), "br24-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      token: "file-token",
      portals: {
        acme: { catalog: "acme.json" },
      },
    }));
    expect(() => loadConfig({ BITRIX24_MCP_BRIDGE_HOME: home })).toThrow(/origin/i);
  });
});

describe("loadConfigState", () => {
  it("returns configured state when a token + portal are present", () => {
    const state = loadConfigState({
      BITRIX_MCP_TOKEN: "secret",
      BITRIX_ORIGIN: "https://portal.bitrix24.ru",
      BITRIX24_MCP_BRIDGE_HOME: "/tmp/br24-does-not-exist",
    });
    expect(state.status).toBe("configured");
    if (state.status === "configured") {
      expect(state.config.token).toBe("secret");
    }
  });

  it("returns unconfigured state (not a throw) when nothing is configured", () => {
    const state = loadConfigState({ BITRIX24_MCP_BRIDGE_HOME: "/tmp/br24-does-not-exist" });
    expect(state.status).toBe("unconfigured");
    if (state.status === "unconfigured") {
      expect(state.reason).toMatch(/token|portal|origin/i);
    }
  });
});
