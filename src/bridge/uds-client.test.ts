// src/bridge/uds-client.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Daemon } from "./daemon.js";
import { UdsClient } from "./uds-client.js";

describe("UdsClient", () => {
  it("connects to a running daemon and proxies a call", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const d = new Daemon({ port: 39960, token: "t", sockPath: sock, portals: { acme: { origin: "https://acme.bitrix24.ru" } } });
    await d.start();

    const ws = new WebSocket("ws://127.0.0.1:39960", { headers: { origin: "https://acme.bitrix24.ru" } });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: "t" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "call") ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: 42 }));
    });
    await new Promise((r) => setTimeout(r, 50));

    const client = new UdsClient({ sockPath: sock });
    await client.connect();
    const res = await client.call("acme", { endpoint: "/x", action: null, method: "POST", params: {} });
    expect(res).toBe(42);
    client.close();
    await d.stop();
  });

  it("spawns the daemon when none is running", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    let started: Daemon | undefined;
    const client = new UdsClient({
      sockPath: sock,
      spawnDaemon: () => {
        started = new Daemon({ port: 39961, token: "t", sockPath: sock, portals: { d: { origin: "https://d.bitrix24.ru" } } });
        started.start();
      },
      connectTimeoutMs: 3000,
    });
    await client.connect();       // must not throw — daemon comes up
    client.close();
    await started!.stop();
  });
});
