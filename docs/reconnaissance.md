# Новая операция моста (гайд мейнтейнера)

Каждый инструмент `bitrix_*` — встроенная операция в `src/ops/`: имя, zod-схема аргументов, флаг
`mutating` и реализация, которая шлёт один или несколько запросов к Bitrix24 через расширение. Чтобы
агент получил новое действие (календарь, диск, CRM, новая мутация задачи…), мейнтейнер проходит
четыре шага:

1. **Запись трафика** — что шлёт веб-интерфейс портала.
2. **Живая проверка** метода через сессию моста.
3. **Операция в `src/ops/`** с тестами.
4. **`bun run sync:runtime`** — доставка в живой daemon и расширение.

---

## 1. Запись трафика (Charles / DevTools)

> Сперва проверь, задокументирован ли метод в [`apidocs.bitrix24.com`](https://apidocs.bitrix24.com)
> (context7: `/bitrix24/b24restdocs`). Для публичных `*.list`/`*.get` там готовые поля, фильтры и
> пагинация — запись тогда нужна лишь чтобы подтвердить транспорт и конверт ответа. Для внутренних
> `im.v2.*`/`tasks.v2.*`/UI-методов доков нет — только запись.

- **Charles** (или другой прокси с расшифровкой HTTPS): включи запись, выполни действие в браузере на
  вкладке портала, найди запрос к `/bitrix/services/main/ajax.php?action=…` или `/rest/<метод>.json`.
- **DevTools** → Network → «Preserve log», без фильтра; ПКМ по запросу → «Copy as cURL» или
  «Save all as HAR with content».

Из записи выпиши: путь (`endpoint`), `action`, метод HTTP, тело (форма или JSON — это `bodyType`),
форму ответа. Записи с реальными данными держи только локально (`.temp/`), в репозиторий не клади.

## 2. Живая проверка через сессию

Запись показывает, что шлёт UI, но не доказывает, что метод работает в том виде, в каком его вызовет
мост. Проверь вызов через ту же сессию (вкладку портала с расширением), прежде чем писать операцию.

- **Классический REST** (`/rest/<метод>.json`) сессию принимает; **REST 3.0** (`/rest/api/…`) — нет
  (`BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION`).
- **Есть ли метод** (existence probe): `ERROR_METHOD_NOT_FOUND` — метода нет; ошибка аргументов —
  метод есть; `22002 Internal server error` **ничего не доказывает** (так на классическом пути отвечают
  методы, существующие только в REST 3.0).
- **Мутацию** проверяй на тестовой сущности и перечитывай результат: часть методов отвечает `true`, ничего
  не изменив (напр. `task.stages.movetask` для задачи, которой нет на доске спринта).
- Сравни официальный метод и то, что шлёт UI: где официальный проверен вживую, бери его — у него
  есть доки и стабильный контракт.

## 3. Операция в `src/ops/`

- **Чтение с одним запросом** — запись в `READ_OPERATIONS` (`src/ops/read.ts`): цель через
  `callTarget({ action, method, bodyType? })`, дефолты и `params` агента мержатся в `send(...)`.
- **Несколько запросов или разбор HTML** — `COMPOSITE_OPERATIONS` (`src/ops/composite.ts`), разбор —
  в отдельном модуле рядом (`callDetail.ts`, `taskComments.ts`, `chatCalls.ts`).
- `defineOperation({ name, description, mutating, budget?, input, run })`: `name` без префикса (`bitrix_`
  добавляет регистрация), `description` — на русском, для агента: что делает, откуда брать id, ловушки.
  `mutating: true` для всего, что меняет данные — такие операции блокирует переключатель мутаций.
  `budget` — сколько MCP-клиент ждёт ответа: `"call"` (умолчание, один запрос), `"long"` (цепочка
  страниц, ~5 мин), `"download"` (скачивание файла).
- id, которые попадают в путь или имя файла, — через `idArg()` (только цифры).
- `params` агента — через `agentParams()`: он отклоняет ключи `action`/`c`/`mode`/`sessid`, которыми
  можно подменить вызываемый метод. Поля, подставляемые в путь, мержь после `params`.
- Тесты — рядом (`foo.ts` → `foo.test.ts`): форма запроса, разбор ответа, ошибки. Имена операций
  уникальны — `createRegistry` падает на дубле.
- Опиши инструмент для агента в `docs/api-notes.md` §3 (без id портала и имён людей — файл едет в
  npm-пакет) и Bitrix-метод — в таблицу ниже.

## 4. Доставка: `bun run sync:runtime`

Daemon, к которому ходят агенты, исполняет собранный `dist/cli.js`, а не исходники. `bun run
sync:runtime` пересобирает бандл и статичные бандлы расширения, обновляет расширение, развёрнутое
`setup` (если его нет — пропускает), и гасит daemon; следующий вызов агента поднимает свежий. Если
менялось расширение (`extension/src/`), перезагрузи его на `chrome://extensions` и вкладку портала.
Уже открытые сессии агентов видят старый список инструментов до перезапуска сессии. Пользователям
операция приходит с релизом пакета.

Dev-запуск (`bun run src/index.ts`) не сверяет версию с daemon и не заменяет его: если работает daemon
релизной версии, выполни `bun run sync:runtime` (или останови daemon), иначе запросы уйдут в него.

---

## Bitrix-методы за операциями

`ajax` = `/bitrix/services/main/ajax.php?action=…`. Тело — форма, если не указано `json`.

| Операция | Bitrix-метод | Тело / заметки |
|---|---|---|
| `tasks_list` | ajax `tasks.task.list` | `select[]`, `order{}`, `filter{}`; пагинация `PAGEN_1` |
| `task_get` | ajax `tasks.task.get` | `taskId`, `select[]` |
| `task_get_v2` | ajax `tasks.v2.Task.get` | json `{"task":{"id":N}}` |
| `task_scrum_info` | ajax `tasks.v2.Scrum.getTaskInfo` | json `{"taskId":N}` |
| `task_files` | ajax `tasks.v2.File.listObjects` | json `{"ids":[…]}` — id прикреплённых объектов |
| `task_views_count` | ajax `tasks.v2.Task.View.User.count` | json `{"task":{"id":N}}` |
| `task_subtasks` | ajax `tasks.v2.Task.Relation.Child.list` | json `{taskId, withIds, withCompleted, withSubTasks, navigation{size}}` |
| `task_related` | ajax `tasks.v2.Task.Relation.Related.list` | как `task_subtasks` |
| `task_comments` | `GET /task/comments/{taskId}/` (HTML) + ajax `bitrix:forum.comments` → `navigateComment` | см. пример ниже |
| `projects_list` | ajax `socialnetwork.api.workgroup.list` | `select[]`, `order{}`, `filter{}` |
| `project_get` | ajax `socialnetwork.api.workgroup.get` | обёрнуто: `params[groupId]`, `params[select][]` |
| `chats_recent` | `/rest/im.recent.list.json` | `LIMIT`, `SKIP_OPENLINES`, `UNREAD_ONLY`, … |
| `recent_load` | ajax `im.v2.Recent.load` | `limit`, `filter[recentSection]`, `filter[unread]`, `filter[parentId]` |
| `recent_tail` | ajax `im.v2.Recent.tail` | `limit`, `filter[lastMessageDate]`, `filter[recentSection]` |
| `chat_load` | ajax `im.v2.Chat.load` | `dialogId` \| `chatId`, `messageLimit` |
| `chat_get_dialog_id` | ajax `im.v2.Chat.getDialogId` | `externalId` |
| `chat_messages` | ajax `im.v2.Chat.Message.list` | `chatId`, `limit`; назад не листает |
| `chat_history` | ajax `im.v2.Chat.Message.tail` | `chatId`, `limit`, `filter[lastId]`, `order[id]=DESC` |
| `chat_mark_read` ⚠ | ajax `im.v2.Chat.Message.read` | `chatId`, `ids[]`, `actionUuid` |
| `chat_read_all` ⚠ | ajax `im.v2.Chat.readAll` | без параметров |
| `user_get` | `/rest/im.user.get.json` | `ID` |
| `entity_chat` | `/rest/im.chat.get.json` | `ENTITY_TYPE`, `ENTITY_ID` |
| `entity_selector` | ajax `ui.entityselector.load` | json `{"dialog":{…}}` |
| `entity_search` | ajax `ui.entityselector.doSearch` | json `{"dialog":{…},"searchQuery":{query,queryWords}}` |
| `chat_calls` | ajax `im.v2.Chat.Message.tail` (страницами по 50) | ищет сообщения с `params.COMPONENT_PARAMS.messageType = "START"` |
| `call_detail` | `GET /call/detail/{callId}?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER` (HTML) | разбор — `src/ops/callDetail.ts` |
| `call_recording` | `call_detail` → ссылка записи (`call.Track.download`) → бинарная загрузка | только ссылка с этого же портала |
| `file_download` | `GET <ссылка портала>` (бинарно) | allowlist путей и `action` — `src/ops/download.ts` |
| `task_description_set` ⚠ | `/rest/tasks.task.update.json` | `taskId`, `fields[DESCRIPTION]` |
| `task_description_append` ⚠ | ajax `tasks.v2.Task.get` → `/rest/tasks.task.update.json` | читает сырой BBCode из `data.description`, дописывает через `\n\n` |
| `chat_send` ⚠ | `/rest/im.message.add.json` | `DIALOG_ID` (`chatId` → `"chat"+id`), `MESSAGE`; ответ `result` = id сообщения |

---

## Транспорт: `CallTarget`

Операция описывает запрос как `CallTarget` (`shared/wire.ts`; `callTarget()` в `src/ops/read.ts`
заполняет дефолты). Его исполняет расширение.

**`bodyType` — как кодируется тело:**

- **`"form"`** (по умолчанию) — `application/x-www-form-urlencoded`; вложенность кодируется PHP-стилем
  (`filter[STATUS]=2`, `select[0]=ID`). Объект в `params` рекурсивно разворачивается в такие ключи.
  Классические `tasks.task.*`, мессенджер `im.v2.*`, REST — всё это форма.
- **`"json"`** — тело уходит как `JSON.stringify(params)` с `Content-Type: application/json`; `params`
  сохраняет вложенную структуру как есть. Так работают **`tasks.v2.*`** (напр. `tasks.v2.Task.get` ждёт
  `{"task":{"id":N}}`) и `ui.entityselector.*`.

**`responseType` — как разбирается ответ:**

- **`"json"`** (по умолчанию) — ответ разбирается как JSON и проходит через конверт (`docs/api-notes.md` §2).
- **`"text"`** — сырой ответ `{ contentType, text }` без разбора: для серверного HTML (side-slider'ы —
  детали звонка, легаси-комментарии задач). Ошибкой считается только HTTP ≥ 400 или пустое тело, поэтому
  редирект на логин приедет как «успешный» HTML — распознавать его должна операция (так делает
  `call_detail`: нет `data-call-id` → внятная ошибка).
- **`"binary"`** — тело не возвращается, а **стримится на диск**: расширение читает его как `ArrayBuffer`
  и шлёт по WS чанками base64 по 1 МиБ (`binary-begin` → `binary-chunk`×N → обычный `result`), daemon
  пишет их в файл. Вызывающему приходит только `{ path, bytes, contentType, fileName }`, потолок — 512 МБ.
  Признак реальной загрузки — `Content-Disposition: attachment`; HTML без него считается страницей логина,
  вызов падает и частичный файл не остаётся. Имя берётся из `Content-Disposition`, поэтому без `savePath`
  тело сначала пишется во временный `.download-*.part`, а затем переименовывается.

**Path-параметры в `endpoint`.** `endpoint` может содержать плейсхолдеры `{имя}` — значение берётся из
`params` и подставляется в URL (а из тела/query исключается): `"/call/detail/{callId}"` +
`params: { callId: 4242 }` → `GET /call/detail/4242`. Нет значения — вызов падает с внятной ошибкой,
а не уходит с дырой в URL.

**CSRF / sessid.** Мост всегда шлёт заголовок **`X-Bitrix-Csrf-Token: <sessid>`** (свежий
`BX.bitrix_sessid()`). Form-тела дополнительно несут `sessid` полем в теле (legacy REST это требует);
JSON-тела — только в заголовке. Ответ `invalid_csrf`/`invalid_authentication` = сессия протухла.

---

## Пример: легаси-комментарии задачи (HTML-поддомен)

У задач два независимых фида обсуждения: **im.v2-чат** (структурный JSON) и **форумные легаси-комментарии**,
которые рендерятся как HTML в side-slider'е. Второй читает операция `task_comments`
(`src/ops/composite.ts`, разбор — `src/ops/taskComments.ts`) двумя запросами.

Первая страница — GET HTML-страницы iframe; сервер тут же минтит подпись:

```
GET /task/comments/<taskId>/?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER   → HTML (комментарии + FCList({...}))
```

В инициализации `FCList({...})` лежат `EXEMPLAR_ID` (`<число>_xxxxxx`) и `ajax.params` — это и есть
`signedParameters`: base64 PHP-массива (`FORUM_ID, ENTITY_TYPE=TK, ENTITY_ID=<taskId>, …`) + `.` + HMAC
сервера; подделать нельзя. Ссылка `[id$="_page_nav"]` («Предыдущие комментарии (N)») есть, только если
старее что-то осталось.

Листание — POST компонентного ajax:

```
POST /bitrix/services/main/ajax.php?mode=class&c=bitrix%3Aforum.comments&action=navigateComment
form: AJAX_POST=Y, ENTITY_XML_ID=TASK_<taskId>, EXEMPLAR_ID=<из HTML>, taskId=<taskId>, MODE=LIST,
      FILTER[<ID]=<курсор: самый старый уже загруженный id>, PAGEN_1=1,
      signedParameters=<из HTML>, scope=web, IFRAME=Y, IFRAME_TYPE=SIDE_SLIDER
→ { status:"success", exemplarId, messageList: <HTML-фрагмент>, navigation: <"ещё" или ""> }
```

Пустой `navigation` = дошли до начала. Браузер шлёт ещё `bx-ajax: true` и `x-bitrix-site-id: s1`, но
они **не нужны**: вызов проходит с обычными заголовками моста. Query (`mode`, `c`, `action`) живёт прямо в
`endpoint` цели с `action: null` — иначе мост дописал бы второй `?action=`.

**Прочитанным не помечает.** Отметку о прочтении ставит отдельное действие того же компонента
`readComment`, которое вызывает JS страницы, когда комментарий попадает в видимую область. Мост
только забирает HTML. Проверено вживую: `viewedDate` задачи (`tasks.task.list`, `select: ["VIEWED_DATE"]`)
и `task_views_count` после чтения не меняются.
