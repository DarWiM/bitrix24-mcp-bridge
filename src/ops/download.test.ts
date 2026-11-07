import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOWNLOADS_WARN_BYTES,
  downloadsWarning,
  fileNameFromUrl,
  finalizeDownload,
  resolveDestination,
  resolvePortalUrl,
  safeFileName,
  tempDownloadPath,
} from "./download.js";

const ORIGINS = { acme: "https://acme.bitrix24.ru", other: "https://other.bitrix24.ru" };
const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "br24-dl-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("resolvePortalUrl", () => {
  it("maps a portal URL to its alias and a call endpoint", () => {
    expect(resolvePortalUrl("https://acme.bitrix24.ru/bitrix/services/main/ajax.php?action=disk.api.file.download&fileId=1", ORIGINS))
      .toEqual({ portal: "acme", endpoint: "/bitrix/services/main/ajax.php?action=disk.api.file.download&fileId=1" });
  });

  it("picks the alias the URL actually belongs to", () => {
    expect(resolvePortalUrl("https://other.bitrix24.ru/bitrix/tools/disk/uf.php?action=show&attachedId=1", ORIGINS).portal).toBe("other");
  });

  it.each([
    "https://acme.bitrix24.ru/bitrix/services/main/ajax.php?action=disk.api.file.download&fileId=1",
    "https://acme.bitrix24.ru/bitrix/services/main/ajax.php?action=disk.attachedObject.download&SITE_ID=s1&attachedObjectId=21571&_efd=x",
    "https://acme.bitrix24.ru/bitrix/services/main/ajax.php?action=call.Track.download&callId=7",
    "https://acme.bitrix24.ru/bitrix/tools/disk/uf.php?attachedId=701&action=download&ncc=1",
    "https://acme.bitrix24.ru/bitrix/tools/disk/uf.php?action=show&attachedId=701",
    "https://acme.bitrix24.ru/bitrix/tools/disk/uf.php?action=downloadArchiveByEntity&entityId=1",
  ])("accepts file link %s", (url) => {
    expect(resolvePortalUrl(url, ORIGINS).portal).toBe("acme");
  });

  it.each([
    ["https://acme.bitrix24.ru/company/personal/user/55/", "/company/personal/user/55/?action=none"],
    ["https://acme.bitrix24.ru/bitrix/services/main/ajax.php?action=tasks.task.delete", "/bitrix/services/main/ajax.php?action=tasks.task.delete"],
    ["https://acme.bitrix24.ru/bitrix/tools/disk/uf.php?action=delete", "/bitrix/tools/disk/uf.php?action=delete"],
    ["https://acme.bitrix24.ru/bitrix/tools/disk/uf.php?action=disk.api.file.download", "/bitrix/tools/disk/uf.php?action=disk.api.file.download"],
    ["https://acme.bitrix24.ru/bitrix/services/main/ajax.php", "/bitrix/services/main/ajax.php?action=none"],
  ])("refuses non-file link %s", (url, shown) => {
    expect(() => resolvePortalUrl(url, ORIGINS)).toThrow(`refusing to download ${shown} — not a portal file link`);
  });

  it.each([
    "https://acme.bitrix24.ru/bitrix/tools/disk/uf.php?action=download&action=delete",
    "https://acme.bitrix24.ru/bitrix/tools/disk/uf.php?action=delete&action=download",
    "https://acme.bitrix24.ru/bitrix/services/main/ajax.php?action=disk.api.file.download&action=tasks.task.delete",
    "https://acme.bitrix24.ru/bitrix/tools/disk/uf.php?action[]=download",
    "https://acme.bitrix24.ru/bitrix/tools/disk/uf.php?action=download&action[]=delete",
    "https://acme.bitrix24.ru/bitrix/tools/disk/uf.php?action=Download",
  ])("refuses ambiguous or case-mismatched action %s", (url) => {
    expect(() => resolvePortalUrl(url, ORIGINS)).toThrow(/not a portal file link/);
  });

  it("refuses a host that is not a configured portal", () => {
    expect(() => resolvePortalUrl("https://evil.example/steal", ORIGINS)).toThrow(/not a configured portal/);
  });

  it("refuses a look-alike host", () => {
    expect(() => resolvePortalUrl("https://acme.bitrix24.ru.evil.example/x", ORIGINS)).toThrow(/not a configured portal/);
  });

  it("refuses a relative path (the caller must pass the portal-minted URL)", () => {
    expect(() => resolvePortalUrl("/bitrix/services/main/ajax.php?action=x", ORIGINS)).toThrow(/not an absolute URL/);
  });
});

describe("safeFileName", () => {
  it("keeps a normal name, spaces and all", () => {
    expect(safeFileName("image (29).png", "fallback")).toBe("image (29).png");
  });

  it("strips directory traversal", () => {
    expect(safeFileName("../../etc/passwd", "fallback")).toBe("passwd");
    expect(safeFileName("..", "fallback")).toBe("fallback");
  });

  it("drops control characters and falls back on an empty result", () => {
    expect(safeFileName("a\u0000b\u001fc.txt", "fallback")).toBe("abc.txt");
    expect(safeFileName("   ", "fallback")).toBe("fallback");
  });
});

describe("fileNameFromUrl", () => {
  it("prefers the fileName query param the portal adds", () => {
    expect(fileNameFromUrl("https://acme.bitrix24.ru/ajax.php?action=x&fileName=image%20%2829%29.png", "fb")).toBe("image (29).png");
  });

  it("falls back to the last path segment when it looks like a file", () => {
    expect(fileNameFromUrl("https://acme.bitrix24.ru/upload/report.pdf", "fb")).toBe("report.pdf");
  });

  it("uses the fallback for an opaque endpoint", () => {
    expect(fileNameFromUrl("https://acme.bitrix24.ru/bitrix/services/main/ajax.php?action=call.Track.download", "call-7.mp3")).toBe("call-7.mp3");
  });
});

describe("resolveDestination", () => {
  it("defaults to the downloads dir with the suggested name", () => {
    const dir = tempDir();
    expect(resolveDestination({ downloadsDir: dir, suggestedName: "photo.png" })).toBe(join(dir, "photo.png"));
  });

  it("honours an absolute savePath as given", () => {
    const dir = tempDir();
    expect(resolveDestination({ downloadsDir: dir, suggestedName: "photo.png", savePath: "/tmp/exact.png" })).toBe("/tmp/exact.png");
  });

  it("treats a relative savePath as a name inside the downloads dir", () => {
    const dir = tempDir();
    expect(resolveDestination({ downloadsDir: dir, suggestedName: "photo.png", savePath: "../escape.png" })).toBe(join(dir, "escape.png"));
  });

  it("refuses to clobber an existing file unless overwrite is set", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "photo.png"), "old");
    expect(() => resolveDestination({ downloadsDir: dir, suggestedName: "photo.png" })).toThrow(/already exists/);
    expect(resolveDestination({ downloadsDir: dir, suggestedName: "photo.png", overwrite: true })).toBe(join(dir, "photo.png"));
  });
});

describe("tempDownloadPath", () => {
  it("stays inside the downloads dir, is hidden and unique per call", () => {
    const dir = tempDir();
    const a = tempDownloadPath(dir);
    const b = tempDownloadPath(dir);
    expect(a.startsWith(join(dir, ".download-"))).toBe(true);
    expect(a.endsWith(".part")).toBe(true);
    expect(a).not.toBe(b); // parallel downloads must not fight over one temp file
  });
});

describe("finalizeDownload", () => {
  function staged(dir: string, body = "payload"): string {
    const temp = tempDownloadPath(dir);
    writeFileSync(temp, body);
    return temp;
  }

  it("moves the temp file to the name the portal sent", () => {
    const dir = tempDir();
    const temp = staged(dir, "audio");
    const final = finalizeDownload({ tempPath: temp, serverName: "Запись звонка N1721 от 2026-07-23.ogg", fallbackName: "call-1721.mp3", downloadsDir: dir });
    expect(final).toBe(join(dir, "Запись звонка N1721 от 2026-07-23.ogg"));
    expect(existsSync(temp)).toBe(false);
    expect(readFileSync(final, "utf8")).toBe("audio");
  });

  it("falls back to the caller's name when the portal sent none", () => {
    const dir = tempDir();
    const final = finalizeDownload({ tempPath: staged(dir), serverName: null, fallbackName: "call-7.mp3", downloadsDir: dir });
    expect(final).toBe(join(dir, "call-7.mp3"));
  });

  it("refuses to re-download over an existing file and cleans up the temp", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "record.ogg"), "existing");
    const temp = staged(dir, "new");
    expect(() => finalizeDownload({ tempPath: temp, serverName: "record.ogg", fallbackName: "x.bin", downloadsDir: dir }))
      .toThrow(/already exists/);
    expect(existsSync(temp)).toBe(false); // no .part litter left behind
    expect(readFileSync(join(dir, "record.ogg"), "utf8")).toBe("existing");
  });

  it("replaces the existing file when overwrite is requested", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "record.ogg"), "existing");
    const final = finalizeDownload({ tempPath: staged(dir, "fresh"), serverName: "record.ogg", fallbackName: "x.bin", downloadsDir: dir, overwrite: true });
    expect(readFileSync(final, "utf8")).toBe("fresh");
  });

  it("sanitises a malicious server-provided name", () => {
    const dir = tempDir();
    const final = finalizeDownload({ tempPath: staged(dir), serverName: "../../evil.sh", fallbackName: "x.bin", downloadsDir: dir });
    expect(final).toBe(join(dir, "evil.sh"));
  });
});

describe("downloadsWarning", () => {
  const MB = 1024 * 1024;
  // Sparse: the size is what stat reports, nothing is written to disk.
  const sized = (path: string, bytes: number) => {
    writeFileSync(path, "");
    truncateSync(path, bytes);
  };

  it("asks to remind the user once the folder's files add up to more than 500 MB", async () => {
    const dir = tempDir();
    sized(join(dir, "call-1.mp3"), 300 * MB);
    sized(join(dir, "video.mp4"), 250 * MB);

    expect(await downloadsWarning(dir)).toBe(
      `папка загрузок моста ${dir} занимает 550 МБ — предложи пользователю удалить ненужные файлы (мост сам их не удаляет)`,
    );
  });

  it("says nothing at the threshold or below", async () => {
    const dir = tempDir();
    sized(join(dir, "a.bin"), DOWNLOADS_WARN_BYTES);

    expect(await downloadsWarning(dir)).toBeUndefined();
  });

  it("counts only the folder's own files", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "nested"));
    sized(join(dir, "nested", "big.bin"), 600 * MB);
    sized(join(dir, "small.bin"), MB);

    expect(await downloadsWarning(dir)).toBeUndefined();
  });

  it("says nothing when the folder cannot be read", async () => {
    expect(await downloadsWarning(join(tempDir(), "missing"))).toBeUndefined();
  });
});
