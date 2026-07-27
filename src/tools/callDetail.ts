// Parser for the call-detail slider (`/call/detail/<id>`), the one place where a video call's
// full BitrixGPT analysis lives. The page is server-rendered HTML — there is no JSON endpoint
// behind it — so we read the markup the component emits.
//
// Everything below keys off `bx-call-component-call-ai*` class names, which are the component's
// own CSS contract (bitrix/components/bitrix/call.ai). If a portal update renames them, the
// parser degrades to nulls/empty lists rather than throwing — except for the call id, whose
// absence means we were not served the page we asked for (login redirect, no access).

import { parse, type HTMLElement } from "node-html-parser";

const P = "bx-call-component-call-ai";

export interface CallChecklistItem {
  ok: boolean;
  text: string;
}

export interface CallParticipant {
  id: number | null;
  name: string;
  talkTimePercent: number | null;
  talkTime: string | null;
  efficiency: number | null;
  metrics: CallChecklistItem[];
  insight: string | null;
}

export interface CallTask {
  assigneeId: number | null;
  assignee: string | null;
  text: string;
}

export interface CallChapter {
  from: string | null;
  to: string | null;
  title: string;
  text: string;
}

export interface CallTranscriptLine {
  from: string | null;
  to: string | null;
  speakerId: number | null;
  speaker: string | null;
  text: string;
}

export interface CallRecording {
  path: string;
  url: string | null;
  trackId: number | null;
}

export interface CallDetail {
  id: number;
  uuid: string | null;
  title: string | null;
  agenda: string | null;
  date: string | null;
  interval: string | null;
  duration: string | null;
  meetingType: string | null;
  efficiency: number | null;
  qualityChecklist: CallChecklistItem[];
  participants: CallParticipant[];
  recording: CallRecording | null;
  overview: string | null;
  decisions: string[];
  tasks: CallTask[];
  chapters: CallChapter[];
  transcript: CallTranscriptLine[];
  transcriptCount: number;
}

/** `.text` already decodes entities and turns <br> into newlines; this only tidies whitespace. */
function clean(el: HTMLElement | null | undefined): string {
  if (!el) return "";
  return el.text.replace(/[^\S\n]+/g, " ").replace(/ *\n+ */g, "\n").trim();
}

function attr(el: HTMLElement | null | undefined, name: string): string | null {
  return el?.getAttribute(name) ?? null;
}

function num(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function splitTimecode(raw: string): { from: string | null; to: string | null } {
  const [from, to] = raw.split(/\s*[—–-]\s*/);
  return { from: from?.trim() || null, to: to?.trim() || null };
}

/** Icon elements carry their state as a `--success` / `--fail` modifier class. */
function iconState(item: HTMLElement, iconSelector: string): boolean {
  return item.querySelector(iconSelector)?.classList.contains("--success") ?? false;
}

function parseChecklist(root: HTMLElement): CallChecklistItem[] {
  return root.querySelectorAll(`#TabGrade .${P}__list-item`).map((item) => ({
    ok: iconState(item, `.${P}__list-item-icon`),
    text: clean(item.querySelector("span:not([class])") ?? item),
  }));
}

function parseDecisions(root: HTMLElement): string[] {
  return root
    .querySelectorAll(`#TabAgreements [class~="--result"] .${P}__result-list-item`)
    .map((li) => clean(li))
    .filter((t) => t.length > 0);
}

function parseTasks(root: HTMLElement): CallTask[] {
  return root.querySelectorAll(`#TabAgreements [class~="--task"] .${P}__task-description`).map((p) => {
    // The task-button's data-user-id is the *viewer* (who would create the task);
    // the assignee is the mention inside the description.
    const mention = p.querySelector("[bx-tooltip-user-id]");
    return {
      assigneeId: num(attr(mention, "bx-tooltip-user-id")),
      assignee: mention ? clean(mention) : null,
      text: clean(p),
    };
  });
}

function parseSummary(root: HTMLElement): { overview: string | null; chapters: CallChapter[] } {
  let overview: string | null = null;
  const chapters: CallChapter[] = [];
  for (const block of root.querySelectorAll(`#TabSummary .${P}-resume-block`)) {
    const heading = block.querySelector(`.${P}-resume-block__name`);
    const body = clean(block.querySelector(`.${P}-resume-block__description`));
    if (!heading) {
      // The one block without a heading is the whole-meeting summary.
      if (!overview && body) overview = body;
      continue;
    }
    const { from, to } = splitTimecode(clean(block.querySelector(`.${P}-resume-block__time`)));
    chapters.push({ from, to, title: clean(heading), text: body });
  }
  return { overview, chapters };
}

function parseParticipants(root: HTMLElement): CallParticipant[] {
  const byId = new Map<number, CallParticipant>();
  const anonymous: CallParticipant[] = [];

  const upsert = (id: number | null, name: string): CallParticipant => {
    const existing = id === null ? undefined : byId.get(id);
    if (existing) return existing;
    const fresh: CallParticipant = {
      id, name, talkTimePercent: null, talkTime: null, efficiency: null, metrics: [], insight: null,
    };
    if (id === null) anonymous.push(fresh);
    else byId.set(id, fresh);
    return fresh;
  };

  // Summary table: one row per participant with talk share and efficiency.
  for (const row of root.querySelectorAll(`#TabRecommendations .${P}__insights-graph-table__row`)) {
    const employee = row.querySelector(`.${P}__employee__row`);
    const p = upsert(num(attr(employee, "data-insights-user-id")), clean(employee));
    const values = row.querySelectorAll("call-ai-efficiency-value").map((v) => num(attr(v, "value")));
    p.talkTimePercent = values[0] ?? null;
    p.efficiency = values[1] ?? null;
    p.talkTime = /\(([^)]+)\)/.exec(clean(row.querySelector(`.${P}__activity__row`)))?.[1] ?? null;
  }

  // Full report: six behavioural metrics plus a free-text recommendation per participant.
  for (const block of root.querySelectorAll("[data-insights-user-id-full]")) {
    const name = block.querySelector(`.${P}__insights__full-report__info__name`);
    // The name cell also nests the talk-time and efficiency widgets; drop them so the
    // participant's name is not glued to "58% (32 мин) 100".
    name?.querySelectorAll("div").forEach((widget) => widget.remove());
    const p = upsert(num(attr(block, "data-insights-user-id-full")), clean(name));
    p.metrics = block
      .querySelectorAll(`.${P}__insights__full-report__info__metrics-container`)
      .map((item) => ({ ok: iconState(item, `.${P}__insights__full-report__info__metrics-icon`), text: clean(item) }));
    p.insight = clean(block.querySelector(`.${P}__insights__full-report__info__description`)) || null;
  }

  return [...byId.values(), ...anonymous];
}

function parseTranscript(root: HTMLElement): CallTranscriptLine[] {
  const lines: CallTranscriptLine[] = [];
  for (const block of root.querySelectorAll(`#TabTranscriptions .${P}-decryption-block`)) {
    const timeEl = block.querySelector(`.${P}-decryption-block__time`);
    const nameEl = block.querySelector(`.${P}-decryption-block__name`);
    const { from, to } = splitTimecode(clean(timeEl));
    const speaker = clean(nameEl).replace(/:$/, "");
    // What is left once the timecode and the speaker label are dropped is the utterance.
    timeEl?.remove();
    nameEl?.remove();
    const said = clean(block);
    if (said) lines.push({ from, to, speakerId: null, speaker: speaker || null, text: said });
  }
  return lines;
}

function parseRecording(root: HTMLElement, origin?: string): CallRecording | null {
  const path = attr(root.querySelector("[data-audio-src]"), "data-audio-src");
  if (!path) return null;
  // signedParameters is a base64 PHP array + HMAC minted by the server for this page —
  // it already encodes callId and trackId, so the link works as-is under session cookies.
  const signed = /signedParameters=([^&]+)/.exec(path)?.[1];
  const decoded = signed ? decodeBase64(decodeURIComponent(signed).split(".")[0]) : null;
  return {
    path,
    url: origin ? `${origin}${path}` : null,
    trackId: num(decoded ? (/"trackId";i:(\d+)/.exec(decoded)?.[1] ?? null) : null),
  };
}

function decodeBase64(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export interface ParseOptions {
  origin?: string;
  transcript?: boolean;
}

/**
 * Plain-text rendering of the transcript, one utterance per line. Chosen over JSON for the
 * on-disk copy because a grep hit is then self-contained — the line carries its own timecode
 * and speaker, whereas in a JSON array those live on neighbouring lines.
 */
export function formatTranscript(call: CallDetail): string {
  const speakers = call.participants.map((p) => p.name).filter(Boolean).join(", ");
  const header = [
    `# Звонок №${call.id}${call.title ? ` — ${call.title}` : ""}`,
    `# ${[call.date, call.interval, call.duration].filter(Boolean).join(" · ")}`,
    speakers ? `# Участники: ${speakers}` : null,
    `# Реплик: ${call.transcriptCount}`,
    "",
  ].filter((line) => line !== null);
  const lines = call.transcript.map((line) => {
    const at = line.from ? `[${line.from}${line.to ? `—${line.to}` : ""}] ` : "";
    return `${at}${line.speaker ?? "?"}: ${line.text}`;
  });
  return [...header, ...lines].join("\n") + "\n";
}

export function parseCallDetail(html: string, opts: ParseOptions = {}): CallDetail {
  const root = parse(html);
  const id = num(attr(root.querySelector("[data-call-id]"), "data-call-id"));
  if (id === null) {
    throw new Error(
      "response is not a call-detail page (no data-call-id) — the portal likely answered with a login " +
        "page or the call is not accessible to this user",
    );
  }

  const participants = parseParticipants(root);
  const summary = parseSummary(root);
  const times = root.querySelectorAll(`.${P}__time-value`).map((el) => clean(el));

  // Always parsed, even when the caller opted out of receiving it: the transcript is the only
  // place a participant who never made it into the analysis table still shows up by name.
  const lines = parseTranscript(root);
  const idByName = new Map(
    participants.filter((p): p is CallParticipant & { id: number } => p.id !== null && p.name !== "").map((p) => [p.name, p.id]),
  );
  for (const line of lines) line.speakerId = line.speaker ? idByName.get(line.speaker) ?? null : null;
  for (const speaker of new Set(lines.map((l) => l.speaker))) {
    if (speaker && !idByName.has(speaker)) {
      participants.push({ id: null, name: speaker, talkTimePercent: null, talkTime: null, efficiency: null, metrics: [], insight: null });
    }
  }

  return {
    id,
    uuid: attr(root.querySelector("[data-call-uuid]"), "data-call-uuid"),
    title: clean(root.querySelector(`.${P}__resume-title`)) || null,
    agenda: clean(root.querySelector(`.${P}__resume-description`)) || null,
    date: times[0] ?? null,
    interval: times[1] ?? null,
    duration: times[2] ?? null,
    meetingType: clean(root.querySelector(`.${P}__resume-type`)) || null,
    efficiency: num(attr(root.querySelector("[data-efficiency-value]"), "data-efficiency-value")),
    qualityChecklist: parseChecklist(root),
    participants,
    recording: parseRecording(root, opts.origin),
    overview: summary.overview,
    decisions: parseDecisions(root),
    tasks: parseTasks(root),
    chapters: summary.chapters,
    transcript: opts.transcript === false ? [] : lines,
    // Reported even when the transcript is omitted, so the agent knows what it opted out of.
    transcriptCount: lines.length,
  };
}
