import { describe, it, expect } from "bun:test";
import { collectChatCalls, readMessagePage, sortCalls, type ChatCall } from "./chatCalls.js";

const startMessage = {
  id: 1961917,
  chatId: 7111,
  authorId: 21729,
  date: "2026-07-23T12:46:33+03:00",
  text: "Начат звонок №1721",
  params: { COMPONENT_ID: "CallMessage", COMPONENT_PARAMS: { messageType: "START", callId: 1721 }, NOTIFY: "N" },
};

const finishMessage = {
  id: 1962330,
  authorId: 21729,
  date: "2026-07-23T13:51:02+03:00",
  params: { COMPONENT_ID: "CallMessage", COMPONENT_PARAMS: { messageType: "FINISH", callId: 1721 } },
};

const followUpMessage = {
  id: 1962335,
  authorId: 0,
  date: "2026-07-23T13:52:10+03:00",
  text: "BitrixGPT проанализировал звонок №1721",
  params: { ATTACH: [{ BLOCKS: [{ MESSAGE: "[url=/call/detail/1721]Подробный анализ встречи[/url]" }] }] },
};

// Chat history is a mixed bag: plain messages carry params as an empty array, not an object.
const chatterMessage = { id: 1961909, authorId: 55, date: "2026-07-23T12:46:20+03:00", text: "Давайте созвонимся", params: [] };

describe("collectChatCalls", () => {
  it("picks the callId out of a CallMessage system message", () => {
    const acc = new Map<number, ChatCall>();
    collectChatCalls([startMessage, chatterMessage], acc);
    expect(sortCalls(acc)).toEqual([
      {
        callId: 1721,
        startedAt: "2026-07-23T12:46:33+03:00",
        startedBy: 21729,
        startMessageId: 1961917,
        events: [{ type: "START", messageId: 1961917, date: "2026-07-23T12:46:33+03:00" }],
        summaryMessageId: null,
      },
    ]);
  });

  it("links the BitrixGPT follow-up to the call via its /call/detail/ link", () => {
    const acc = new Map<number, ChatCall>();
    collectChatCalls([followUpMessage, finishMessage, startMessage], acc);
    const [call] = sortCalls(acc);
    expect(call.summaryMessageId).toBe(1962335);
    expect(call.events.map((e) => e.type)).toEqual(["FINISH", "START"]);
    expect(call.startMessageId).toBe(1961917);
  });

  it("merges pages without duplicating events when one is re-scanned", () => {
    const acc = new Map<number, ChatCall>();
    collectChatCalls([startMessage, finishMessage], acc);
    collectChatCalls([startMessage, finishMessage], acc);
    expect(sortCalls(acc)[0].events).toHaveLength(2);
  });

  it("keeps calls apart and sorts newest first", () => {
    const acc = new Map<number, ChatCall>();
    collectChatCalls([
      startMessage,
      { ...startMessage, id: 1970001, params: { COMPONENT_ID: "CallMessage", COMPONENT_PARAMS: { messageType: "START", callId: 1799 } } },
    ], acc);
    expect(sortCalls(acc).map((c) => c.callId)).toEqual([1799, 1721]);
  });

  it("ignores messages that are neither call events nor follow-ups", () => {
    const acc = new Map<number, ChatCall>();
    collectChatCalls([chatterMessage, { id: 1, params: { COMPONENT_ID: "SomethingElse" } }, "junk", null], acc);
    expect(sortCalls(acc)).toEqual([]);
  });
});

describe("readMessagePage", () => {
  it("reads messages, the paging flag and the oldest id (the cursor for the next page)", () => {
    const page = readMessagePage({ status: "success", data: { messages: [startMessage, finishMessage], hasNextPage: true }, errors: [] });
    expect(page.messages).toHaveLength(2);
    expect(page.hasNextPage).toBe(true);
    expect(page.oldestId).toBe(1961917);
  });

  it("treats an unexpected payload as an empty, final page instead of throwing", () => {
    expect(readMessagePage({ error: "invalid_csrf" })).toEqual({ messages: [], hasNextPage: false, oldestId: null });
  });

  it("stops paging when the portal reports no further page", () => {
    expect(readMessagePage({ data: { messages: [], hasNextPage: false } }).hasNextPage).toBe(false);
  });
});
