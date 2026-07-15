import { expect, test, describe } from "bun:test";
import {
  parseConfig,
  buildSessidRequest,
  buildSessidResponse,
  parseSessidRequest,
  parseSessidResponse,
  BRIDGE_MSG_SOURCE,
} from "./bridge-protocol.ts";

describe("parseConfig", () => {
  test("parses a valid {token, port} document", () => {
    expect(parseConfig('{"token":"abc123","port":39917}')).toEqual({
      token: "abc123",
      port: 39917,
    });
  });

  test("coerces a numeric string port", () => {
    expect(parseConfig('{"token":"abc","port":"40000"}')).toEqual({
      token: "abc",
      port: 40000,
    });
  });

  test("ignores unknown extra keys", () => {
    expect(parseConfig('{"token":"t","port":1,"extra":true}')).toEqual({
      token: "t",
      port: 1,
    });
  });

  test("throws on invalid JSON", () => {
    expect(() => parseConfig("not json")).toThrow(/config\.json/i);
  });

  test("throws on a missing or empty token", () => {
    expect(() => parseConfig('{"port":39917}')).toThrow(/token/i);
    expect(() => parseConfig('{"token":"","port":39917}')).toThrow(/token/i);
  });

  test("throws on a missing or non-numeric port", () => {
    expect(() => parseConfig('{"token":"t"}')).toThrow(/port/i);
    expect(() => parseConfig('{"token":"t","port":"x"}')).toThrow(/port/i);
  });

  test("throws when the document is not an object", () => {
    expect(() => parseConfig("42")).toThrow(/config\.json/i);
    expect(() => parseConfig("null")).toThrow(/config\.json/i);
  });
});

describe("sessid postMessage protocol", () => {
  test("builds a tagged request carrying the nonce", () => {
    expect(buildSessidRequest("n1")).toEqual({
      source: BRIDGE_MSG_SOURCE,
      kind: "sessid-request",
      nonce: "n1",
    });
  });

  test("builds a tagged response carrying the nonce and sessid", () => {
    expect(buildSessidResponse("n1", "SID")).toEqual({
      source: BRIDGE_MSG_SOURCE,
      kind: "sessid-response",
      nonce: "n1",
      sessid: "SID",
    });
  });

  test("parseSessidRequest accepts a well-formed request", () => {
    const msg = buildSessidRequest("n2");
    expect(parseSessidRequest(msg)).toEqual(msg);
  });

  test("parseSessidRequest rejects responses, foreign sources, and junk", () => {
    expect(parseSessidRequest(buildSessidResponse("n2", "SID"))).toBeNull();
    expect(parseSessidRequest({ source: "someone-else", kind: "sessid-request", nonce: "n" })).toBeNull();
    expect(parseSessidRequest(null)).toBeNull();
    expect(parseSessidRequest("string")).toBeNull();
    expect(parseSessidRequest({ source: BRIDGE_MSG_SOURCE, kind: "sessid-request" })).toBeNull();
  });

  test("parseSessidResponse accepts only the matching nonce", () => {
    const msg = buildSessidResponse("n3", "SID");
    expect(parseSessidResponse(msg, "n3")).toEqual(msg);
    expect(parseSessidResponse(msg, "other")).toBeNull();
  });

  test("parseSessidResponse rejects requests, foreign sources, and junk", () => {
    expect(parseSessidResponse(buildSessidRequest("n3"), "n3")).toBeNull();
    expect(parseSessidResponse({ source: "x", kind: "sessid-response", nonce: "n3", sessid: "S" }, "n3")).toBeNull();
    expect(parseSessidResponse(undefined, "n3")).toBeNull();
    expect(parseSessidResponse({ source: BRIDGE_MSG_SOURCE, kind: "sessid-response", nonce: "n3" }, "n3")).toBeNull();
  });
});
