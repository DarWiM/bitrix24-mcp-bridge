# Bitrix24 API notes (reverse-engineered)

Как агенту работать с Bitrix24 через этот мост: формат `params`, имена полей, готовые цепочки вызовов.

Две поверхности API. **Публичный REST** (`tasks.task.*`, `im.recent.list`, `im.user.get`, `im.chat.get`,
`socialnetwork.api.workgroup.*`) — есть официальные доки, ссылки на них помечены **📖**
([`apidocs.bitrix24.com`](https://apidocs.bitrix24.com); агенту с MCP context7 — библиотека
`/bitrix24/b24restdocs`). **Внутренние ajax-контроллеры** (`im.v2.*`, `tasks.v2.*`, `ui.entityselector.*`)
публичных доков не имеют — всё ниже добыто живым реверсом; конверт и регистр полей у них могут
отличаться от 📖-аналогов. Имена полей стандартны для облачного Bitrix24; на другом портале сверяйся
реверсом (`docs/reconnaissance.md`).

---

## 1. Как вызывать

- **Типизированные инструменты** (`bitrix_tasks_list`, `bitrix_task_get`, `bitrix_chat_load`, …) —
  обёртки с разумными дефолтами; их полный список и описания видны среди MCP-инструментов. Точная
  выборка — опциональным `params`: он мержится **последним** и перекрывает дефолты.
- **`bitrix_call { name, params }`** — любое имя из каталога (`actions.json`), `params` в нативном
  формате Bitrix (§3). Полный список имён отдаёт сам `bitrix_call` в своём описании.
- Каталог может содержать **мутирующие** вызовы: наличие записи = разрешение вызвать. Это не режим
  «только чтение».
- У обёрток есть дефолты (напр. `bitrix_tasks_list` сортирует `{"ID":"desc"}`), у `bitrix_call` их нет —
  один и тот же фильтр даст разные страницы. Сравниваешь выдачи — задавай `order` явно.
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

## 3. Каталог: имя → action → params

Форма `params` различается по методу: где-то плоско, где-то вложенно, где-то обёрнуто в `params[…]` —
колонка «params» показывает точную форму (кодирование тела мост берёт на себя).

| Имя (`bitrix_call`) | action / endpoint | params | Пагинация |
|---|---|---|---|
| `tasks.list` | `tasks.task.list` | верхний уровень: `filter{RESPONSIBLE_ID,REAL_STATUS,GROUP_ID,…}`, `select[]`, `order{}` | **`PAGEN_1`** — номер страницы (1, 2, 3…), страница = 20 задач; `start` **не работает** (вернёт ту же первую страницу) |
| `task.get` | `tasks.task.get` | верхний уровень: `taskId`, `select[]` | — |
| `task.v2.get` | `tasks.v2.Task.get` | вложенно: `{"task":{"id":N}}` | — |
| `task.scrum.info` | `tasks.v2.Scrum.getTaskInfo` | `{"taskId":N}` | — |
| `task.files` | `tasks.v2.File.listObjects` | `{"ids":[N,…]}` | — |
| `task.views.count` | `tasks.v2.Task.View.User.count` | вложенно: `{"task":{"id":N}}` | — |
| `task.subtasks` | `tasks.v2.Task.Relation.Child.list` | `{"taskId":N,"withIds":true,"navigation":{"size":N}}` | `navigation` |
| `task.related` | `tasks.v2.Task.Relation.Related.list` | как `task.subtasks` | `navigation` |
| `projects.list` | `socialnetwork.api.workgroup.list` | верхний уровень: `select[]`, `order{}`, `filter{}` | `start` (шаг 50; `start=(N-1)*50`, `-1` — ответ без `total`) 📖 |
| `projects.get` | `socialnetwork.api.workgroup.get` | **обёрнуто**: `params[groupId]`, `params[select][]` | — |
| `chats.recent` | `/rest/im.recent.list.json` | плоско: `LIMIT`, `SKIP_OPENLINES`, `UNREAD_ONLY` | `LIMIT` |
| `recent.load` | `im.v2.Recent.load` | плоско: `limit`, `filter[recentSection]` (`tasksTask`/`collab`/…), `filter[unread]`, `filter[parentId]` | `recent.tail` |
| `recent.tail` | `im.v2.Recent.tail` | плоско: `limit`, `filter[lastMessageDate]` (курсор), `filter[recentSection]` | `filter[lastMessageDate]` |
| `chat.load` | `im.v2.Chat.load` | плоско: `dialogId`\|`chatId`, `messageLimit` | — |
| `chat.dialogId` | `im.v2.Chat.getDialogId` | плоско: `externalId` (напр. `"sg"+groupId`) | — |
| `chat.messages` | `im.v2.Chat.Message.list` | плоско: `chatId`, `limit` | только последняя страница — назад **не листает**, используй `chat.messages.tail` |
| `chat.messages.tail` | `im.v2.Chat.Message.tail` | плоско: `chatId`, `limit`, `filter[lastId]`, `order[id]` | `filter[lastId]` (§5.1) |
| `chat.message.read` | `im.v2.Chat.Message.read` | плоско: `chatId`, `ids[]`, `actionUuid` | ⚠ мутирующий |
| `chat.read.all` | `im.v2.Chat.readAll` | без параметров | ⚠ мутирующий |
| `im.user.get` | `/rest/im.user.get.json` | плоско: `ID` | — |
| `im.chat.get` | `/rest/im.chat.get.json` | плоско: `ENTITY_TYPE`, `ENTITY_ID` (напр. `TASKS_TASK`+taskId) | — |
| `entityselector.load` | `ui.entityselector.load` | `{"dialog":{entities,preselectedItems,…}}` | — |
| `entityselector.search` | `ui.entityselector.doSearch` | `{"dialog":{…},"searchQuery":{"query":"…","queryWords":["…"]}}` | — |
| `call.detail` | `GET /call/detail/{callId}` | `callId` (подставляется в путь), `IFRAME=Y`, `IFRAME_TYPE=SIDE_SLIDER` → HTML | см. §5.4 |

---

## 4. Справочник полей

**Задача** (`tasks.task.*`) — поля для `select`/`filter` в UPPER_CASE: `ID`, `TITLE`, `DESCRIPTION`,
`STATUS`, `REAL_STATUS`, `RESPONSIBLE_ID`, `CREATED_BY`, `CREATED_DATE`, `CHANGED_DATE`, `DEADLINE`,
`CLOSED_DATE`, `PRIORITY`, `GROUP_ID`, `TAGS`, `TIME_ESTIMATE`, **`CHAT_ID`** (id чата-обсуждения
задачи — прямой резолвер `taskId → chatId`, §5.2), `UF_*`. Ответ подкладывает объекты `group`,
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
> `SPRINT_ID`/`STAGE_ID` у себя. Метода «колонки scrum-доски» (`STAGE_ID` → имя колонки) в каталоге нет.

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
                                "order": {"DEADLINE":"asc"}, "start": 50 } }

// карточка задачи с расширенным набором полей; v2-подсистема; файлы, просмотры, связи
bitrix_task_get    { "taskId": 4229, "params": { "select": ["ID","TITLE","DESCRIPTION","TAGS"] } }
bitrix_task_get_v2 { "taskId": 4229 }                       // → { "task": { "id": 4229 } }
bitrix_call { "name": "task.files", "params": { "ids": [4229] } }
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
bitrix_chat_calls { "chatId": 9876, "maxPages": 20, "beforeId": 5001 }    // продолжить вглубь
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
(`[11:10—11:24] Генрих Богацкий: …`), её удобно **грепать** (найденная строка сама несёт таймкод и
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
- **Граница безопасности — origin**: скачивается только с origin сконфигурированного портала.
- **Имя даёт портал** (`Content-Disposition`), поэтому без `savePath` угадывать его не нужно.
- **Повторное скачивание** того же файла падает с `already exists` — передай `overwrite: true`.

---

Расширение каталога новыми методами, транспорт (`bodyType`, `responseType`, path-параметры) и
доставка правок в живой daemon — `docs/reconnaissance.md`.
