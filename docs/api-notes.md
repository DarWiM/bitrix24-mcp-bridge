# Bitrix24 API notes (reverse-engineered)

Справочник по внутреннему API Bitrix24, добытый **живым реверсом** (у внутренних ajax-контроллеров
нет публичной документации). Предназначен для любого ИИ-агента или разработчика, который вызывает
эти методы через мост (`bitrix_call` / типизированные инструменты) или расширяет каталог.

Наблюдения сняты на портале `example.bitrix24.ru` (облако, мессенджер **im.v2**, задачи в режиме
**scrum-борда**). Имена полей и конвенции стандартны для облачного Bitrix24, но при переносе на другой
портал сверяйся реверсом (`docs/reconnaissance.md`).

---

## 1. Как вызывать

- **`bitrix_call { name, params }`** — универсальный вызов любого разрешённого имени из каталога
  (`actions.json`). `params` — нативный формат Bitrix (см. раздел 3). Каталог может включать
  мутирующие вызовы; allowlist (`actions.json`) — единственная граница, не режим чтения.
- **Типизированные инструменты** — обёртки с разумными дефолтами над каталогом. Точная выборка — через
  опциональный `params`, он мержится **последним** и перекрывает дефолты. Регистрируются только те,
  чьё имя есть в каталоге (`actions.json`); иначе инструмент пропускается. Текущий набор:
  - Задачи: `bitrix_tasks_list`, `bitrix_task_get`, `bitrix_task_get_v2` (v2/JSON),
    `bitrix_task_scrum_info`, `bitrix_task_files`, `bitrix_task_views_count`,
    `bitrix_task_subtasks` (подзадачи), `bitrix_task_related` (связанные).
  - Проекты: `bitrix_projects_list`, `bitrix_project_get`.
  - Чаты: `bitrix_chats_recent`, `bitrix_recent_load` (недавние по секции — в т.ч. `tasksTask` =
    чаты задач), `bitrix_recent_tail` (листать недавние вглубь), `bitrix_chat_load` (открыть по
    `dialogId`/`chatId`), `bitrix_chat_messages`, `bitrix_chat_history` (листать вглубь по `beforeId`),
    `bitrix_chat_get_dialog_id` (dialogId по externalId), `bitrix_chat_mark_read` (⚠ мутирующий),
    `bitrix_chat_read_all` (⚠ мутирующий).
  - Люди/поиск: `bitrix_user_get` (карточка юзера), `bitrix_entity_selector` (загрузка селектора),
    `bitrix_entity_search` (текстовый поиск чатов/сущностей через `ui.entityselector.doSearch`).

  Любое имя каталога всегда доступно и напрямую через `bitrix_call { name, params }`.
- **`bitrix_help`** — этот же гайд, отдаётся через MCP (инструмент + resource `bitrix://api-notes`).
  Источник — **этот файл** (`docs/api-notes.md`).

Полный список имён каталога отдаёт `bitrix_call` в своём описании (`deps.catalog.names()`).

---

## 2. Формат ответа (важно!)

Ajax-контроллеры (`/bitrix/services/main/ajax.php`) отвечают HTTP 200 с конвертом:

```jsonc
{ "status": "success" | "error",
  "data": { ... },
  "errors": [] }          // ПУСТОЙ массив при успехе! (в JS [] — truthy)
```

- Успех определяется `status:"success"` и/или **пустым** `errors`. Непустой `errors` / `status:"error"` /
  top-level `error` — реальная ошибка (мост маппит это в `ok:false`).
- REST-эндпоинты (`/rest/*.json`) отвечают иначе: `{ "result": …, "next", "total", "time" }` — без `errors`.

---

## 3. Транспорт: form vs json (различается по методу!)

У каждой записи каталога есть **`bodyType`** — как мост кодирует тело:

- **`bodyType: "form"`** (по умолчанию) — `application/x-www-form-urlencoded`; вложенность кодируется
  PHP-стилем (`filter[STATUS]=2`, `select[0]=ID`). Объект в `params` рекурсивно разворачивается в такие
  ключи. Классические `tasks.task.*`, мессенджер `im.v2.*`, REST — всё это форма.
- **`bodyType: "json"`** — тело уходит как `JSON.stringify(params)` с `Content-Type: application/json`.
  Так работают **`tasks.v2.*`** (напр. `tasks.v2.Task.get` ждёт `{"task":{"id":N}}`) и `ui.entityselector.*`.
  `params` при этом сохраняет вложенную структуру как есть (не разворачивается в bracket-ключи).

> Историческая заметка: раньше мост умел только форму, и `tasks.v2.*` были непригодны. Теперь
> поддержаны — в записи каталога ставь `"bodyType": "json"`, и мост отправит их корректно.

**CSRF / sessid:** мост всегда шлёт заголовок **`X-Bitrix-Csrf-Token: <sessid>`** (свежий
`BX.bitrix_sessid()`). Form-тела дополнительно несут `sessid` полем в теле (legacy REST это требует);
JSON-тела несут sessid **только** в заголовке. Ответ `invalid_csrf`/`invalid_authentication` = сессия
протухла (перелогинься в браузере).

| Метод (action / endpoint) | bodyType | Где `select`/`filter`/`order` | Пагинация |
|---|---|---|---|
| `tasks.task.list` | form | **верхний уровень**: `select[]`, `filter{}`, `order{}` | `start` (сдвиг, шаг 50) |
| `tasks.task.get` | form | верхний уровень: `taskId`, `select[]` | — |
| `tasks.v2.Task.get` | **json** | `{"task": {"id": N}}` | — |
| `tasks.v2.Scrum.getTaskInfo` | **json** | `{"taskId": N}` | — |
| `tasks.v2.File.listObjects` | **json** | `{"ids": [N,…]}` | — |
| `tasks.v2.Task.View.User.count` | **json** | `{"task": {"id": N}}` | — |
| `tasks.v2.Task.Relation.Child.list` | **json** | `{"taskId": N, "withIds":true, "navigation":{"size":N}}` | `navigation` |
| `tasks.v2.Task.Relation.Related.list` | **json** | `{"taskId": N, …}` (как Child) | `navigation` |
| `socialnetwork.api.workgroup.list` | form | **верхний уровень**: `select[]`, `order{}`, `filter{}` | (nav — не проверено) |
| `socialnetwork.api.workgroup.get` | form | **обёрнуто**: `params[groupId]`, `params[select][]` | — |
| `/rest/im.recent.list.json` | form (rest) | плоско: `LIMIT`, `SKIP_OPENLINES`, `UNREAD_ONLY`, … | `LIMIT` |
| `/rest/im.user.get.json` | form (rest) | плоско: `ID` | — |
| `im.v2.Recent.load` | form | плоско: `limit`, `filter[recentSection]`, `filter[unread]`, `filter[parentId]` | `im.v2.Recent.tail` |
| `im.v2.Recent.tail` | form | плоско: `limit`, `filter[lastMessageDate]` (курсор), `filter[recentSection]` | `filter[lastMessageDate]` |
| `im.v2.Chat.load` | form | плоско: `dialogId`\|`chatId`, `messageLimit` | — |
| `im.v2.Chat.getDialogId` | form | плоско: `externalId` | — |
| `im.v2.Chat.Message.list` | form | плоско: `chatId`, `limit` | только последняя страница — назад **не листает**, используй `.tail` |
| `im.v2.Chat.Message.tail` | form | плоско: `chatId`, `limit`, `filter[lastId]`, `order[id]` | **см. раздел 6** |
| `im.v2.Chat.Message.read` | form | плоско: `chatId`, `ids[]`, `actionUuid` | — (мутирующий) |
| `im.v2.Chat.readAll` | form | без параметров | — (мутирующий) |
| `ui.entityselector.load` | **json** | `{"dialog": {entities,preselectedItems,…}}` | — |
| `ui.entityselector.doSearch` | **json** | `{"dialog": {…}, "searchQuery": {"query": "...", "queryWords": ["..."]}}` | — |

---

## 4. Каталог: имя → action → параметры

| Имя (`actions.json`) | action / endpoint | bodyType | Ключевые params |
|---|---|---|---|
| `tasks.list` | `tasks.task.list` | form | `filter{RESPONSIBLE_ID,REAL_STATUS,GROUP_ID,…}`, `select[]`, `order{}`, `start` |
| `task.get` | `tasks.task.get` | form | `taskId`, `select[]` |
| `task.v2.get` | `tasks.v2.Task.get` | json | `task.id` (id задачи) |
| `task.scrum.info` | `tasks.v2.Scrum.getTaskInfo` | json | `taskId` |
| `task.files` | `tasks.v2.File.listObjects` | json | `ids` (массив id) |
| `task.views.count` | `tasks.v2.Task.View.User.count` | json | `task.id` (id задачи) |
| `task.subtasks` | `tasks.v2.Task.Relation.Child.list` | json | `taskId`, `navigation{size}` |
| `task.related` | `tasks.v2.Task.Relation.Related.list` | json | `taskId`, `navigation{size}` |
| `projects.list` | `socialnetwork.api.workgroup.list` | form | `select[]`, `order{}`, `filter{}` |
| `projects.get` | `socialnetwork.api.workgroup.get` | form | `params[groupId]`, `params[select][]` |
| `chats.recent` | `/rest/im.recent.list.json` | form | `LIMIT`, `UNREAD_ONLY`, `SKIP_OPENLINES` |
| `recent.load` | `im.v2.Recent.load` | form | `filter[recentSection]` (`tasksTask`/`collab`/…), `limit`, `filter[unread]` |
| `recent.tail` | `im.v2.Recent.tail` | form | `filter[lastMessageDate]`, `filter[recentSection]`, `limit` |
| `chat.load` | `im.v2.Chat.load` | form | `dialogId`\|`chatId`, `messageLimit` |
| `chat.dialogId` | `im.v2.Chat.getDialogId` | form | `externalId` (напр. `"sg"+groupId`) |
| `chat.messages` | `im.v2.Chat.Message.list` | form | `chatId`, `limit` (последние; вглубь — `chat.messages.tail`) |
| `chat.messages.tail` | `im.v2.Chat.Message.tail` | form | `chatId`, `filter[lastId]`, `order[id]`, `limit` |
| `chat.message.read` | `im.v2.Chat.Message.read` | form | `chatId`, `ids[0]`, `actionUuid` |
| `chat.read.all` | `im.v2.Chat.readAll` | form | — (⚠ мутирующий) |
| `im.user.get` | `/rest/im.user.get.json` | form | `ID` |
| `entityselector.load` | `ui.entityselector.load` | json | `dialog` (объект) |
| `entityselector.search` | `ui.entityselector.doSearch` | json | `dialog`, `searchQuery{query,queryWords}` |

---

## 5. Справочник полей

**Задача** (`tasks.task.*`): `ID`, `TITLE`, `DESCRIPTION`, `STATUS`, `REAL_STATUS`, `RESPONSIBLE_ID`,
`CREATED_BY`, `CREATED_DATE`, `CHANGED_DATE`, `DEADLINE`, `CLOSED_DATE`, `PRIORITY`, `GROUP_ID`,
`TAGS`, `TIME_ESTIMATE`, `UF_*`. Ответ также подкладывает объекты `group`, `responsible`, `creator`, `action`.

Статусы задачи (`STATUS`): `1` Новая · `2` Ждёт выполнения · `3` Выполняется · `4` Ждёт контроля ·
`5` Завершена · `6` Отложена · `7` Отклонена.

**Задача v2** (`tasks.v2.*`): id задачи передаётся вложенно — **`{"task": {"id": N}}`** (у `Task.get` и
`Task.View.User.count`), а у `Scrum.getTaskInfo` и `Relation.*` — плоско `{"taskId": N}`. Это отдельная
подсистема scrum-борда; структуру ответа сверь реверсом — в захвате видны только параметры запроса.

**Группа/проект — список** (`workgroup.list`, camelCase в ответе): `ID`, `NAME`, `DESCRIPTION`,
`NUMBER_OF_MEMBERS`, `OWNER_ID`, `DATE_CREATE`, `PROJECT` (Y/N), `TYPE`.
**Группа — карточка** (`workgroup.get`): плюс `OWNER_DATA`, `SUBJECT_DATA`, `MEMBERS[]`,
`MODERATOR_MEMBERS[]`, `CHAT_ID`, `DIALOG_ID`, `IMAGE_ID`, UF-поля.

**Недавний чат** (`im.recent.list`): `chat_id`, `title`, `type`, `message{id,text,date,author_id}`,
`last_id`, `unread`, `pinned`, `user{…}`, `chat{…}`.
**Недавние по секции** (`im.v2.Recent.load`): фильтр `filter[recentSection]` — `default` (обычные
диалоги), **`tasksTask` (чаты задач)**, `collab`/`collabDefault` (коллабы). Листание вглубь —
`im.v2.Recent.tail` с курсором `filter[lastMessageDate]` (ISO-дата последнего элемента страницы).
**Карточка юзера** (`im.user.get`): `id`, `name`, `first_name`, `last_name`, `avatar`, `work_position`,
`gender`, `status`, `online` — резолв автора сообщения (`authorId`) в имя.
**Сообщение** (`im.v2.Chat.Message.*`): `id`, `chatId`, `authorId`, `date`, `text`, `params`, `viewed`.
Ответ также несёт `users[]` (участники), `additionalMessages[]`, `hasPrevPage`/`hasNextPage`.
`chatId` берётся из `im.recent.list` (`chat_id`) или из `workgroup.get` (`CHAT_ID`/`DIALOG_ID`).

**Адресация чата (`chat.load`): `dialogId` vs `chatId`.** `chat.load` принимает любой из двух:
- `dialogId` = **ID пользователя** (число, напр. `11`) → **личный чат 1-на-1** с этим пользователем.
- `dialogId` = **`"chat"+CHAT_ID`** (напр. `"chat7111"`) → **групповой чат** (проекта/задачи/канала).
- `chatId` = числовой `CHAT_ID` — то же, что групповой `dialogId`, но без префикса.

Ответ `chat.load` возвращает числовой `chatId` — используй его дальше для `chat.messages` /
`chat.messages.tail` (листание вглубь) и `chat.message.read` (эти три работают по `chatId`, не по `dialogId`).

---

## 6. Примеры вызовов

```jsonc
// открытые задачи ответственного 55, по дедлайну, вторая страница
bitrix_tasks_list { "params": { "filter": {"RESPONSIBLE_ID":55,"REAL_STATUS":2},
                                "order": {"DEADLINE":"asc"}, "start": 50 } }

// карточка задачи с расширенным набором полей
bitrix_task_get { "taskId": 4229, "params": { "select": ["ID","TITLE","DESCRIPTION","TAGS","TIME_ESTIMATE"] } }

// карточка задачи через v2-подсистему (JSON-тело; id вложен в task)
bitrix_task_get_v2 { "taskId": 4229 }                       // → { "task": { "id": 4229 } }
bitrix_call { "name": "task.v2.get", "params": { "task": { "id": 4229 } } }

// файлы задачи и счётчик просмотров (v2, JSON-тело); подзадачи/связанные
bitrix_call { "name": "task.files", "params": { "ids": [4229] } }
bitrix_call { "name": "task.views.count", "params": { "task": { "id": 4229 } } }
bitrix_task_subtasks { "taskId": 4229 }
bitrix_task_related  { "taskId": 4229 }

// проекты по дате создания; полная карточка группы
bitrix_projects_list { "params": { "order": {"DATE_CREATE":"desc"} } }
bitrix_project_get { "groupId": 15 }

// открыть чат (первые сообщения)
bitrix_chat_load { "chatId": 485, "messageLimit": 50 }

// ЛИСТАНИЕ ИСТОРИИ ВГЛУБЬ (старые сообщения): beforeId = минимальный id сообщения
// из текущей страницы. Повторяй, уменьшая beforeId, до начала истории (order DESC — дефолт).
bitrix_chat_history { "chatId": 485, "beforeId": 1861279 }

// пометить сообщения прочитанными (МУТИРУЮЩИЙ). actionUuid генерируется автоматически.
bitrix_chat_mark_read { "chatId": 40271, "ids": [1884131] }
```

### 6.1. Сценарий: чат с конкретным пользователем

Личный чат 1-на-1 адресуется `dialogId` = **ID пользователя**. Id берётся из задачи
(`RESPONSIBLE_ID`/`CREATED_BY`), из `bitrix_chats_recent`, либо резолвится поиском (§6.3).

```jsonc
// 1) открыть личный чат с пользователем 11 → в ответе будет числовой chatId
bitrix_chat_load { "dialogId": 11 }
// 2) листать его историю вглубь по chatId из ответа шага 1
bitrix_chat_history { "chatId": 485, "beforeId": 1861279 }
```

### 6.2. Сценарий: обсуждение (чат) конкретной задачи

У каждой задачи есть свой im-чат-обсуждение. Два пути найти его `chatId`:

**А. Через список чатов задач (прямой).** `im.v2.Recent.load` с секцией `tasksTask` отдаёт чаты задач
(в `bitrix_chats_recent` / `/rest/im.recent.list` их НЕТ). Листать вглубь — `bitrix_recent_tail`.

```jsonc
bitrix_recent_load { "section": "tasksTask" }           // → чаты задач с chatId/dialogId
bitrix_recent_tail { "section": "tasksTask", "lastMessageDate": "2026-06-29T17:25:38+03:00" }
// открыть найденный чат и листать историю
bitrix_chat_load    { "dialogId": "chat38849" }         // или { "chatId": 38849 }
bitrix_chat_history { "chatId": 38849, "beforeId": 1722353 }
```

**Б. Поиском по названию задачи** — `bitrix_entity_search` с секцией `tasksTask`:

```jsonc
bitrix_entity_search { "query": "трекер", "section": "tasksTask" }
```

**Чат ПРОЕКТА задачи** (обсуждение группы, не самой задачи) — через `GROUP_ID`:

```jsonc
bitrix_task_get    { "taskId": 4229, "params": { "select": ["ID","GROUP_ID"] } }
bitrix_project_get { "groupId": 15 }                    // отдаёт CHAT_ID / DIALOG_ID
bitrix_chat_load   { "dialogId": "chat7111" }
bitrix_chat_get_dialog_id { "externalId": "sg15" }      // либо резолв dialogId соцгруппы напрямую
```

### 6.3. Сценарий: поиск чата / пользователя

Текстовый поиск — `bitrix_entity_search` (обёртка над `ui.entityselector.doSearch`): сам собирает
диалог `IM_CHAT_SEARCH` и `searchQuery` из строки:

```jsonc
bitrix_entity_search { "query": "дмитрий" }                        // среди всех чатов/диалогов
bitrix_entity_search { "query": "трекер", "section": "tasksTask" } // среди чатов задач
```

Быстрый путь без поиска — недавние чаты и фильтрация на стороне агента; карточка автора по id:

```jsonc
bitrix_chats_recent { }                        // сопоставь по title / user
bitrix_recent_load  { "section": "tasksTask" }
bitrix_user_get     { "userId": 11 }           // резолв authorId → имя
```

### 6.4. Легаси-комментарии задачи (HTML-поддомен — пока НЕ в мосте)

У задач два независимых фида обсуждения:
- **im.v2-чат** — структурный JSON, читается уже сейчас (§6.2); обычно этого достаточно.
- **Форумные легаси-комментарии** — рендерятся как **HTML** в side-slider'е. Это отдельный
  «HTML-поддомен» внутреннего API, который **текущий мост не поддерживает** (блокеры ниже).

**Как грузятся (реверс).** Первая страница — GET HTML-страницы iframe (сервер тут же минтит подпись):

```
GET /task/comments/<taskId>/?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER   → HTML (комментарии + signedParameters)
```

Листание — POST компонентного ajax (форма, отдаёт HTML-фрагмент):

```
POST /bitrix/services/main/ajax.php?mode=class&c=bitrix:forum.comments&action=navigateComment
form: AJAX_POST=Y, ENTITY_XML_ID=TASK_<taskId>, taskId=<taskId>, MODE=LIST,
      FILTER[<ID]=<курсор: id, ДО которого грузить старые>, PAGEN_1=1,
      signedParameters=<подписанный blob>, IFRAME=Y, IFRAME_TYPE=SIDE_SLIDER
headers: bx-ajax: true, x-bitrix-site-id: s1 (плюс обычный X-Bitrix-Csrf-Token)
```

`signedParameters` — base64 PHP-массива + HMAC-подпись сервера; кодирует
`FORUM_ID, ENTITY_TYPE=TK, ENTITY_ID=<taskId>, ENTITY_XML_ID=TASK_<taskId>, …`. **Подделать нельзя** —
берётся из HTML первой страницы.

**Почему пока не в каталоге (3 блокера):**
1. Мост парсит ответ только как JSON (`extension/src/connector.ts` → `resp.json()`) — HTML бросит исключение.
2. Path-параметр в URL (`/task/comments/<taskId>/`) — записи каталога статичны, шаблонов пути нет.
3. `signedParameters` + заголовки `bx-ajax`/`x-bitrix-site-id` — нужен предварительный GET HTML-страницы.

**Чтобы подключить** (будущая работа): научить мост возвращать text/HTML при не-JSON ответе и
поддержать path-шаблон эндпоинта; затем обёртка `bitrix_task_comments { taskId }` (GET первой
страницы), а листание — через `navigateComment` с выпарсенным `signedParameters`.

> Тот же HTML-поддомен: **детали звонка** — `GET /call/detail/<callId>?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER`
> (отдаёт HTML). Ограничения идентичны.

---

## 7. Как расширить (новый домен: календарь, диск, CRM, …)

1. Сними реальные вызовы (`docs/reconnaissance.md` — авто-запись `bun run capture` или HAR →
   `bun run catalog:draft`). Черновик `actions.draft.json` накапливает **все уникальные комбинации
   параметров** на экшен и проставляет `bodyType` (form/json) автоматически.
2. Определи транспорт по разделу 3: если черновик показал `"bodyType": "json"` — перенеси его в запись.
3. Добавь запись в `actions.json` (может быть мутирующей — каталог это допускает).
4. Если удобно — оберни в типизированный инструмент в `src/tools/register.ts` (обёртка регистрируется
   только если её `catalogName` есть в каталоге).
5. **`bun run sync:runtime`** — доставь изменения живому daemon: пересобрать бандл, скопировать
   репо-`actions.json` в `~/.bitrix24-mcp-bridge/actions.json` и погасить daemon. Без этого агент
   новых имён/инструментов не увидит (daemon читает runtime-папку, не репо). Проверь через
   `bitrix_call { name, params }` или новую обёртку.

> `actions.json` / `actions.draft.json` — данные конкретного портала (gitignored). Этот файл
> (`api-notes.md`) — переносимые знания о самом API; держи его в актуальном состоянии при добавлении
> новых методов.
