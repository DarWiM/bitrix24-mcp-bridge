import { describe, it, expect } from "bun:test";
import { formatTranscript, parseCallDetail } from "./callDetail.js";

// Synthetic page mirroring the real slider's markup (bitrix/components/bitrix/call.ai).
// Kept minimal but structurally faithful: real captures carry meeting content and stay out of git.
const P = "bx-call-component-call-ai";
const AUDIO = "/bitrix/services/main/ajax.php?action=call.Track.download&SITE_ID=s1&signedParameters=YToyOntzOjY6ImNhbGxJZCI7aTo0MjQyO3M6NzoidHJhY2tJZCI7aTo3Nzt9.sig";

const page = `
<div class="${P}" data-call-id="4242" data-call-uuid="1f0f6e4c-mock">
  <h3 class="${P}__resume-title">Планирование спринта</h3>
  <p class="${P}__resume-description"><span class="bx-call-mention" bx-tooltip-user-id="101">Пётр</span> открыл встречу.<br>Поехали.</p>
  <div class="${P}__time-value">23 июля, 15:46</div>
  <div class="${P}__time-value">15:46 - 16:51</div>
  <div class="${P}__time-value">1 ч 4 мин</div>
  <div class="${P}__tab-content-wrapper">
    <div id="TabGrade" class="${P}__tab-details --grade">
      <div class="${P}__grade-value-wrapper" data-efficiency-value="88"></div>
      <div>Тип встречи: <span class="${P}__resume-type">Статус-встреча</span></div>
      <ul class="${P}__list">
        <li class="${P}__list-item"><span class="${P}__list-item-icon --success"></span><span>Озвучена повестка</span></li>
        <li class="${P}__list-item"><span class="${P}__list-item-icon --fail"></span><span>Уложились в тайминг</span></li>
      </ul>
    </div>
    <div id="TabAgreements" class="${P}__tab-details --agreements">
      <div class="${P}__recommendations-container --result">
        <ol class="${P}__result-list">
          <li class="${P}__result-list-item">Тестируем только английскую локализацию.</li>
          <li class="${P}__result-list-item">Авторизацию берём готовую.</li>
        </ol>
      </div>
      <div class="${P}__recommendations-container --task">
        <ol class="${P}__result-list">
          <li class="${P}__result-list-item">
            <div class="${P}__result-list-item-container">
              <p class="${P}__task-description"><span class="bx-call-mention" bx-tooltip-user-id="102">Иван</span>: закрыть задачу сегодня.</p>
              <span class="${P}__task-button" data-user-id="103" data-description="Иван: закрыть задачу сегодня."></span>
            </div>
          </li>
        </ol>
      </div>
    </div>
    <div id="TabRecommendations" class="${P}__tab-details --insights">
      <div class="${P}__insights-graph-table__row">
        <div class="${P}__employee__column ${P}__employee__row" data-insights-user-id="101" bx-tooltip-user-id="101">
          <img class="${P}__insights__user-img"> Пётр
        </div>
        <div class="${P}__activity__column ${P}__activity__row">
          <div class="${P}__column-container"><call-ai-efficiency-value value="58"></call-ai-efficiency-value>%&nbsp;(32 мин)</div>
        </div>
        <div class="${P}__efficiency__column ${P}__efficiency__row">
          <div class="${P}__column-container"><call-ai-efficiency-chart percent="90"></call-ai-efficiency-chart><call-ai-efficiency-value value="90"></call-ai-efficiency-value></div>
        </div>
      </div>
      <div class="${P}__insights__full-report__info" data-insights-user-id-full="101">
        <div class="${P}__insights__full-report__info__name" bx-tooltip-user-id="101">
          <img class="${P}__insights__user-img"> Пётр
          <div class="activity"><call-ai-efficiency-value value="58"></call-ai-efficiency-value>%&nbsp;(32 мин)</div>
          <div class="efficiency"><call-ai-efficiency-value value="90"></call-ai-efficiency-value></div>
        </div>
        <div class="${P}__insights__full-report__info__metrics">
          <div class="left">
            <div class="${P}__insights__full-report__info__metrics-container"><div class="${P}__insights__full-report__info__metrics-icon --success"></div> Говорит по теме</div>
          </div>
          <div class="right">
            <div class="${P}__insights__full-report__info__metrics-container"><div class="${P}__insights__full-report__info__metrics-icon --fail"></div> Соблюдает тайминг</div>
          </div>
        </div>
        <div class="${P}__insights__full-report__info__description"><span class="bx-call-mention" bx-tooltip-user-id="101">Пётр</span> вёл встречу уверенно.</div>
      </div>
    </div>
    <div id="TabSummary" class="${P}__tab-details --summary">
      <div class="${P}__call-audio-record" data-audio-id="TabSummary" data-audio-src="${AUDIO}"></div>
      <div class="${P}-resume-block">
        <p class="${P}-resume-block__description">Команда обсудила локализацию и доступы.</p>
      </div>
      <div class="${P}__resume-block-wrapper">
        <div class="${P}-resume-block">
          <div class="${P}-resume-block__title">
            <span class="${P}-resume-block__time ${P}__time-code">01:14—03:08</span>
            <span class="${P}-resume-block__name">Статус задач</span>
          </div>
          <p class="${P}-resume-block__description">Прошлись по задачам спринта.</p>
        </div>
      </div>
    </div>
    <div id="TabTranscriptions" class="${P}__tab-details --transcriptions">
      <div class="${P}__call-audio-record" data-audio-id="TabTranscriptions" data-audio-src="${AUDIO}"></div>
      <div class="${P}-decryption-block">
        <p class="${P}-decryption-block__description">
          <span class="${P}-decryption-block__time ${P}__time-code" data-audio-id="TabTranscriptions">00:13—00:15</span>
          <span class="${P}-decryption-block__name">Пётр:</span>
          Алло, привет.
        </p>
      </div>
      <div class="${P}-decryption-block">
        <p class="${P}-decryption-block__description">
          <span class="${P}-decryption-block__time ${P}__time-code" data-audio-id="TabTranscriptions">01:03:12—01:03:20</span>
          <span class="${P}-decryption-block__name">Гость:</span>
          Спасибо, до связи.
        </p>
      </div>
    </div>
  </div>
</div>`;

describe("parseCallDetail", () => {
  it("reads call identity and timing", () => {
    const call = parseCallDetail(page);
    expect(call.id).toBe(4242);
    expect(call.uuid).toBe("1f0f6e4c-mock");
    expect(call.title).toBe("Планирование спринта");
    expect(call.agenda).toBe("Пётр открыл встречу.\nПоехали.");
    expect(call.date).toBe("23 июля, 15:46");
    expect(call.interval).toBe("15:46 - 16:51");
    expect(call.duration).toBe("1 ч 4 мин");
    expect(call.meetingType).toBe("Статус-встреча");
    expect(call.efficiency).toBe(88);
  });

  it("reads the quality checklist with its pass/fail state", () => {
    expect(parseCallDetail(page).qualityChecklist).toEqual([
      { ok: true, text: "Озвучена повестка" },
      { ok: false, text: "Уложились в тайминг" },
    ]);
  });

  it("separates decisions from tasks and takes the assignee from the mention, not the button", () => {
    const call = parseCallDetail(page);
    expect(call.decisions).toEqual(["Тестируем только английскую локализацию.", "Авторизацию берём готовую."]);
    // data-user-id on the button is the viewer (103) — the assignee is the mentioned user (102).
    expect(call.tasks).toEqual([{ assigneeId: 102, assignee: "Иван", text: "Иван: закрыть задачу сегодня." }]);
  });

  it("splits the summary into an overview and timecoded chapters", () => {
    const call = parseCallDetail(page);
    expect(call.overview).toBe("Команда обсудила локализацию и доступы.");
    expect(call.chapters).toEqual([
      { from: "01:14", to: "03:08", title: "Статус задач", text: "Прошлись по задачам спринта." },
    ]);
  });

  it("merges the analysis table with the full report per participant", () => {
    const [peter] = parseCallDetail(page).participants;
    expect(peter.id).toBe(101);
    expect(peter.name).toBe("Пётр");
    expect(peter.talkTimePercent).toBe(58);
    expect(peter.talkTime).toBe("32 мин");
    expect(peter.efficiency).toBe(90);
    expect(peter.metrics).toEqual([
      { ok: true, text: "Говорит по теме" },
      { ok: false, text: "Соблюдает тайминг" },
    ]);
    expect(peter.insight).toBe("Пётр вёл встречу уверенно.");
  });

  it("keeps a speaker who never made the analysis table", () => {
    const guest = parseCallDetail(page).participants.find((p) => p.name === "Гость");
    expect(guest).toBeDefined();
    expect(guest?.id).toBeNull();
  });

  it("reads the transcript with timecodes and resolves speaker ids", () => {
    const { transcript, transcriptCount } = parseCallDetail(page);
    expect(transcriptCount).toBe(2);
    expect(transcript[0]).toEqual({ from: "00:13", to: "00:15", speakerId: 101, speaker: "Пётр", text: "Алло, привет." });
    expect(transcript[1].from).toBe("01:03:12");
    expect(transcript[1].speakerId).toBeNull();
  });

  it("omits the transcript on request but still reports its size", () => {
    const call = parseCallDetail(page, { transcript: false });
    expect(call.transcript).toEqual([]);
    expect(call.transcriptCount).toBe(2);
    expect(call.participants.some((p) => p.name === "Гость")).toBe(true);
  });

  it("returns the recording link, absolute when the portal origin is known", () => {
    expect(parseCallDetail(page).recording).toEqual({ path: AUDIO, url: null, trackId: 77 });
    expect(parseCallDetail(page, { origin: "https://portal.bitrix24.ru" }).recording?.url)
      .toBe(`https://portal.bitrix24.ru${AUDIO}`);
  });

  it("rejects a page that is not a call detail (login redirect, no access)", () => {
    expect(() => parseCallDetail("<html><body>Войти в portal</body></html>")).toThrow(/not a call-detail page/);
  });
});

describe("formatTranscript", () => {
  it("renders one self-contained line per utterance", () => {
    const call = parseCallDetail(page);
    const text = formatTranscript(call);
    const lines = text.split("\n");
    expect(lines).toContain("[00:13—00:15] Пётр: Алло, привет.");
    expect(lines).toContain("[01:03:12—01:03:20] Гость: Спасибо, до связи.");
  });

  it("puts call identity in a header so the file stands on its own", () => {
    const header = formatTranscript(parseCallDetail(page)).split("\n\n")[0];
    expect(header).toContain("Звонок №4242");
    expect(header).toContain("Планирование спринта");
    expect(header).toContain("1 ч 4 мин");
    expect(header).toContain("Участники: Пётр, Гость");
    expect(header).toContain("Реплик: 2");
  });

  it("survives a line with no timecode or speaker", () => {
    const call = parseCallDetail(page);
    call.transcript = [{ from: null, to: null, speakerId: null, speaker: null, text: "неразборчиво" }];
    expect(formatTranscript(call)).toContain("?: неразборчиво");
  });
});
