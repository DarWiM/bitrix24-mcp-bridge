import { describe, it, expect } from "bun:test";
import { HELP } from "./help.js";

describe("HELP (api-notes)", () => {
  it("loads non-empty api notes at dev time (reads docs/api-notes.md)", () => {
    expect(HELP.length).toBeGreaterThan(0);
    // must be the real notes, not the not-found fallback sentence
    expect(HELP).not.toMatch(/not found at runtime/);
  });
});
