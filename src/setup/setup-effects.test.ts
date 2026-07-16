import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "../bridge/frame.js";
import { createInitialConfig } from "./config-core.js";
import { applyEffects } from "./setup.js";
import type { RuntimePaths } from "../paths.js";

function startFakeUdsServer(sockPath: string, onMessage: (msg: any, sock: Socket) => void): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((sock) => {
      const dec = new FrameDecoder();
      sock.on("data", (chunk) => { for (const msg of dec.push(chunk)) onMessage(msg, sock); });
    });
    server.listen(sockPath, () => resolve(server));
  });
}

function makePaths(sock: string): RuntimePaths {
  const home = mkdtempSync(join(tmpdir(), "br24setup-eff-"));
  return {
    home,
    configJson: join(home, "config.json"),
    actionsJson: join(home, "actions.json"),
    sock,
    lock: join(home, "bridge.lock"),
    extensionDir: join(home, "extension"),
  };
}

function captureStdout(): { text: () => string; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout.write as unknown) = (chunk: any) => { buf += chunk.toString(); return true; };
  return { text: () => buf, restore: () => { process.stdout.write = original; } };
}

const config = () => createInitialConfig({ origin: "https://acme.bitrix24.ru", alias: "acme" });

describe("applyEffects — restart-daemon message branches on a real ack", () => {
  it("reports a stopped daemon when the shutdown is acked", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const server = await startFakeUdsServer(sock, (msg, s) => {
      if (msg.type === "shutdown") s.write(encodeFrame({ type: "result", id: msg.id, ok: true, data: { stopping: true } }));
    });
    const paths = makePaths(sock);
    const capture = captureStdout();
    try {
      await applyEffects(paths, config(), { config: config(), effects: ["restart-daemon"], message: "did the thing" });
    } finally {
      capture.restore();
      server.close();
    }
    expect(capture.text()).toMatch(/daemon остановлен/);
  });

  it("reports no daemon found (does not claim success) when nothing is listening", async () => {
    const paths = makePaths(join(mkdtempSync(join(tmpdir(), "br24c-")), "no-daemon.sock"));
    const capture = captureStdout();
    try {
      await applyEffects(paths, config(), { config: config(), effects: ["restart-daemon"], message: "did the thing" });
    } finally {
      capture.restore();
    }
    expect(capture.text()).toMatch(/daemon не найден/);
    expect(capture.text()).not.toMatch(/daemon остановлен/);
  });
});
