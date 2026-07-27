// Parser for the call-detail slider (`/call/detail/<id>`), the one place where a video call's
// full BitrixGPT analysis lives. The page is server-rendered HTML — there is no JSON endpoint
// behind it — so we read the markup the component emits.
//
// Everything below keys off `bx-call-component-call-ai*` class names, which are the component's
// own CSS contract (bitrix/components/bitrix/call.ai). If a portal update renames them, the
// parser degrades to nulls/empty lists rather than throwing — except for the call id, whose
// absence means we were not served the page we asked for (login redirect, no access).

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

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code] ?? whole;
  });
}

function text(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
  return decodeEntities(withBreaks.replace(/<[^>]*>/g, ""))
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

function one(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? m[1] : null;
}

function num(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Split a chunk on a repeated marker, dropping whatever precedes the first hit. */
function chunks(html: string, marker: string): string[] {
  const parts = html.split(marker);
  return parts.slice(1);
}

/** Tab panes are siblings, so each one runs until the next `<div id="Tab…">`. */
function tabs(html: string): Map<string, string> {
  const starts: Array<{ id: string; at: number }> = [];
  const re = new RegExp(`<div id="(Tab\\w+)" class="${P}__tab-details`, "g");
  for (let m = re.exec(html); m !== null; m = re.exec(html)) starts.push({ id: m[1], at: m.index });
  const out = new Map<string, string>();
  starts.forEach((s, i) => out.set(s.id, html.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : html.length)));
  return out;
}

function splitTimecode(raw: string | null): { from: string | null; to: string | null } {
  if (!raw) return { from: null, to: null };
  const [from, to] = raw.split(/\s*[—–-]\s*/);
  return { from: from?.trim() || null, to: to?.trim() || null };
}

function checklist(html: string, iconClass: string): CallChecklistItem[] {
  const re = new RegExp(`${iconClass} --(\\w+)"></div>\\s*([^<]+)`, "g");
  const out: CallChecklistItem[] = [];
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const label = text(m[2]);
    if (label) out.push({ ok: m[1] === "success", text: label });
  }
  return out;
}

function parseGrade(pane: string): { meetingType: string | null; checklist: CallChecklistItem[] } {
  const items: CallChecklistItem[] = [];
  const re = new RegExp(`${P}__list-item-icon --(\\w+)"></span>\\s*<span>([\\s\\S]*?)</span>`, "g");
  for (let m = re.exec(pane); m !== null; m = re.exec(pane)) {
    items.push({ ok: m[1] === "success", text: text(m[2]) });
  }
  return { meetingType: one(pane, new RegExp(`${P}__resume-type">([\\s\\S]*?)</span>`)), checklist: items };
}

function parseAgreements(pane: string): { decisions: string[]; tasks: CallTask[] } {
  const containers = new RegExp(`${P}__recommendations-container --(\\w+)">([\\s\\S]*?)(?=${P}__recommendations-container --|$)`, "g");
  const decisions: string[] = [];
  const tasks: CallTask[] = [];
  for (let m = containers.exec(pane); m !== null; m = containers.exec(pane)) {
    const [, kind, body] = m;
    if (kind === "result") {
      for (const item of chunks(body, `${P}__result-list-item">`)) {
        const value = text(item.split("</li>")[0]);
        if (value) decisions.push(value);
      }
    }
    if (kind === "task") {
      for (const item of chunks(body, `${P}__task-description">`)) {
        const raw = item.split("</p>")[0];
        // The task-button's data-user-id is the *viewer* (who would create the task);
        // the assignee is the mention inside the description.
        const assigneeId = num(one(raw, /bx-tooltip-user-id="(\d+)"/));
        const assignee = one(raw, /bx-tooltip-user-id="\d+"[^>]*>([\s\S]*?)<\/span>/);
        const value = text(raw);
        if (value) tasks.push({ assigneeId, assignee: assignee ? text(assignee) : null, text: value });
      }
    }
  }
  return { decisions, tasks };
}

function parseSummary(pane: string): { overview: string | null; chapters: CallChapter[] } {
  const blocks = chunks(pane, `${P}-resume-block">`);
  let overview: string | null = null;
  const chapters: CallChapter[] = [];
  for (const block of blocks) {
    const title = one(block, new RegExp(`${P}-resume-block__name">([\\s\\S]*?)</span>`));
    const body = one(block, new RegExp(`${P}-resume-block__description">([\\s\\S]*?)</p>`));
    if (!title) {
      // The one block without a heading is the whole-meeting summary.
      if (!overview && body) overview = text(body);
      continue;
    }
    const { from, to } = splitTimecode(one(block, new RegExp(`${P}-resume-block__time[^>]*>([\\s\\S]*?)</span>`)));
    chapters.push({ from, to, title: text(title), text: body ? text(body) : "" });
  }
  return { overview, chapters };
}

function parseParticipants(pane: string): CallParticipant[] {
  const byId = new Map<number, CallParticipant>();
  const nameless: CallParticipant[] = [];

  const upsert = (id: number | null, name: string): CallParticipant => {
    if (id === null) {
      const fresh: CallParticipant = { id, name, talkTimePercent: null, talkTime: null, efficiency: null, metrics: [], insight: null };
      nameless.push(fresh);
      return fresh;
    }
    const existing = byId.get(id);
    if (existing) return existing;
    const fresh: CallParticipant = { id, name, talkTimePercent: null, talkTime: null, efficiency: null, metrics: [], insight: null };
    byId.set(id, fresh);
    return fresh;
  };

  // Summary table: one row per participant with talk share and efficiency.
  for (const row of chunks(pane, `${P}__insights-graph-table__row">`)) {
    const id = num(one(row, /data-insights-user-id="(\d+)"/));
    const employee = one(row, new RegExp(`${P}__employee__row"[^>]*>([\\s\\S]*?)</div>`));
    const values = [...row.matchAll(/<call-ai-efficiency-value value="(\d+)"/g)].map((m) => Number(m[1]));
    const p = upsert(id, employee ? text(employee) : "");
    p.talkTimePercent = values[0] ?? null;
    p.efficiency = values[1] ?? null;
    p.talkTime = one(row, /\(([^)]+)\)/);
  }

  // Full report: six behavioural metrics plus a free-text recommendation per participant.
  for (const block of chunks(pane, `${P}__insights__full-report__info" data-insights-user-id-full="`)) {
    const id = num(one(block, /^(\d+)"/));
    const name = one(block, new RegExp(`${P}__insights__full-report__info__name"[^>]*>([\\s\\S]*?)<div class="activity"`));
    const p = upsert(id, name ? text(name) : "");
    p.metrics = checklist(block, `${P}__insights__full-report__info__metrics-icon`);
    const insight = one(block, new RegExp(`${P}__insights__full-report__info__description">([\\s\\S]*?)</div>`));
    p.insight = insight ? text(insight) : null;
  }

  return [...byId.values(), ...nameless];
}

function parseTranscript(pane: string): CallTranscriptLine[] {
  const out: CallTranscriptLine[] = [];
  for (const block of chunks(pane, `${P}-decryption-block">`)) {
    const body = block.split("</div>")[0];
    const { from, to } = splitTimecode(one(body, new RegExp(`${P}-decryption-block__time[^>]*>([\\s\\S]*?)</span>`)));
    const speaker = one(body, new RegExp(`${P}-decryption-block__name">([\\s\\S]*?)</span>`));
    const said = text(body.replace(/<span[\s\S]*?<\/span>/g, ""));
    if (said) out.push({ from, to, speakerId: null, speaker: speaker ? text(speaker).replace(/:$/, "") : null, text: said });
  }
  return out;
}

function parseRecording(html: string, origin?: string): CallRecording | null {
  const raw = one(html, /data-audio-src="([^"]+)"/);
  if (!raw) return null;
  const path = decodeEntities(raw);
  // signedParameters is a base64 PHP array + HMAC minted by the server for this page —
  // it already encodes callId and trackId, so the link works as-is under session cookies.
  const signed = one(path, /signedParameters=([^&]+)/);
  const decoded = signed ? decodeBase64(decodeURIComponent(signed).split(".")[0]) : null;
  return {
    path,
    url: origin ? `${origin}${path}` : null,
    trackId: num(decoded ? one(decoded, /"trackId";i:(\d+)/) : null),
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

export function parseCallDetail(html: string, opts: ParseOptions = {}): CallDetail {
  const id = num(one(html, /data-call-id="(\d+)"/));
  if (id === null) {
    throw new Error(
      "response is not a call-detail page (no data-call-id) — the portal likely answered with a login " +
        "page or the call is not accessible to this user",
    );
  }
  const pane = tabs(html);
  const grade = parseGrade(pane.get("TabGrade") ?? "");
  const agreements = parseAgreements(pane.get("TabAgreements") ?? "");
  const summary = parseSummary(pane.get("TabSummary") ?? "");
  const participants = parseParticipants(pane.get("TabRecommendations") ?? "");
  const times = [...html.matchAll(new RegExp(`${P}__time-value">([\\s\\S]*?)</div>`, "g"))].map((m) => text(m[1]));

  const lines = opts.transcript === false ? [] : parseTranscript(pane.get("TabTranscriptions") ?? "");
  const idByName = new Map(participants.filter((p) => p.id !== null && p.name).map((p) => [p.name, p.id]));
  for (const line of lines) line.speakerId = (line.speaker && idByName.get(line.speaker)) ?? null;

  const agenda = one(html, new RegExp(`${P}__resume-description">([\\s\\S]*?)</p>`));
  const title = one(html, new RegExp(`${P}__resume-title">([\\s\\S]*?)</h3>`));
  return {
    id,
    uuid: one(html, /data-call-uuid="([^"]+)"/),
    title: title ? text(title) : null,
    agenda: agenda ? text(agenda) : null,
    date: times[0] ?? null,
    interval: times[1] ?? null,
    duration: times[2] ?? null,
    meetingType: grade.meetingType ? text(grade.meetingType) : null,
    efficiency: num(one(html, /data-efficiency-value="(\d+)"/)),
    qualityChecklist: grade.checklist,
    participants,
    recording: parseRecording(html, opts.origin),
    overview: summary.overview,
    decisions: agreements.decisions,
    tasks: agreements.tasks,
    chapters: summary.chapters,
    transcript: lines,
    // Kept even when the transcript is omitted, so the agent knows what it opted out of.
    transcriptCount: opts.transcript === false
      ? (html.match(new RegExp(`${P}-decryption-block__description`, "g")) ?? []).length
      : lines.length,
  };
}
