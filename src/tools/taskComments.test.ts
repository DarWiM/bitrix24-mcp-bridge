import { describe, it, expect } from "bun:test";
import { formatComments, parseComments, parseFirstPage, toIsoDate } from "./taskComments.js";

// Synthetic markup mirroring the real main.post.list output (bitrix:forum.comments). Real captures
// carry people's discussions and live session signatures, so they stay out of git.
function comment(opts: {
  id: number;
  authorId: number;
  author: string;
  date: string;
  body: string;
  readStatus?: "old" | "new";
  system?: boolean;
  files?: string;
}): string {
  const aux = opts.system ? " mpl-comment-aux mpl-comment-aux-taskinfo" : "";
  return (
    `<div id="record-TASK_42-${opts.id}-cover" bx-mpl-xml-id="TASK_42" bx-mpl-entity-id="${opts.id}" ` +
    `bx-mpl-read-status="${opts.readStatus ?? "old"}" bx-mpl-block="main" class="feed-com-block-cover">` +
    `<div id="record-TASK_42-${opts.id}" class="feed-com-block-outer">` +
    `<div class="feed-com-block blog-comment-user-${opts.authorId} feed-com-block-approved${aux}">` +
    `<div class="feed-com-main-content feed-com-block-old">` +
    `<span class="feed-com-name feed-author-name feed-author-name-${opts.authorId}">${opts.author}</span>` +
    `<div class="feed-com-user-box"><a class="feed-com-name feed-author-name" bx-tooltip-user-id="${opts.authorId}" ` +
    `href="/company/personal/user/${opts.authorId}/">${opts.author}</a>` +
    `<a class="feed-time feed-com-time" href="#com${opts.id}">${opts.date}</a></div>` +
    `<div class="feed-com-text"><div class="feed-com-text-inner"><div class="feed-com-text-inner-inner" ` +
    `id="record-TASK_42-${opts.id}-text">${opts.body}</div></div></div>` +
    (opts.files ?? "") +
    `</div></div></div></div>`
  );
}

const SIGNED = "YToxOntzOjg6IkZPUlVNX0lEIjtpOjM7fQ==.0000fake";

function firstPage(comments: string, withOlder: boolean): string {
  const nav = withOlder
    ? `<a id="TASK_42-7_AbCdEf_page_nav" bx-mpl-comments-count="5">Предыдущие комментарии (5)</a>`
    : "";
  return (
    `<html><body><div id="TASK_42-7_AbCdEf_main">${nav}${comments}</div>` +
    `<script>BX.ready(function(){ window["UC"]["TASK_42"] = new FCList({ EXEMPLAR_ID : '7_AbCdEf', ` +
    `ENTITY_XML_ID : 'TASK_42', mid : 900, ` +
    `ajax : {"componentName":"bitrix:forum.comments","navigateComment":true,"readComment":true,"params":"${SIGNED}"} }); });` +
    `</script></body></html>`
  );
}

const IMAGE =
  `<div class="feed-com-files diskuf-files-entity"><figure id="disk-attach-701">` +
  `<div class="disk-ui-file-thumbnails-web-grid-img" data-src="/bitrix/tools/disk/uf.php?attachedId=701&amp;_esd=x&amp;action=download&amp;ncc=1" ` +
  `data-object-id="5001" data-attached-object-id="701" data-title="screen.png" data-bx-size="120.5 КБ"></div></figure></div>`;

const DOC =
  `<div class="feed-com-files"><a href="/bitrix/tools/disk/uf.php?attachedId=702&amp;action=download&amp;ncc=1" ` +
  `data-bx-size="12 КБ" title="spec.pdf">spec.pdf</a>` +
  // a preview link of the same file must not show up twice
  `<a href="/bitrix/tools/disk/uf.php?attachedId=702&amp;action=show">открыть</a></div>`;

describe("toIsoDate", () => {
  it("turns the portal's long date into a local ISO timestamp", () => {
    expect(toIsoDate("9 марта 2024 08:15")).toBe("2024-03-09T08:15");
    expect(toIsoDate("3 июня 2024 7:40")).toBe("2024-06-03T07:40");
  });

  it("leaves relative or year-less forms alone instead of guessing", () => {
    expect(toIsoDate("вчера, 12:00")).toBeNull();
    expect(toIsoDate("9 марта 08:15")).toBeNull();
  });
});

describe("parseComments", () => {
  it("reads author, date, text and read status, oldest first", () => {
    const html =
      comment({ id: 902, authorId: 7, author: "Пётр Петров", date: "5 мая 2025 10:00", body: "второй", readStatus: "new" }) +
      comment({ id: 901, authorId: 8, author: "Анна Смирнова", date: "4 мая 2025 09:30", body: "<div>первый<br />с переносом</div>" });

    const [first, second] = parseComments(html);

    expect(first).toMatchObject({
      id: 901, authorId: 8, author: "Анна Смирнова", date: "4 мая 2025 09:30", dateIso: "2025-05-04T09:30",
      text: "первый\nс переносом", isNew: false, system: false, files: [],
    });
    expect(second).toMatchObject({ id: 902, isNew: true });
  });

  it("flags task-info notices as system comments", () => {
    const [c] = parseComments(comment({ id: 903, authorId: 9, author: "Бот", date: "6 мая 2025 11:00", body: "Срок изменён", system: true }));
    expect(c.system).toBe(true);
  });

  it("keeps the target of a labelled external link but not of a mention", () => {
    const body =
      `<div><a class="blog-p-user-name" href="/company/personal/user/8/" bx-tooltip-user-id="8">Анна Смирнова</a>, смотри ` +
      `<a href="https://figma.com/file/abc?x=1&amp;y=2">макет</a> и https://example.com/raw</div>`;
    const [c] = parseComments(comment({ id: 904, authorId: 7, author: "Пётр Петров", date: "7 мая 2025 12:00", body }));
    expect(c.text).toBe("Анна Смирнова, смотри макет (https://figma.com/file/abc?x=1&y=2) и https://example.com/raw");
  });

  it("collects image and document attachments as absolute download links, once each", () => {
    const [c] = parseComments(
      comment({ id: 905, authorId: 7, author: "Пётр Петров", date: "8 мая 2025 13:00", body: "файлы", files: IMAGE + DOC }),
      "https://portal.example",
    );
    expect(c.files).toEqual([
      { attachedId: 701, name: "screen.png", size: "120.5 КБ", url: "https://portal.example/bitrix/tools/disk/uf.php?attachedId=701&_esd=x&action=download&ncc=1" },
      { attachedId: 702, name: "spec.pdf", size: "12 КБ", url: "https://portal.example/bitrix/tools/disk/uf.php?attachedId=702&action=download&ncc=1" },
    ]);
  });
});

describe("parseFirstPage", () => {
  it("extracts the paging handles and whether older comments exist", () => {
    const page = parseFirstPage(firstPage(comment({ id: 910, authorId: 7, author: "Пётр", date: "9 мая 2025 14:00", body: "x" }), true));
    expect(page).toMatchObject({ exemplarId: "7_AbCdEf", signedParameters: SIGNED, hasOlder: true });
    expect(page.comments.map((c) => c.id)).toEqual([910]);
  });

  it("reports a complete history when there is no 'previous comments' link", () => {
    expect(parseFirstPage(firstPage("", false)).hasOlder).toBe(false);
  });

  it("refuses a page without the comment list (login redirect, no access)", () => {
    expect(() => parseFirstPage("<html><body><form id='auth'></form></body></html>")).toThrow(/not a task comments page/);
  });
});

describe("formatComments", () => {
  it("renders one greppable line per comment plus its files", () => {
    const comments = parseComments(
      comment({ id: 905, authorId: 7, author: "Пётр Петров", date: "8 мая 2025 13:00", body: "раз<br>два", files: IMAGE, system: true }),
    );
    const text = formatComments(42, comments, true);
    expect(text).toContain("# Дочитано до начала: да");
    expect(text).toContain("#905 [2025-05-08T13:00] Пётр Петров (id 7) [системный]: раз ⏎ два");
    expect(text).toContain("  файл: screen.png (120.5 КБ) /bitrix/tools/disk/uf.php?attachedId=701");
  });
});
