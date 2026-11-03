# Bitrix24 API notes (reverse-engineered)

Как агенту работать с Bitrix24 через этот мост: формат `params`, имена полей, готовые цепочки вызовов.

Две поверхности API. **Публичный REST** (`tasks.task.*`, `im.recent.list`, `im.user.get`, `im.chat.get`,
`socialnetwork.api.workgroup.*`) — есть официальные доки, ссылки на них помечены **📖**
([`apidocs.bitrix24.com`](https://apidocs.bitrix24.com); агенту с MCP context7 — библиотека
`/bitrix24/b24restdocs`). **Внутренние ajax-контроллеры** (`im.v2.*`, `tasks.v2.*`, `ui.entityselector.*`)
публичных доков не имеют — всё ниже добыто живым реверсом; конверт и регистр полей у них могут
отличаться от 📖-аналогов. Имена полей стандартны для облачного Bitrix24; на другом портале ответ
может отличаться.

---

## 1. Как вызывать

- **Каждый инструмент `bitrix_*` — встроенная операция моста** с типизированными аргументами
  (`taskId`, `chatId`, `query`, …) и разумными дефолтами; полный список — §3 и описания MCP-инструментов.
  Вызвать произвольный метод Bitrix по имени нельзя — только эти операции.
- **`params`** (необязательный, у большинства операций — пометка «+ `params`» в §3) — объект в
  **нативном формате Bitrix** (`select`/`filter`/`order`/пагинация, §4). Он мержится **последним** и
  перекрывает дефолты операции. Ключи `action`, `c`, `mode`, `sessid` в `params` запрещены — их задаёт
  сама операция; вызов с ними вернёт ошибку `invalid arguments…`, запрос не уйдёт.
- **`portal`** (необязательный, у всех) — alias портала; по умолчанию — портал по умолчанию из настроек.
- У операций есть дефолты (напр. `bitrix_tasks_list` сортирует `{"ID":"desc"}`) — сравниваешь выдачи
  с разными `params`, задавай `order` явно.
- **Мутирующие** операции (⚠ в §3) меняют данные на портале. Пользователь может выключить их
  переключателем мутаций — тогда вызов вернёт ошибку `operation <имя> changes data, but mutations are
  disabled…`; это настройка пользователя, обойти её нельзя — сообщи пользователю. Операции чтения переключатель не трогает.
- Ответ `invalid_csrf` / `invalid_authentication` = сессия портала протухла → перелогинься в браузере
  на вкладке портала.

---

## 2. Формат ответа

Ajax-контроллеры (`/bitrix/services/main/ajax.php`) отвечают HTTP 200 с конвертом:

```jsonc
{ "status": "success" | "error",
  "data": { ... },
  "errors": [] }          // ПУСТОЙ массив при успехе! (в JS [] — truthy)
```

Успех = `status:"success"` и/или **пустой** `errors`. Непустой `errors` / `status:"error"` / top-level
`error` — реальная ошибка (мост маппит её в `ok:false`). REST-эндпоинты (`/rest/*.json`) отвечают
иначе: `{ "result": …, "next", "total", "time" }` — без `errors`.

---

## 3. Инструменты: что делает → ключевые аргументы

`params` в таблице не повторяется — он есть у всех операций с пометкой «+ `params`» (§1). Форма
`params` различается по методу: где-то плоско, где-то вложенно, где-то обёрнуто в `params[…]` — колонка
«params / пагинация» показывает точную форму (кодирование тела мост берёт на себя).

| Инструмент | Что делает | Ключевые аргументы | params / пагинация |
|---|---|---|---|
| `bitrix_help` | эта справка | — | — |
| `bitrix_status` | какие порталы сконфигурированы и подключены, версии моста и расширения | — | — |
| *Задачи* | | | |
| `bitrix_tasks_list` | список задач | + `params` | верхний уровень: `filter{RESPONSIBLE_ID,REAL_STATUS,GROUP_ID,…}`, `select[]`, `order{}`; **`PAGEN_1`** — номер страницы (1, 2, 3…), страница = 20 задач; `start` **не работает** (вернёт ту же первую страницу) |
| `bitrix_task_get` | карточка задачи (в т.ч. `CHAT_ID`) | `taskId` + `params` | верхний уровень: `select[]` |
| `bitrix_task_get_v2` | карточка задачи через v2-подсистему | `taskId` + `params` | — |
| `bitrix_task_scrum_info` | спринт / эпик / story points задачи | `taskId` + `params` | — |
| `bitrix_task_files` | файлы задачи (ссылки для скачивания) | `ids[]` — id **прикреплённых объектов** (§4), не задач + `params` | `downloadUrl` в ответе относительный — допиши origin портала |
| `bitrix_task_views_count` | сколько пользователей просмотрели задачу | `taskId` + `params` | — |
| `bitrix_task_subtasks` / `bitrix_task_related` | подзадачи / связанные задачи | `taskId` + `params` | `navigation{size}` (дефолт 10) |
| `bitrix_task_comments` | старые комментарии задачи (форум), §5.6 | `taskId`, `limit?`, `maxPages?`, `beforeId?`, `output?` | `beforeId` — курсор |
| *Проекты* | | | |
| `bitrix_projects_list` | рабочие группы / проекты | + `params` | верхний уровень: `select[]`, `order{}`, `filter{}`; `start` (шаг 50; `start=(N-1)*50`, `-1` — ответ без `total`) 📖 |
| `bitrix_project_get` | карточка группы (участники, `CHAT_ID`) | `groupId` + `params` | **обёрнуто**: `params[groupId]`, `params[select][]` |
| *Чаты* | | | |
| `bitrix_chats_recent` | недавние диалоги (без чатов задач) | + `params` | плоско: `LIMIT`, `SKIP_OPENLINES`, `UNREAD_ONLY` |
| `bitrix_recent_load` | недавние по секции (`tasksTask` — чаты задач) | `section?`, `limit?`, `unread?`, `parentId?` + `params` | дальше — `bitrix_recent_tail` |
| `bitrix_recent_tail` | листать недавние вглубь | `lastMessageDate` (курсор), `section?`, `limit?`, `unread?` + `params` | `lastMessageDate` |
| `bitrix_chat_load` | открыть чат, первые сообщения, числовой `chatId` | `dialogId` \| `chatId`, `messageLimit?` + `params` | — |
| `bitrix_chat_get_dialog_id` | `externalId` → `dialogId` (напр. `"sg"+groupId`) | `externalId` + `params` | — |
| `bitrix_chat_messages` | последние сообщения чата | `chatId`, `limit?` + `params` | только последняя страница — назад **не листает**, используй `bitrix_chat_history` |
| `bitrix_chat_history` | листать историю чата вглубь | `chatId`, `beforeId?`, `limit?` + `params` | `beforeId` (§5.1) |
| `bitrix_chat_mark_read` ⚠ | пометить сообщения прочитанными | `chatId`, `ids[]`, `actionUuid?` + `params` | — |
| `bitrix_chat_read_all` ⚠ | пометить **все** чаты прочитанными | + `params` | — |
| *Люди / поиск* | | | |
| `bitrix_user_get` | карточка пользователя мессенджера | `userId` + `params` | — |
| `bitrix_entity_search` | текстовый поиск чатов / людей | `query`, `section?`, `dialog?` + `params` | — |
| `bitrix_entity_selector` | загрузка entityselector со своим `dialog` | `dialog` + `params` | `{"dialog":{entities,preselectedItems,…}}` |
| `bitrix_entity_chat` | `chatId` чата, привязанного к объекту | `entityType`, `entityId` + `params` | — |
| *Созвоны и файлы* | | | |
| `bitrix_chat_calls` | звонки в чате (`callId` + резюме), §5.4 | `chatId`, `limit?`, `maxPages?`, `beforeId?` + `params` | `beforeId` — курсор |
| `bitrix_call_detail` | всё по звонку, §5.4 | `callId`, `transcript?` + `params` | — |
| `bitrix_call_recording` | скачать аудиозапись звонка, §5.5 | `callId`, `savePath?`, `overwrite?` | — |
| `bitrix_file_download` | скачать файл портала на диск, §5.5 | `url`, `savePath?`, `overwrite?` | — |

⚠ — мутирующие; их может выключить пользователь (§1). `bitrix_task_comments` ничего не помечает
прочитанным и мутирующим не считается.

---

## 4. Справочник полей

**Задача** (`tasks.task.*`) — поля для `select`/`filter` в UPPER_CASE: `ID`, `TITLE`, `DESCRIPTION`,
`STATUS`, `REAL_STATUS`, `RESPONSIBLE_ID`, `CREATED_BY`, `CREATED_DATE`, `CHANGED_DATE`, `DEADLINE`,
`CLOSED_DATE`, `PRIORITY`, `GROUP_ID`, `TAGS`, `TIME_ESTIMATE`, **`CHAT_ID`** (id чата-обсуждения
задачи — прямой резолвер `taskId → chatId`, §5.2), `COMMENTS_COUNT` (§5.6), **`UF_TASK_WEBDAV_FILES`**
(id **прикреплённых объектов** — именно их ждёт `bitrix_task_files`; с id задачи он вернёт пустой
список без ошибки), `UF_*`. Ответ подкладывает объекты `group`,
`responsible`, `creator`, `action`.
📖 (`tasks.task.get`/`list`) — сверх этого: `parentId`, `stageId`, `sprintId`, `backlogId`,
`commentsCount`, `timeSpentInLogs`, `favorite`, `flowId`, `mark`, `accomplices[]`, `auditors[]`,
`checklist{}`, `subStatus`; в официальном REST-ответе поля приходят **camelCase**, а в `select`/`filter`
они всегда **UPPER_CASE**. Доп. вычисления — флагами `params{WITH_TIMER_INFO, WITH_RESULT_INFO,
WITH_PARSED_DESCRIPTION}`.

**Статусы** (`REAL_STATUS` — «настоящее» числовое состояние): `1` Новая · `2` Ждёт выполнения ·
`3` Выполняется · `4` Ждёт контроля · `5` Завершена · `6` Отложена · `7` Отклонена. Поле `STATUS`
поверх этого несёт **мета-состояния** отображения (почти просрочена / не просмотрена / просрочена),
поэтому «работает ли задача сейчас» фильтруй по **`REAL_STATUS`** (напр. `{"REAL_STATUS":3}`) 📖.
Асимметрия: в **`filter`** работает `REAL_STATUS`, а в **`select`** его указывать бесполезно — поле молча
не вернётся; чтобы получить состояние, проси `select:["STATUS"]` → в ответе будет ключ `status` со
значением по той же шкале 1..7 (у обёртки `bitrix_tasks_list` он уже в дефолтном `select`).

**Фильтр `tasks.task.list`** — оператор ставится перед именем поля: `!` (не равно / исключить),
`<`, `<=`, `>`, `>=`, `%` (LIKE-подстрока). Напр. `{"!REAL_STATUS":5}` — все **незакрытые**,
`{">=DEADLINE":"2026-07-01"}`, `{"%TITLE":"карта"}`. Фильтруемые поля: `ID`, `PARENT_ID`, `GROUP_ID`,
`CREATED_BY`, `RESPONSIBLE_ID`, `ACCOMPLICE`, `AUDITOR`, `REAL_STATUS`, `STATUS`, `PRIORITY`, `TAG`,
`STAGE_ID`, `SPRINT_ID`, `BACKLOG_ID`, `DEADLINE`, `*_DATE`, `UF_CRM_TASK`.

> **«Мои задачи» ≠ только `RESPONSIBLE_ID`.** Роли участника раздельны: ответственный
> (`RESPONSIBLE_ID`), соисполнитель (`ACCOMPLICE`), наблюдатель (`AUDITOR`), постановщик
> (`CREATED_BY`); единого «любая роль» поля в `list` нет — чтобы собрать **все** свои задачи, объедини
> результаты нескольких вызовов (минимум `RESPONSIBLE_ID` + `ACCOMPLICE`) и **дедуплицируй по `id`** —
> одна задача часто попадает сразу в несколько ролей. В **`filter`** роли в **единственном** числе
> (`ACCOMPLICE`/`AUDITOR`), в **`select`** — во **множественном** (`ACCOMPLICES`/`AUDITORS`).

> **Scrum-задачи (спринты).** Поле `SPRINT_ID` задачи и жёсткий `filter[SPRINT_ID]` могут расходиться:
> задача числится за спринтом по своему полю, но не попадает в выборку по фильтру (возвращена в бэклог
> или в иной stage). Если по фильтру «маловато» — перепроверь без него и отфильтруй по
> `SPRINT_ID`/`STAGE_ID` у себя. Инструмента «колонки scrum-доски» (`STAGE_ID` → имя колонки) пока нет.

**Группа/проект — список** (`workgroup.list`): `ID`, `NAME`, `DESCRIPTION`, `NUMBER_OF_MEMBERS`,
`OWNER_ID`, `DATE_CREATE`, `PROJECT` (Y=проект/N=группа), `TYPE`; **без `select` вернётся только `ID`**.
📖 фильтруемые: `ID`, `NAME`, `OWNER_ID`, `ACTIVE`, `VISIBLE`, `OPENED`, `CLOSED`, `PROJECT`,
`SUBJECT_ID`, `SITE_ID`, `DATE_CREATE`, `DATE_UPDATE`, `DATE_ACTIVITY`; операторы фильтра
`>= > <= < % =% %= !% != !`.
**Группа — карточка** (`workgroup.get`): плюс `OWNER_DATA`, `SUBJECT_DATA`, `MEMBERS[]`,
`MODERATOR_MEMBERS[]`, **`CHAT_ID`**, `DIALOG_ID`, `IMAGE_ID`, UF-поля.

**Недавний чат** (`im.recent.list`): `id` (это dialogId: число = юзер, `"chat"+N` = чат), `chat_id`,
`type` (`user`/`chat`), `title`, `message{id,text,file,author_id,date,status}`, `counter` (непрочитанных),
`unread`, `last_id`, `pinned`, `date_update`, `date_last_activity`, `user{…}`,
`chat{… entity_type, entity_id, owner, …}`; есть ли ещё страницы — `hasMore`/`hasMorePages` 📖.
**Недавние по секции** (`im.v2.Recent.load`): `filter[recentSection]` — `default` (обычные диалоги),
**`tasksTask` (чаты задач)**, `collab`/`collabDefault`. Вглубь — `im.v2.Recent.tail` с курсором
`filter[lastMessageDate]` (ISO-дата последнего элемента страницы).

**Карточка юзера** (`im.user.get`): `id`, `name`, `first_name`, `last_name`, `avatar`, `work_position`,
`gender`, `status`, `online` — резолв автора сообщения (`authorId`) в имя.

**Сообщение** (`im.v2.Chat.Message.*`): `id`, `chatId`, `authorId`, `date`, `text`, `params`, `viewed`;
ответ также несёт `users[]` (участники), `additionalMessages[]`, `hasPrevPage`/`hasNextPage`.

---

## 5. Сценарии

```jsonc
// открытые задачи ответственного 55, по дедлайну, вторая страница
bitrix_tasks_list { "params": { "filter": {"RESPONSIBLE_ID":55,"REAL_STATUS":2},
                                "order": {"DEADLINE":"asc"}, "PAGEN_1": 2 } }

// карточка задачи с расширенным набором полей; v2-подсистема; файлы, просмотры, связи
bitrix_task_get    { "taskId": 4229, "params": { "select": ["ID","TITLE","DESCRIPTION","TAGS"] } }
bitrix_task_get_v2 { "taskId": 4229 }                       // → { "task": { "id": 4229 } }
bitrix_task_get   { "taskId": 4229, "params": { "select": ["ID","UF_TASK_WEBDAV_FILES"] } }
bitrix_task_files { "ids": [<id из UF_TASK_WEBDAV_FILES>] }   // НЕ id задачи
bitrix_task_subtasks { "taskId": 4229 }
bitrix_task_related  { "taskId": 4229 }

// проекты по дате создания; полная карточка группы (отдаёт CHAT_ID / DIALOG_ID)
bitrix_projects_list { "params": { "order": {"DATE_CREATE":"desc"} } }
bitrix_project_get   { "groupId": 15 }
```

### 5.1. Мессенджер (IM): как получить `chatId`

Всё общение — **чаты**: личные 1-на-1, групповые (проектов, каналов) и **чаты-обсуждения задач**.
Числовой **`chatId`** — ключ ко всем операциям с сообщениями (`bitrix_chat_messages`,
`bitrix_chat_history`, `bitrix_chat_mark_read`); почти любая ошибка агента здесь — на шаге его получения.

**Три идентификатора одного чата** (годятся для разных операций):

| Идентификатор | Что это | Пример | Куда передавать |
|---|---|---|---|
| `chatId` | числовой id чата | `485` | сообщения / история / отметка прочитанным |
| `dialogId` | адрес для ОТКРЫТИЯ: `userId` (личный 1-на-1) **или** `"chat"+chatId` (групповой) | `11`, `"chat485"` | `bitrix_chat_load` |
| `externalId` | внешний ключ сущности → резолвится в `dialogId` | `"sg15"` (соцгруппа 15) | `bitrix_chat_get_dialog_id` |

Ключевое: **личный чат с человеком = его `userId` в роли `dialogId`** (отдельного «id чата» у 1-на-1
знать не нужно). `bitrix_chat_load` принимает `dialogId` **или** `chatId` и всегда **возвращает
числовой `chatId`** — дальше оперируешь им.

**Как получить `chatId` — по цели:**

| Хочу открыть чат… | Шаги |
|---|---|
| **с пользователем по ИМЕНИ** | `bitrix_entity_search { query:"дмитрий" }` → диалог с `dialogId` = его userId → `bitrix_chat_load { dialogId }` |
| **с пользователем, id известен** | `bitrix_chat_load { dialogId: <userId> }` (userId — из задачи `RESPONSIBLE_ID`/`CREATED_BY`, из `bitrix_chats_recent`, из `bitrix_user_get`) |
| **обсуждение ЗАДАЧИ** | `bitrix_task_get` → `CHAT_ID` (§5.2) |
| **ПРОЕКТА/группы** | `bitrix_task_get`→`GROUP_ID`→`bitrix_project_get`→`CHAT_ID`; либо `bitrix_chat_get_dialog_id { externalId:"sg<groupId>" }` |
| **не знаю точно, какой** | `bitrix_chats_recent` (недавние, сопоставь по `title`/`user`) или `bitrix_entity_search { query }` |

> Почему не «просто список чатов»: `bitrix_chats_recent` (`im.recent.list`) отдаёт лишь недавние и
> **без чатов задач**. Для поиска конкретного чата — `bitrix_entity_search`; для чатов задач —
> `bitrix_recent_load { section:"tasksTask" }`.

**Читать историю.** `bitrix_chat_messages` отдаёт только последнюю страницу; вглубь листает
`bitrix_chat_history` по курсору `beforeId` = минимальный id сообщения текущей страницы (повторяй,
уменьшая `beforeId`, до начала истории).

```jsonc
bitrix_chat_load    { "dialogId": 11 }                  // личный чат юзера 11 → в ответе chatId
bitrix_chat_history { "chatId": 485, "beforeId": 1861279 }
bitrix_chat_mark_read { "chatId": 40271, "ids": [1884131] }   // ⚠ мутирующий; actionUuid — автоматом
```

📖 Публичные аналоги чтения сообщений: `im.dialog.messages.get` (дефолт 20, макс 50; листание
`LAST_ID` — старее, `FIRST_ID` — новее); `imbot.v2 chat.getMessageContext` — ответ `messages[]`
(oldest→newest) + `users[]` + `hasPrevPage`/`hasNextPage`, по форме **совпадает** с внутренними
`im.v2.Chat.Message.*`.

### 5.2. Обсуждение (чат) конкретной задачи

**А. Прямой резолв — предпочтительно.** `bitrix_task_get` возвращает `CHAT_ID` чата-обсуждения (входит
в дефолтный `select` 📖) — это `taskId → chatId` без поиска по названию и без промаха по тёзкам:

```jsonc
bitrix_task_get     { "taskId": 28373 }                 // в ответе CHAT_ID
bitrix_chat_load    { "chatId": <CHAT_ID> }
bitrix_chat_history { "chatId": <CHAT_ID>, "beforeId": <мин id страницы> }
```

Общая альтернатива — **`bitrix_entity_chat`** (обёртка над `im.chat.get`): chatId любого связанного
объекта по паре `entityType`/`entityId`; кроме `TASKS_TASK` так же адресуются `SONET_GROUP`
(группа/проект), `CRM`, `CALENDAR`, `MAIL`, `VIDEOCONF`, `CALL`:

```jsonc
bitrix_entity_chat { "entityType": "TASKS_TASK", "entityId": 28373 }   // → chatId
```

**Б. Через список чатов задач** (секция `tasksTask`; в `bitrix_chats_recent` их НЕТ):

```jsonc
bitrix_recent_load { "section": "tasksTask" }           // → чаты задач с chatId/dialogId
bitrix_recent_tail { "section": "tasksTask", "lastMessageDate": "2026-06-29T17:25:38+03:00" }
bitrix_chat_load   { "dialogId": "chat38849" }          // или { "chatId": 38849 }
```

**Чат пуст, а `COMMENTS_COUNT > 0`** — задача старше чатов задач: в чате только системное сообщение
«Чтобы прочитать комментарии, которые ранее оставили участники задачи…», а само обсуждение лежит в
форуме → `bitrix_task_comments` (§5.6).

**В. Поиском по названию задачи** (запасной, матч по тексту):
`bitrix_entity_search { "query": "трекер", "section": "tasksTask" }`

**Чат ПРОЕКТА задачи** (обсуждение группы, не самой задачи) — через `GROUP_ID`:

```jsonc
bitrix_task_get    { "taskId": 4229, "params": { "select": ["ID","GROUP_ID"] } }
bitrix_project_get { "groupId": 15 }                    // отдаёт CHAT_ID / DIALOG_ID
bitrix_chat_get_dialog_id { "externalId": "sg15" }      // либо резолв dialogId соцгруппы напрямую
```

### 5.3. Поиск чата / пользователя

`bitrix_entity_search` (обёртка над внутренним `ui.entityselector.doSearch`) сам собирает диалог
`IM_CHAT_SEARCH` и `searchQuery` из строки. Публичные аналоги: люди — `user.get`/`user.search`, чаты —
`im.recent.list` + фильтрация у себя.

```jsonc
bitrix_entity_search { "query": "дмитрий" }                        // среди всех чатов/диалогов
bitrix_entity_search { "query": "трекер", "section": "tasksTask" } // среди чатов задач
bitrix_user_get      { "userId": 11 }                              // резолв authorId → имя
```

### 5.4. Созвон: резюме, расшифровка, запись

AI-анализ звонка (BitrixGPT Follow-Up) живёт на серверно отрендеренной странице `/call/detail/<callId>`
— JSON-эндпоинта под ней нет, публичного REST для видеовстреч тоже (📖 только телефония `voximplant.*`
и `crm.activity.call.getTranscript`). Мост читает эту страницу и разбирает её в нормализованный JSON.

**1) Найти звонки.** Серверного поиска звонков по порталу нет — ищем в конкретном чате: звонок
оставляет системное сообщение с `params.COMPONENT_PARAMS = { messageType: "START", callId }`.

```jsonc
bitrix_chat_calls { "chatId": 9876 }                                      // чат проекта: bitrix_project_get → CHAT_ID
bitrix_chat_calls { "chatId": 9876, "maxPages": 10, "beforeId": 5001 }    // продолжить вглубь (maxPages ≤ 10)
```

Ответ: `calls[] { callId, startedAt, startedBy, startMessageId, events[], summaryMessageId }` плюс
`scannedPages` / `oldestScannedMessageId` / **`reachedHistoryStart`** — если он `false`, история
дочитана НЕ до конца, продолжай с `beforeId: <oldestScannedMessageId>`.

**2) Взять всё по звонку.**

```jsonc
bitrix_call_detail { "callId": 4242 }                            // всё; длинная расшифровка уедет в файл
bitrix_call_detail { "callId": 4242, "transcript": "inline" }    // расшифровка прямо в ответе
bitrix_call_detail { "callId": 4242, "transcript": "none" }      // расшифровка не нужна вовсе
bitrix_call_detail { "callId": 4242, "transcript": "file" }      // всегда в файл, даже короткая
```

| Поле ответа | Что внутри |
|---|---|
| `title`, `agenda`, `meetingType` | тема, вступление, тип встречи («Статус-встреча») |
| `date`, `interval`, `duration` | «23 июля, 15:46», «15:46 - 16:51», «1 ч 4 мин» |
| `efficiency`, `qualityChecklist[]` | оценка встречи в % и критерии `{ ok, text }` |
| `participants[]` | `{ id, name, talkTimePercent, talkTime, efficiency, metrics[], insight }` |
| `overview`, `chapters[]` | общее резюме и главы `{ from, to, title, text }` с таймкодами |
| `decisions[]`, `tasks[]` | «что решили» и задачи `{ assigneeId, assignee, text }` |
| `transcript[]`, `transcriptCount` | реплики `{ from, to, speakerId, speaker, text }` |
| `recording` | `{ path, url, trackId }` — аудиозапись, качается `bitrix_call_recording` (§5.5) |

**Расшифровка длинного звонка не приходит в ответе.** У часовой встречи она даёт ~70 КБ из 80 КБ, поэтому
свыше ~20 КБ (режим `"auto"` = умолчание) пишется на диск, а в ответе остаются `transcript: []`,
`transcriptCount` и **`files`**: `files.transcript` — `call-<id>-transcript.txt`, где строка = реплика
(`[11:10—11:24] Имя Фамилия: …`), её удобно **грепать** (найденная строка сама несёт таймкод и
спикера); `files.json` — полный ответ с расшифровкой. Оба файла — кеш звонка, перезаписываются.

Тонкости:
- **`speakerId`** резолвится по имени из таблицы анализа; кто говорил мало и в неё не попал — получит
  `speakerId: null`, но останется в `participants` с `id: null`.
- **`assigneeId` задачи** — упомянутый в тексте пользователь, а НЕ id смотрящего.
- Нет доступа к звонку / протухла сессия → инструмент вернёт внятную ошибку (портал отдаёт HTML логина).

### 5.5. Скачать файл (вложение чата, файл задачи, запись звонка)

Ссылки портал минтит и подписывает сам, но подпись НЕ заменяет авторизацию — качает расширение в
сессии пользователя.

```jsonc
// вложение чата: ссылку берём из files[].urlDownload в ответе bitrix_chat_load
bitrix_file_download { "url": "https://<портал>/bitrix/services/main/ajax.php?action=disk.api.file.download&…" }
bitrix_call_recording { "callId": 4242 }                        // аудиозапись созвона (ссылку найдёт сам)
bitrix_file_download { "url": "…", "savePath": "/tmp/photo.png", "overwrite": true }
```

Ответ — **путь, а не содержимое**: `{ path, bytes, contentType, fileName }` (гигабайты не попадают в
контекст). По умолчанию файл ложится в `~/.bitrix24-mcp-bridge/downloads/`; `savePath` без ведущего `/`
трактуется как имя внутри этой папки. Потолок — 512 МБ.

Тонкости:
- **Только ссылки на файлы** сконфигурированного портала: `/bitrix/services/main/ajax.php` с `action`
  `disk.api.file.download` / `disk.attachedObject.download` / `call.Track.download` или
  `/bitrix/tools/disk/uf.php` с `action` `download` / `show` / `downloadArchiveByEntity`. Чужой origin
  → `not a configured portal`; другой путь, другой, повторённый или `action[]` → `not a portal file
  link`. Бери ссылки из ответов моста, не собирай их сам.
- **Имя даёт портал** (`Content-Disposition`), поэтому без `savePath` угадывать его не нужно.
- **Повторное скачивание** того же файла падает с `already exists` — передай `overwrite: true`.

### 5.6. Старые комментарии задачи (форум)

До перехода на чаты задач обсуждение жило в форуме задачи, и у старых задач оно там и осталось: в
чате (`CHAT_ID`) только системная заглушка со ссылкой `/task/comments/<id>/`. Признак — в
`bitrix_task_get` поле `COMMENTS_COUNT > 0` (через `params.select`; `FORUM_TOPIC_ID` тоже заполнен),
а чат пуст. JSON-метода чтения нет — мост разбирает HTML-страницу комментариев.

```jsonc
bitrix_task_comments { "taskId": 1234 }                          // всё обсуждение; длинное уедет в файл
bitrix_task_comments { "taskId": 1234, "limit": 10 }             // только 10 последних
bitrix_task_comments { "taskId": 1234, "output": "inline" }      // всегда в ответе
bitrix_task_comments { "taskId": 1234, "beforeId": 5678 }        // продолжить вглубь от id
```

Ответ: `comments[]` по порядку (старые → новые) — `{ id, authorId, author, date, dateIso, text, isNew,
system, files[] }`, плюс `total`, `oldestId`, `scannedPages` и **`reachedHistoryStart`**: если он
`false` (упёрлись в `maxPages` — умолчание и максимум 10 — или в `limit`), продолжай с `beforeId: <oldestId>`.

- **`system: true`** — служебные записи («вы назначены исполнителем», смена срока, пинги), не слова людей.
- **`date`** — как на портале («9 марта 2024 08:15»), **`dateIso`** — то же в `2024-03-09T08:15`
  (местное время портала; для «вчера, 12:00» и дат без года — `null`).
- **`files[]`** — `{ attachedId, name, size, url }`; `url` скармливай `bitrix_file_download` (§5.5).
- **`text`** — без разметки; у ссылки с подписью адрес дописан в скобках: «макет (https://…)».
- **Длинное обсуждение не приходит в ответе** (как расшифровка звонка, §5.4): свыше ~20 КБ (`output:
  "auto"` = умолчание) в ответе `comments: []` и `files`: `files.text` — `task-<id>-comments.txt`,
  строка = комментарий (`#5678 [2024-03-09T08:15] Имя (id 101): текст`, переносы — ` ⏎ `), её удобно
  грепать; `files.json` — полный ответ. `output: "file"` — всегда в файл.
- **Прочитанным ничего не помечается.** Портал отмечает комментарии отдельным действием
  `readComment`, которое шлёт JS страницы при прокрутке; мост JS не исполняет. Проверено:
  `viewedDate` задачи после чтения не меняется. `isNew: true` — комментарий не прочитан пользователем.
- Нет доступа к задаче / протухла сессия → внятная ошибка (портал отдаёт HTML логина).

---

Не хватает инструмента под нужное действие — скажи пользователю: новые операции добавляет
мейнтейнер моста (процесс — `docs/reconnaissance.md` в репозитории моста).
