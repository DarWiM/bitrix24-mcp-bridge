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
- **Мутирующие** операции (⚠ в §3, полный список — после таблицы) меняют данные на портале от имени
  пользователя, сразу и без отмены. По умолчанию они включены; пользователь может выключить их
  переключателем мутаций — тогда вызов вернёт ошибку `operation <имя> changes data, but mutations are
  disabled…`; это настройка пользователя, обойти её нельзя — сообщи пользователю. Включены ли они сейчас —
  поле `mutations` в `bitrix_status`. Операции чтения переключатель не трогает.
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
| `bitrix_task_description_set` ⚠ | **заменить** описание задачи целиком (`""` — очистить) | `taskId`, `text` (≤ 100 000) | без `params`; разметка — BBCode описания (ниже); описание перечитывается, ответ `{ taskId, length }` |
| `bitrix_task_description_append` ⚠ | **дописать** в конец описания через пустую строку; старое (файлы `[disk file id=…]`, таблицы) не трогает | `taskId`, `text` (≤ 100 000) | без `params`; описание перечитывается, ответ `{ taskId, length }` |
| `bitrix_task_description_replace` ⚠ | **точечная правка** описания: фрагмент `find` → `replace` (`""` — удалить фрагмент), остальное как было | `taskId`, `find`, `replace`, `all?` | без `params`; `find` — точная подстрока сырого BBCode (`bitrix_task_get_v2` → `description`), с регистром и переводами строк. Нет совпадений или их больше одного без `all: true` — ошибка, ничего не записано. Описание перечитывается; ответ `{ taskId, replaced, length }` |
| `bitrix_task_tags` ⚠ | добавить / убрать **теги** | `taskIds[]` (1–50), `add[]?`, `remove[]?` — названия, без учёта регистра | без `params`; пакетный ответ (ниже), поля `tags`, `changed` |
| `bitrix_task_checklist` | **чек-лист** задачи плоским списком `{ taskId, items: [{ id, parentId, title, done }] }` | `taskId` | без `params`; `parentId: 0` — группа, остальные — пункты группы `parentId` |
| `bitrix_task_checklist_edit` ⚠ | изменить чек-лист: добавить, переименовать, отметить / снять отметку, удалить | `taskId`, `add[]?` (названия), `rename[{ itemId, title }]?`, `complete[]?`, `reopen[]?`, `remove[]?` | без `params`; id — из `bitrix_task_checklist`; ≤ 50 действий за вызов; ответ `{ taskId, added, items }` (перечитан) |
| `bitrix_task_plan` ⚠ | **планируемые** даты начала / завершения | `taskId`, `start?`, `end?` — дата (ниже) или `null` (очистить) | без `params`; хотя бы одна; не переданная остаётся как есть; `start` не позже `end`; ответ `{ taskId, start, end }` |
| `bitrix_task_priority` ⚠ | **важность**: `high` — «Важная задача», `average` — обычная | `taskIds[]` (1–50), `priority` | без `params`; пакетный ответ, поле `priority` |
| `bitrix_task_deadline` ⚠ | **крайний срок** | `taskIds[]` (1–50), `deadline` — дата или `null` (убрать), `reason?` (причина переноса, простой текст ≤ 1000) | без `params`; пакетный ответ, поле `deadline` |
| `bitrix_task_close` ⚠ | **закрыть** задачу; Definition of Done не обходится — два шага, §5.7 | `taskId`; шаг 2 — плюс `typeId`, `confirmItems: true` | без `params`; ответ `{ taskId, status, changed, typeId? }` или `{ taskId, needsConfirmation: true, types }` |
| `bitrix_task_reopen` ⚠ | **возобновить** завершённые задачи | `taskIds[]` (1–50) | без `params`; пакетный ответ, поля `status`, `changed` |
| `bitrix_task_result_add` ⚠ | добавить один и тот же **результат** задачам: закреплён в карточке, анонс в чате задачи | `taskIds[]` (1–50), `text` (≤ 20 000) | без `params`; пакетный ответ (ниже), поле `resultId` |
| `bitrix_task_file_attach` ⚠ | прикрепить **локальный файл** к задаче, §5.8 | `taskId`, `path` (абсолютный), `name?` | без `params`; файл ≤ 10 МБ уходит на Диск пользователя; ответ `{ taskId, diskFileId, name, size, attachmentId }` |
| `bitrix_task_mute` ⚠ | выключить (`true`) / включить (`false`) **свои** уведомления по задаче | `taskId`, `muted` | без `params`; ответ `{ taskId, muted }` |
| `bitrix_task_reminders` | напоминания по задаче, §5.9 | `taskId` | без `params` |
| `bitrix_task_reminder_set` ⚠ | поставить новое **своё** напоминание или изменить своё (`reminderId`) | `taskId`, `at` (дата в будущем), `via` (`notification` \| `email`), `reminderId?` | без `params`; ответ `{ taskId, reminder }` |
| `bitrix_task_reminder_delete` ⚠ | удалить **своё** напоминание | `taskId`, `reminderId` | без `params`; ответ `{ taskId, reminderId, deleted: true }` |
| *Участники задач* | | | |
| `bitrix_task_delegate` ⚠ | **делегировать**: `userId` становится ответственным | `taskIds[]` (1–50), `userId` | без `params`; пакетный ответ, поле `responsibleId` (перечитан) |
| `bitrix_task_accomplices` / `bitrix_task_auditors` ⚠ | добавить / убрать **соисполнителей** / **наблюдателей** | `taskIds[]` (1–50), `add[]?`, `remove[]?` — userId | без `params`; пакетный ответ, поля `accomplices` / `auditors` (перечитаны), `changed` |
| `bitrix_user_find` | найти пользователей по фамилии `[{ id, name, lastName, active, workPosition }]` | `lastName` | без `params`; в выдаче и **неактивные** (уволенные, `active: false`) — не назначай их на рабочие задачи |
| *Связи задач* | | | |
| `bitrix_task_related_edit` ⚠ | добавить / убрать **связанные** задачи (блок «Связанные задачи») | `taskId`, `add[]?`, `remove[]?` — id задач | без `params`; ответ `{ taskId, related, changed }`; задачи со 100 и более связанными не правятся |
| `bitrix_task_parent` ⚠ | сделать **подзадачей** задачи `parentId`; `null` — отвязать от родителя | `taskId`, `parentId` | без `params`; ответ `{ taskId, parentId, previousParentId, changed }` |
| `bitrix_task_gantt_link` ⚠ | связь Ганта «окончание → начало»: `dependentId` начинается после завершения `taskId` | `taskId`, `dependentId`, `remove?`, `type?` (только `"finish_start"`, только при добавлении) | без `params`; отдельную связь прочитать нельзя — проверка по признаку «у `dependentId` есть связи Ганта»: `confirmed: true` — подтверждено, `confirmed: false` + `note` — подтвердить нельзя (у задачи были / остались другие связи); нет связей после добавления — ошибка; ответ `{ taskId, dependentId, linked, confirmed, note? }` |
| *Scrum* | | | |
| `bitrix_sprint_columns` | колонки доски **активного** спринта `[{ id, name, type }]` | `groupId` (= `GROUP_ID` задачи) | без `params`; `type` — `NEW`/`WORK`/`FINISH`, у своих колонок пустой; в колонку `FINISH` операции задачи не ставят |
| `bitrix_task_move` ⚠ | перенести задачи в колонку спринта | `taskIds[]` (1–50), `column` (id или название, без учёта регистра) | без `params`; колонку типа `FINISH` указать нельзя — закрывай через `bitrix_task_close`; пакетный ответ (ниже), поля `stageId`, `column`, `status` — перенос может переоткрыть закрытую задачу |
| `bitrix_task_to_sprint` ⚠ | поставить задачи на доску **активного** спринта: из бэклога — в спринт и в колонку, уже стоящие в нём — в колонку | `taskIds[]` (1–50), `column?` (без него — колонка типа `NEW`) | без `params`; колонку типа `FINISH` указать нельзя — закрывай через `bitrix_task_close`; пакетный ответ, поля `sprintId`, `stageId`, `column`, `status`, `fromBacklog`; задачи других спринтов — ошибка |
| `bitrix_task_to_backlog` ⚠ | вернуть задачи в **бэклог** проекта | `taskIds[]` (1–50) | без `params`; пакетный ответ, поля `backlogId`, `changed` |
| `bitrix_task_create` ⚠ | **создать** задачу сразу на доске активного спринта, как «+» на доске | `groupId`, `title` (≤ 255, простой текст), `column?` (без него — колонка типа `NEW`) | без `params`; колонку типа `FINISH` указать нельзя; ответ `{ taskId, sprintId, stageId, column }`; остальные поля — потом отдельными операциями |
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
| `bitrix_chat_send` ⚠ | отправить сообщение (видят все участники чата) | `chatId` \| `dialogId` (ровно одно), `text` (≤ 20 000), `replyTo?` (id сообщения этого чата — ответ на него) | без `params`; разметка — подмножество чата (ниже); ответ `{ chatId?, dialogId, messageId }` |
| `bitrix_chat_message_edit` ⚠ | заменить текст **своего** сообщения целиком | `messageId`, `text` (≤ 20 000, не пустой) | без `params`; чужое сообщение Bitrix изменить не даст — ошибка |
| `bitrix_chat_reaction` ⚠ | поставить реакцию на сообщение | `messageId`, `reaction` (латиница; проверены `like` 👍, `whiteHeavyCheckMark` ✅) | без `params`; другие имена уходят как есть, без проверки |
| `bitrix_task_chat_post` ⚠ | одно и то же сообщение в **чаты задач** (чат каждой — по её `CHAT_ID`) | `taskIds[]` (1–50), `text` (≤ 20 000) | без `params`; пакетный ответ, поля `chatId`, `messageId`; задача без чата — ошибка этой задачи |
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

**Мутирующие операции** (⚠) — по умолчанию включены:

- задачи: `bitrix_task_description_set`, `bitrix_task_description_append`,
  `bitrix_task_description_replace`, `bitrix_task_tags`, `bitrix_task_checklist_edit`, `bitrix_task_plan`,
  `bitrix_task_priority`, `bitrix_task_deadline`, `bitrix_task_close`, `bitrix_task_reopen`,
  `bitrix_task_result_add`, `bitrix_task_file_attach`, `bitrix_task_mute`, `bitrix_task_reminder_set`,
  `bitrix_task_reminder_delete`;
- участники: `bitrix_task_delegate`, `bitrix_task_accomplices`, `bitrix_task_auditors`;
- связи: `bitrix_task_related_edit`, `bitrix_task_parent`, `bitrix_task_gantt_link`;
- scrum: `bitrix_task_move`, `bitrix_task_to_sprint`, `bitrix_task_to_backlog`, `bitrix_task_create`;
- чаты: `bitrix_chat_send`, `bitrix_chat_message_edit`, `bitrix_chat_reaction`, `bitrix_task_chat_post`,
  `bitrix_chat_mark_read`, `bitrix_chat_read_all`.

Выключает их пользователь (агенту это недоступно): `"mutations": false` в `config.json` моста, env
`BITRIX_MCP_MUTATIONS=off` у процесса daemon (перекрывает `config.json`) или `setup` → `[m]`. Текущее
состояние — `bitrix_status` → `mutations`; выключенная операция отвечает ошибкой из §1 и в Bitrix24 не
уходит. `bitrix_task_comments` ничего не помечает прочитанным и мутирующим не считается.

**Каждая мутация — от имени пользователя, сразу и без отмены.** Делай только то, о чём он просил; если
просьба шире или неоднозначна (кого назначить, какую задачу закрыть, какой файл отправить) — сначала
спроси. Уведомление, ушедшее человеку, не отзывается.

**Пакетные операции** (`taskIds[]`, 1–50 id без повторов: `bitrix_task_tags`, `bitrix_task_priority`,
`bitrix_task_deadline`, `bitrix_task_reopen`, `bitrix_task_result_add`, `bitrix_task_delegate`,
`bitrix_task_accomplices`, `bitrix_task_auditors`, `bitrix_task_move`, `bitrix_task_to_sprint`,
`bitrix_task_to_backlog`, `bitrix_task_chat_post`) обрабатывают задачи по очереди и отвечают
`{ results: [{ taskId, ok, error?, …поля операции }] }` в порядке `taskIds`. Ошибка одной задачи
(`ok: false`, текст в `error`) не останавливает остальные — проверяй `ok` у каждой. Сама операция
падает целиком только на неверных аргументах (и на колонке типа `FINISH` у `bitrix_task_move` /
`_to_sprint` — тогда не тронута ни одна задача). Ближе к концу отведённого времени пакет перестаёт
начинать новые задачи: они приходят с `ok: false` и «не выполнено: истекло время пакета…» — повтори
только их, перечитав состояние. Результаты и сообщения неидемпотентны: повтор создаст дубль.

**Ошибка после записи — не повод повторять вслепую.** Большинство мутаций перечитывают то, что
записали, и по тексту ошибки видно, что случилось:

- «…ничего не изменено / ничего не записано / ничего не удалено», ошибки аргументов
  (`invalid arguments…`) — запроса на запись не было; поправь аргументы и вызывай снова.
- «запись отправлена, но перечитать не удалось (проверь через …)» и его варианты («перенос /
  делегирование / закрытие / возобновление отправлено, но перечитать задачу не удалось») — запись ушла,
  а итог неизвестен: проверь названным инструментом, не повторяй.
- «сообщение могло уйти», «задача могла создаться», «результат мог добавиться», «файл мог загрузиться
  на Диск», «вложение могло создаться», «напоминание могло создаться» — портал мог всё сделать, но ответа
  не дал (таймаут, неожиданный ответ): сначала проверь (чат, доска спринта, карточка задачи, Диск, файлы
  задачи, `bitrix_task_reminders`), повтор без проверки создаст дубль.
- «Bitrix ответил успехом, но …», «Bitrix не применил: …» — перечитанное состояние не то, что просили; в
  ошибке — как сейчас. Не повторяй тот же вызов вслепую — скажи пользователю.
- Многошаговые правки называют, что уже сделано: `bitrix_task_checklist_edit` — «до этого сделано: …»,
  `bitrix_task_parent` — прежнего родителя и вызов, которым его вернуть, `bitrix_task_to_sprint` — «верни
  её в бэклог (`bitrix_task_to_backlog`) и повтори».

**Списки целиком.** Соисполнителей, наблюдателей, теги и описание Bitrix хранит и перезаписывает
целиком, поэтому `bitrix_task_accomplices`, `bitrix_task_auditors`, `bitrix_task_tags`,
`bitrix_task_description_append` / `_replace` сами читают текущее значение **каждой** задачи, меняют в нём
только названное и записывают обратно; если прочитать не удалось — ничего не пишут. Передавай только
`add` / `remove` (фрагмент, дописку), а не весь список; если менять нечего — `changed: false`, записи нет.
Так же `bitrix_task_related_edit` добавляет и убирает только названные связи, а `bitrix_task_plan`
сохраняет непереданную дату. `bitrix_task_description_set` — единственная, что заменяет описание целиком.

**Кто это увидит и кого уведомят.**

| Операции | Видят | Уведомление |
|---|---|---|
| `bitrix_chat_send`, `bitrix_task_chat_post` | все участники чата | упомянутым `[user=ID]Имя[/user]` |
| `bitrix_chat_message_edit`, `bitrix_chat_reaction` | все участники чата | не проверено (новое упоминание при правке; автору — о реакции) |
| `bitrix_task_delegate` | история задачи | новому ответственному |
| `bitrix_task_accomplices`, `bitrix_task_auditors` | история задачи | каждому добавленному |
| `bitrix_task_close`, `bitrix_task_reopen` | все, кто видит задачу | участникам задачи |
| `bitrix_task_result_add` | карточка задачи; анонс в её чате видят все его участники | — |
| описание, теги, важность, срок, планируемые даты | все, кто видит задачу; история задачи | — |
| `bitrix_task_checklist_edit`, связи, родитель, связь Ганта | все, кто видит задачу | — |
| `bitrix_task_file_attach` | все, кто видит задачу (и могут скачать) | — |
| `bitrix_task_create`, `bitrix_task_move`, `_to_sprint`, `_to_backlog` | участники проекта на scrum-доске | — |
| `bitrix_task_mute`, напоминания | **только ты** | только тебе (напоминания) |

«—» — не проверено: операция об уведомлениях ничего не утверждает, но Bitrix может сам слать
участникам уведомления об изменении задачи. Чат задачи — `CHAT_ID` из `bitrix_task_get` (или
`bitrix_entity_chat { entityType:"TASKS_TASK" }`). userId для участников — `bitrix_user_find` (по
фамилии) или поля задачи; людей из выдачи `bitrix_user_find` с `active: false` на рабочие задачи не
назначай.

**`bitrix_task_move`** работает только для задачи, которая уже на доске спринта (не в бэклоге):
`task.stages.movetask` отвечает `true`, ничего не сделав, — мост перечитывает задачу и в этом случае
возвращает ошибку по этой задаче. Задачу из бэклога ставит на доску `bitrix_task_to_sprint` (переносит в
активный спринт, ставит на доску, перечитывает спринт и колонку); задачи запланированных и завершённых
спринтов он не трогает. Если перенос отправлен, а перечитать задачу не удалось, ошибка так и говорит —
колонку тогда проверь через `bitrix_task_get`. `task.stages.get` отдаёт старый канбан группы, а не
колонки спринта. Перенос в колонку может переоткрыть закрытую задачу — смотри `status` в ответе.

**Колонка типа `FINISH`** (обычно «Готово», см. `type` в `bitrix_sprint_columns`) завершает задачу,
а Definition of Done спрашивает только всплывающее окно веб-интерфейса. Поэтому `bitrix_task_move`,
`bitrix_task_to_sprint` и `bitrix_task_create` такую колонку не принимают — ни по названию, ни по id:
«колонка «…» завершает задачу — закрыть задачу можно только через `bitrix_task_close` …; ничего не
изменено». У пакетных операций отказ — на весь вызов: сначала читаются все задачи, и если колонка
хоть у одной из них (в её проекте) — `FINISH`, не переносится ни одна. Закрыть задачу —
`bitrix_task_close` (§5.7).

**Даты** (`bitrix_task_plan`, `bitrix_task_deadline`, `bitrix_task_reminder_set`) — ISO 8601 **со
смещением**: `"2026-12-01T09:00:00+03:00"` или `"…Z"`; без смещения — ошибка аргументов. В ответе даты в
UTC. Bitrix хранит время задач с точностью до минуты: секунды не считаются расхождением.

**Разметка текста.**

- **Описание задачи** (`bitrix_task_description_*`) и **результат** (`bitrix_task_result_add`) — полный
  BBCode: `[b] [i] [u] [s]`, `[url=…]…[/url]`, `[user=ID]Имя[/user]`, списки `[list]` / `[list=1]` с
  пунктами `[*]`, `[quote]`, `[code]`, `[spoiler=Заголовок]…[/spoiler]`, таблицы `[table][tr][th]/[td]`.
  Теги `[disk file id=…]` — это прикреплённые файлы, сохраняй их. Как BBCode результата выглядит в его
  карточке в чате, не проверено.
- **Сообщение в чат** (`bitrix_chat_send`, `bitrix_chat_message_edit`, `bitrix_task_chat_post`) — только
  то, что рендерят и веб, и мобильное приложение: `[b] [i] [u] [s]`, `[url=…]…[/url]`,
  `[user=ID]Имя[/user]`, `[code]`, `[color=#hex]…[/color]`, `[br]`. Цитата — строка, начинающаяся с `>>`,
  или блок между двумя строками из дефисов; список — строки, начинающиеся с `•`. `[quote]`, `[list]`,
  `[spoiler]`, таблицы и Markdown в чате **не рендерятся**. Длиннее 20 000 символов Bitrix молча обрежет —
  мост такое не отправит.
- **Простой текст:** название задачи (`bitrix_task_create` — BBCode в названии не работает), теги, причина
  переноса срока. Названия пунктов чек-листа — тоже простой текст (как в них рендерится BBCode, не
  проверено).
- Markdown не рендерится нигде.

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
> `SPRINT_ID`/`STAGE_ID` у себя. `STAGE_ID` → имя колонки — `bitrix_sprint_columns { groupId }` (§3).

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

### 5.7. Закрыть задачу: Definition of Done

В scrum-проекте задача закрывается через критерии готовности (DoD), как в карточке задачи, и **мост их
не обходит**: отметить критерии выполненными может только второй вызов — после явного согласия
пользователя. Перенос в колонку типа `FINISH` закрыл бы задачу мимо DoD, поэтому операции доски такую
колонку не принимают (§3) — закрывай только так.

```jsonc
// шаг 1
bitrix_task_close { "taskId": 4229 }
// не scrum-проект или DoD не нужен → задача сразу закрыта: { taskId, status: 5, changed: true }
// DoD нужен → задача НЕ закрыта:
// { taskId, needsConfirmation: true,
//   types: [{ id: 1, name: "…", required: true, items: [{ title: "…", group: "…" }, …] }, …] }

// шаг 2 — только после «да» пользователя на критерии выбранного типа
bitrix_task_close { "taskId": 4229, "typeId": 1, "confirmItems": true }
// → { taskId, status: 5, changed: true, typeId: 1 }
```

- `types` — типы задач проекта и критерии каждого; `required: true` — DoD для типа обязателен. `group` —
  название группы чек-листа, в которой лежит критерий (сама группа в `items` не попадает). Покажи
  пользователю критерии и получи его явное согласие отметить их выполненными для выбранного типа. Сам за
  пользователя не решай: нет согласия — шаг 2 не вызывай. **Тип выбирает пользователь**: тип с
  `required: false` закроет задачу без обязательных критериев — его тоже бери только с согласия
  пользователя.
- На шаге 2 отмечаются **все** критерии типа, затем задача закрывается и статус перечитывается (не
  закрылась — ошибка). `typeId` и `confirmItems: true` передаются только вместе; задаче не из
  scrum-проекта они не нужны (ошибка — закрой её без них).
- Уже закрытая задача не трогается (`changed: false`). Закрытие видят все, кто видит задачу; участники
  получают уведомление. Возобновить — `bitrix_task_reopen { "taskIds": [4229] }`.
- «критерии DoD отмечены выполненными, но закрыть задачу не удалось» — критерии уже отмечены, задача
  открыта. «…— закрой задачу в интерфейсе» — мост не смог прочитать DoD из ответа Bitrix; предложи
  пользователю закрыть задачу в веб-интерфейсе.

### 5.8. Прикрепить локальный файл к задаче

```jsonc
bitrix_task_file_attach { "taskId": 4229, "path": "/tmp/report.pdf" }
bitrix_task_file_attach { "taskId": 4229, "path": "/tmp/out.csv", "name": "итоги.csv" }
// → { taskId, diskFileId, name, size, attachmentId }
```

- **Файл уходит с машины**: он загружается в корень Диска Битрикс24 пользователя и прикрепляется к
  задаче — его увидят и смогут скачать все, кто видит задачу. Прикрепляй только то, что пользователь
  явно попросил; любой другой файл — сначала спроси.
- `path` — **абсолютный** путь к обычному непустому файлу до 10 МБ: операция выполняется в процессе
  daemon, а не в твоём рабочем каталоге. `name` — имя в Битрикс24 (по умолчанию — из `path`, без
  разделителей пути); если имя на Диске занято, Битрикс24 добавит суффикс — итоговое имя в ответе.
- Из служебного каталога моста (`~/.bitrix24-mcp-bridge` или `BITRIX24_MCP_BRIDGE_HOME`; там настройки и
  токен) файлы не прикрепляются — в том числе через симлинк и из `downloads/`. Скачанный мостом файл
  сначала скопируй в другое место.
- Нужно право прикреплять файлы к задаче: тому, кто задачу только видит, Bitrix может отказать уже после
  загрузки. Если прикрепить не удалось, файл **остаётся на Диске** пользователя — ошибка называет его (имя
  и id); скажи об этом пользователю.
- «файл мог загрузиться на Диск» — проверь корневую папку Диска перед повтором; «вложение могло
  создаться» — проверь файлы задачи (`bitrix_task_get` с `select: ["UF_TASK_WEBDAV_FILES"]` →
  `bitrix_task_files`). После прикрепления файлы задачи перечитываются; вложения нет — ошибка.

### 5.9. Напоминания и свои уведомления по задаче

Напоминания и выключение уведомлений касаются **только текущего пользователя**: другие участники их не
видят и получают уведомления как прежде.

```jsonc
bitrix_task_reminders { "taskId": 4229 }
// → { taskId, reminders: [{ id, at, via, remindBy, recipient, userId, mine }] }
bitrix_task_reminder_set { "taskId": 4229, "at": "2026-12-01T09:00:00+03:00", "via": "notification" } // новое — тебе
bitrix_task_reminder_set { "taskId": 4229, "reminderId": 61, "at": "2026-12-02T06:00:00Z", "via": "email" }
bitrix_task_reminder_delete { "taskId": 4229, "reminderId": 61 }
bitrix_task_mute { "taskId": 4229, "muted": true }            // выключить свои уведомления по задаче
```

- Менять и удалять можно только **свои** напоминания — `mine: true` в `bitrix_task_reminders`; чужое или
  не этой задачи — ошибка, ничего не меняется.
- `at` — абсолютная дата **в будущем** (формат — «Даты», §3); `via` — `notification` (уведомление в
  Битрикс24) или `email`. Напоминание относительно срока (`remindBy: "deadline"`) после правки становится
  напоминанием на дату; получатель (`recipient`) остаётся прежним.
- После записи напоминание и состояние уведомлений перечитываются; если они не те — ошибка.

---

Не хватает инструмента под нужное действие — скажи пользователю: новые операции добавляет
мейнтейнер моста (процесс — `docs/reconnaissance.md` в репозитории моста).
