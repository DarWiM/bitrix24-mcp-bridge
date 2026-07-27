// A call leaves two kinds of traces in the chat it was started from:
//   1. system messages with params.COMPONENT_ID = "CallMessage" — these carry the numeric callId,
//   2. a BitrixGPT follow-up message whose ATTACH links to /call/detail/<callId>.
// Neither is searchable server-side, so callers page back through the history and fold each page
// in here. Whatever the portal sends that doesn't match is ignored rather than fatal — chat
// history is a mixed bag and one odd message must not sink the whole scan.

import { z } from "zod";

const componentMessage = z.object({
  id: z.number(),
  date: z.string().optional(),
  authorId: z.number().optional(),
  text: z.string().optional(),
  params: z.object({
    COMPONENT_ID: z.string(),
    COMPONENT_PARAMS: z.object({
      callId: z.number(),
      messageType: z.string().optional(),
    }),
  }),
});

const anyMessage = z.object({
  id: z.number(),
  date: z.string().optional(),
  params: z.unknown().optional(),
});

const pageSchema = z.object({
  data: z.object({
    messages: z.array(z.unknown()).default([]),
    hasNextPage: z.boolean().optional(),
  }),
});

export interface ChatCallEvent {
  type: string;
  messageId: number;
  date: string | null;
}

export interface ChatCall {
  callId: number;
  startedAt: string | null;
  startedBy: number | null;
  startMessageId: number | null;
  events: ChatCallEvent[];
  summaryMessageId: number | null;
}

export interface ChatMessagePage {
  messages: unknown[];
  hasNextPage: boolean;
  oldestId: number | null;
}

export function readMessagePage(raw: unknown): ChatMessagePage {
  const parsed = pageSchema.safeParse(raw);
  if (!parsed.success) return { messages: [], hasNextPage: false, oldestId: null };
  const { messages, hasNextPage } = parsed.data.data;
  const ids = messages.map((m) => anyMessage.safeParse(m)).filter((r) => r.success).map((r) => r.data.id);
  return {
    messages,
    hasNextPage: hasNextPage ?? messages.length > 0,
    oldestId: ids.length > 0 ? Math.min(...ids) : null,
  };
}

function ensure(acc: Map<number, ChatCall>, callId: number): ChatCall {
  const existing = acc.get(callId);
  if (existing) return existing;
  const fresh: ChatCall = { callId, startedAt: null, startedBy: null, startMessageId: null, events: [], summaryMessageId: null };
  acc.set(callId, fresh);
  return fresh;
}

/** Fold one history page into the accumulator. Pages may arrive in any order. */
export function collectChatCalls(messages: unknown[], acc: Map<number, ChatCall>): void {
  for (const raw of messages) {
    const call = componentMessage.safeParse(raw);
    if (call.success && call.data.params.COMPONENT_ID === "CallMessage") {
      const { id, date, authorId, params } = call.data;
      const entry = ensure(acc, params.COMPONENT_PARAMS.callId);
      const type = params.COMPONENT_PARAMS.messageType ?? "UNKNOWN";
      if (!entry.events.some((e) => e.messageId === id)) entry.events.push({ type, messageId: id, date: date ?? null });
      if (type === "START") {
        entry.startMessageId = id;
        entry.startedAt = date ?? null;
        entry.startedBy = authorId ?? null;
      }
      continue;
    }
    const other = anyMessage.safeParse(raw);
    if (!other.success || other.data.params === undefined) continue;
    // The follow-up carries no callId field — only the link inside its ATTACH blocks.
    const linked = /\/call\/detail\/(\d+)/.exec(JSON.stringify(other.data.params));
    if (linked) ensure(acc, Number(linked[1])).summaryMessageId = other.data.id;
  }
}

export function sortCalls(acc: Map<number, ChatCall>): ChatCall[] {
  return [...acc.values()].sort((a, b) => b.callId - a.callId);
}
