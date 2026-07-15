import { describe, it, expect } from "bun:test";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("reads token, origin, port and catalog path", () => {
    const cfg = loadConfig({
      BITRIX_MCP_TOKEN: "secret",
      BITRIX_ORIGIN: "https://portal.bitrix24.ru",
      BITRIX_MCP_PORT: "39917",
      BITRIX_CATALOG: "/tmp/actions.json",
    });
    expect(cfg).toEqual({
      token: "secret",
      bitrixOrigin: "https://portal.bitrix24.ru",
      port: 39917,
      catalogPath: "/tmp/actions.json",
    });
  });

  it("strips a trailing slash from the origin", () => {
    const cfg = loadConfig({
      BITRIX_MCP_TOKEN: "secret",
      BITRIX_ORIGIN: "https://example.bitrix24.ru/",
    });
    expect(cfg.bitrixOrigin).toBe("https://example.bitrix24.ru");
  });

  it("throws when token is missing", () => {
    expect(() => loadConfig({ BITRIX_ORIGIN: "https://x.bitrix24.ru" })).toThrow(/token/i);
  });

  it("throws when origin is missing", () => {
    expect(() => loadConfig({ BITRIX_MCP_TOKEN: "secret" })).toThrow(/origin/i);
  });
});
