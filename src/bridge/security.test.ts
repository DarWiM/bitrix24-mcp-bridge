import { describe, it, expect, afterEach } from "bun:test";
import { Bridge } from "./server.js";
import { AddressInfo } from "node:net";
import WebSocket from "ws";

let bridge: Bridge;
afterEach(async () => { await bridge?.stop(); });

describe("bridge is loopback-only", () => {
  it("binds to 127.0.0.1", async () => {
    bridge = new Bridge({ port: 39940, token: "t" });
    await bridge.start();
    // @ts-expect-error reach into the underlying server for the bound address
    const addr = bridge["wss"].address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });

  it("closes a socket sending a wrong token even on loopback", async () => {
    bridge = new Bridge({ port: 39941, token: "right" });
    await bridge.start();
    const ws = new WebSocket("ws://127.0.0.1:39941");
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: "wrong" }));
    const closed = await new Promise<boolean>((res) => {
      ws.on("close", () => res(true));
      setTimeout(() => res(false), 500);
    });
    expect(closed).toBe(true);
  });
});
