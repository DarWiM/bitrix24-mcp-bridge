import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHar } from "./har-parse.js";

const har = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/sample.har", import.meta.url)), "utf8"),
);

describe("parseHar", () => {
  it("captures JSON/session API calls, classifies transport, drops static", () => {
    const calls = parseHar(har);
    expect(calls).toHaveLength(2);

    const ajax = calls.find((c) => c.transport === "ajax")!;
    expect(ajax.action).toBe("tasks.task.list");
    expect(ajax.endpoint).toBe("/bitrix/services/main/ajax.php");
    expect(ajax.params).toEqual({ "params[ORDER][ID]": "desc" }); // sessid stripped

    const rest = calls.find((c) => c.transport === "rest")!;
    expect(rest.endpoint).toBe("/rest/im.recent.list");
    expect(rest.action).toBeNull();
  });
});
