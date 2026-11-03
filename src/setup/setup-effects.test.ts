import { describe, it, expect } from "bun:test";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "../bridge/frame.js";
import { createInitialConfig } from "./config-core.js";
import { applyEffects, mutationsLine } from "./setup.js";
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
    sock,
    lock: join(home, "bridge.lock"),
    extensionDir: join(home, "extension"),
    downloadsDir: join(home, "downloads"),
  };
}

function captureStdout(): { text: () => string; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout.write as unknown) = (chunk: any) => { buf += chunk.toString(); return true; };
  return { text: () => buf, restore: () => { process.stdout.write = original; } };
}

const config = () => createInitialConfig({ origin: "https://acme.bitrix24.ru", alias: "acme" });

describe("applyEffects — restart-daemon message follows what the stop achieved", () => {
  it("reports a stopped daemon once its socket is gone", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    const server = await startFakeUdsServer(sock, (msg, s) => {
      if (msg.type !== "shutdown") return;
      s.write(encodeFrame({ type: "result", id: msg.id, ok: true, data: { stopping: true } }));
      setTimeout(() => unlinkSync(sock), 50);
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

  it("reports a stopped daemon even when another client's stop got there first", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    // The daemon refuses a second shutdown but still goes away.
    const server = await startFakeUdsServer(sock, (msg, s) => {
      if (msg.type !== "shutdown") return;
      s.write(encodeFrame({ type: "result", id: msg.id, ok: false, error: "already stopping" }));
      setTimeout(() => unlinkSync(sock), 50);
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

  it("says the daemon did not stop when its socket stays in place", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "br24c-")), "bridge.sock");
    writeFileSync(sock, "");
    const paths = makePaths(sock);
    const capture = captureStdout();
    try {
      await applyEffects(paths, config(), { config: config(), effects: ["restart-daemon"], message: "did the thing" }, 200);
    } finally {
      capture.restore();
    }
    expect(capture.text()).toMatch(/daemon не остановился/);
    expect(capture.text()).not.toMatch(/daemon остановлен/);
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

describe("mutationsLine", () => {
  const withMutations = (mutations: boolean | undefined) => ({ ...config(), mutations });

  it("shows the config.json value when the env var is not set", () => {
    expect(mutationsLine(withMutations(undefined), undefined)).toBe("Mutations: on");
    expect(mutationsLine(withMutations(false), "")).toBe("Mutations: off");
  });

  it("shows the effective value and its source when the env var overrides config.json", () => {
    expect(mutationsLine(withMutations(true), "off")).toBe("Mutations: off (env BITRIX_MCP_MUTATIONS overrides config.json)");
    expect(mutationsLine(withMutations(false), " ON ")).toBe("Mutations: on (env BITRIX_MCP_MUTATIONS overrides config.json)");
  });

  it("flags an env value the bridge would reject", () => {
    expect(mutationsLine(withMutations(true), "yes")).toBe('Mutations: on (config.json); BITRIX_MCP_MUTATIONS="yes" is invalid, expected "on" or "off"');
  });
});
