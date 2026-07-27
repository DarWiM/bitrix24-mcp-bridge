import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializedVersion, refreshMaterializedExtension } from "./config-core.js";
import type { ServerConfig } from "./config-core.js";

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const config: ServerConfig = {
  token: "t".repeat(64),
  port: 39917,
  defaultPortal: "acme",
  portals: { acme: { origin: "https://acme.bitrix24.ru" } },
};

function installed(manifestVersion: string | null): { home: string; staticExtDir: string } {
  const home = mkdtempSync(join(tmpdir(), "br24-ext-"));
  temps.push(home);
  const staticExtDir = join(home, "package-dist");
  mkdirSync(staticExtDir, { recursive: true });
  for (const name of ["connector.js", "sessid-shim.js"]) writeFileSync(join(staticExtDir, name), `// ${name} v2`);
  if (manifestVersion !== null) {
    mkdirSync(join(home, "extension"), { recursive: true });
    writeFileSync(join(home, "extension", "manifest.json"), JSON.stringify({ version: manifestVersion }));
    writeFileSync(join(home, "extension", "connector.js"), "// old bundle");
  }
  return { home, staticExtDir };
}

describe("materializedVersion", () => {
  it("reads the version stamped into the materialized manifest", () => {
    const { home } = installed("0.2.1");
    expect(materializedVersion(home)).toBe("0.2.1");
  });

  it("returns null when nothing is materialized or the manifest is unreadable", () => {
    const { home } = installed(null);
    expect(materializedVersion(home)).toBeNull();
    mkdirSync(join(home, "extension"), { recursive: true });
    writeFileSync(join(home, "extension", "manifest.json"), "{ broken");
    expect(materializedVersion(home)).toBeNull();
  });
});

describe("refreshMaterializedExtension", () => {
  // Tests run unbundled, so PACKAGE_VERSION is the dev sentinel — which must be a no-op:
  // a dev checkout has no business overwriting a real installation.
  it("does nothing outside a release build, whatever is installed", () => {
    const { home, staticExtDir } = installed("0.2.1");
    expect(refreshMaterializedExtension({ home, config, staticExtDir })).toBeNull();
    expect(readFileSync(join(home, "extension", "connector.js"), "utf8")).toBe("// old bundle");
  });

  it("leaves an install that was never set up here alone", () => {
    const { home, staticExtDir } = installed(null);
    expect(refreshMaterializedExtension({ home, config, staticExtDir })).toBeNull();
    expect(existsSync(join(home, "extension"))).toBe(false);
  });
});
