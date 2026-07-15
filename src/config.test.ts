import { describe, it, expect } from "bun:test";
import { isAbsolute } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

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

  it("anchors a relative catalog path at the project root", () => {
    const cfg = loadConfig({
      BITRIX_MCP_TOKEN: "secret",
      BITRIX_ORIGIN: "https://portal.bitrix24.ru",
      BITRIX24_MCP_BRIDGE_HOME: "/tmp/br24-does-not-exist",
    });
    expect(isAbsolute(cfg.catalogPath)).toBe(true);
    expect(cfg.catalogPath.endsWith("/actions.json")).toBe(true);
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
});
