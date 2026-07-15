// src/bridge/coexist.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Daemon } from "./daemon.js";
import { UdsClient } from "./uds-client.js";

describe("multi-instance coexistence", () => {
  it("serves two concurrent clients through one daemon, no EADDRINUSE", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24x-")), "bridge.sock");
    const d = new Daemon({ port: 39970, token: "t", sockPath: sock, portals: { acme: { origin: "https://acme.bitrix24.ru" } } });
    await d.start();
    const ws = new WebSocket("ws://127.0.0.1:39970", { headers: { origin: "https://acme.bitrix24.ru" } });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: "t" }));
    ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "call") ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: m.id })); });
    await new Promise((r) => setTimeout(r, 50));

    const c1 = new UdsClient({ sockPath: sock }); await c1.connect();
    const c2 = new UdsClient({ sockPath: sock }); await c2.connect();
    const [r1, r2] = await Promise.all([
      c1.call("acme", { endpoint: "/a", action: null, method: "POST", params: {} }),
      c2.call("acme", { endpoint: "/b", action: null, method: "POST", params: {} }),
    ]);
    expect(typeof r1).toBe("string");
    expect(typeof r2).toBe("string");
    expect(r1).not.toBe(r2);
    c1.close(); c2.close(); await d.stop();
  });
});
