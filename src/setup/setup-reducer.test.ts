import { describe, it, expect } from "bun:test";
import { createInitialConfig, addPortal } from "./config-core.js";
import { applySetupCommand } from "./setup-reducer.js";

const base = () => createInitialConfig({ origin: "https://acme.bitrix24.ru", alias: "acme" });

describe("applySetupCommand", () => {
  it("add-portal → config gains the portal; reload-extension effect", () => {
    const r = applySetupCommand(base(), { kind: "add-portal", alias: "beta", origin: "https://beta.bitrix24.ru" });
    expect(r.config.portals.beta.origin).toBe("https://beta.bitrix24.ru");
    expect(r.effects).toEqual(["write-config", "materialize-extension", "reload-extension"]);
    expect(r.message).toMatch(/beta/);
  });

  it("remove-portal → reload-extension effect and default reassigned", () => {
    const two = addPortal(base(), { alias: "beta", origin: "https://beta.bitrix24.ru" });
    const r = applySetupCommand(two, { kind: "remove-portal", alias: "acme" });
    expect(Object.keys(r.config.portals)).toEqual(["beta"]);
    expect(r.config.defaultPortal).toBe("beta");
    expect(r.effects).toEqual(["write-config", "materialize-extension", "reload-extension"]);
  });

  it("set-port → reopen-tab (not reload) effect", () => {
    const r = applySetupCommand(base(), { kind: "set-port", port: 40000 });
    expect(r.config.port).toBe(40000);
    expect(r.effects).toEqual(["write-config", "materialize-extension", "reopen-tab"]);
  });

  it("rotate-token → new token, reopen-tab effect", () => {
    const before = base();
    const r = applySetupCommand(before, { kind: "rotate-token" });
    expect(r.config.token).not.toBe(before.token);
    expect(r.effects).toEqual(["write-config", "materialize-extension", "reopen-tab"]);
  });

  it("set-default → write-config only", () => {
    const two = addPortal(base(), { alias: "beta", origin: "https://beta.bitrix24.ru" });
    const r = applySetupCommand(two, { kind: "set-default", alias: "beta" });
    expect(r.config.defaultPortal).toBe("beta");
    expect(r.effects).toEqual(["write-config"]);
  });

  it("update-extension → materialize + reload, config unchanged", () => {
    const cfg = base();
    const r = applySetupCommand(cfg, { kind: "update-extension" });
    expect(r.config).toEqual(cfg);
    expect(r.effects).toEqual(["materialize-extension", "reload-extension"]);
  });

  it("propagates validation errors from the mutators", () => {
    expect(() => applySetupCommand(base(), { kind: "remove-portal", alias: "acme" })).toThrow(/only portal/i);
  });
});
