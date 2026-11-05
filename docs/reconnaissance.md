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
- **Запись** — в модуле своей области: `write.ts` (описание, люди, scrum-доска, создание, результат),
  `content.ts` (фрагмент описания, теги, чек-лист, даты), `relations.ts`, `chat.ts`, `lifecycle.ts`
  (закрытие / возобновление), `attributes.ts` (важность, срок, свои уведомления и напоминания), `files.ts`;
  общие хелперы — `board.ts`, `calls.ts`, `batch.ts`. Без `params` агента; пакет по задачам —
  `taskIdsArg()` + `forEachTask()` с бюджетом `"long"`; после записи — перечитать (ловушки ниже).
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
| `task_description_replace` ⚠ | ajax `tasks.v2.Task.get` → `/rest/tasks.task.update.json` | точная подстрока сырого `data.description`; замена через `split`/`join`, чтобы `$&` в тексте агента остался буквальным |
| `task_tags` ⚠ | ajax `tasks.v2.Task.get` → ajax `tasks.v2.Task.update` → `tasks.v2.Task.get` | json `{"task":{id, tags:[{name}]}}` — заменяет список целиком, `[]` очищает; классический `fields[TAGS]` не годится (ниже) |
| `task_checklist` | `/rest/task.checklistitem.getlist.json` | `TASKID`; поля UPPER_CASE `ID, PARENT_ID, TITLE, IS_COMPLETE` |
| `task_checklist_edit` ⚠ | `getlist` → `/rest/task.checklistitem.{add,update,complete,renew,delete}.json` по одному на действие → `getlist` | `add {TASKID, FIELDS{TITLE}}` → `result` = id (в пустой чек-лист Bitrix сам добавляет группу «BX_CHECKLIST_1»); `update {TASKID, ITEMID, FIELDS{TITLE}}` отвечает `null`; `complete`/`renew`/`delete {TASKID, ITEMID}` → `true`; удаление группы уносит её пункты |
| `task_plan` ⚠ | (ajax `tasks.v2.Task.get` →) ajax `tasks.v2.Task.Plan.update` → `tasks.v2.Task.get` | json `{"task":{id, startPlanTs, endPlanTs, matchesWorkTime:false, matchesSubTasksTime:false}}`, unix-секунды, `0` — нет даты; пишутся обе даты, поэтому непереданная читается заранее |
| `task_priority` ⚠ | ajax `tasks.v2.Task.update` → `tasks.v2.Task.get` | json `{"task":{id, priority}}`; в записи UI только `high` / `average` |
| `task_deadline` ⚠ | ajax `tasks.v2.Task.Deadline.update` → `tasks.v2.Task.get` | json `{"task":{id, deadlineTs, deadlineChangeReason}}`, `0` — без срока |
| `task_mute` ⚠ | `/rest/user.current.json` → ajax `tasks.v2.Task.Attention.mute` \| `.unmute` → `tasks.v2.Task.get` | json `{taskId}`; перечитывает `data.inMute` (id тех, кто выключил уведомления) |
| `task_reminders` | `user.current` → ajax `tasks.v2.Task.Reminder.list` | json `{taskId}` → `[{id, userId, nextRemindTs, remindBy, remindVia, recipient, …}]`; `mine` = `userId` текущего |
| `task_reminder_set` ⚠ | новое: `user.current` → `Reminder.add` → `Reminder.list`; с `reminderId`: `user.current` → `Reminder.list` → `Reminder.update` → `Reminder.list` | json `{"reminder":{id:"tmp<ms>", taskId, userId, nextRemindTs, remindBy:"date", remindVia, recipient:"myself", before:0}}` → `data.id`; `update` пишет напоминание целиком (`userId`, `recipient` — прежние) |
| `task_reminder_delete` ⚠ | `user.current` → `Reminder.list` → ajax `tasks.v2.Task.Reminder.delete` → `Reminder.list` | json `{"reminder":{id}}`; id напоминаний сквозные по порталу — сначала проверка, что оно у этой задачи и своё |
| `task_close` ⚠ | `/rest/tasks.task.get.json` → ajax `socialnetwork.api.workgroup.get` (`TYPE`) → ajax `bitrix:tasks.scrum.doD.*` → ajax `tasks.v2.Task.Status.complete` → `tasks.task.get` | DoD — ниже; закрытие json `{"task":{id}, "completeWithChecklist":true}` |
| `task_reopen` ⚠ | `tasks.task.get` → ajax `tasks.v2.Task.Status.renew` → `tasks.task.get` | json `{"task":{id}}`; перечитывает `STATUS` |
| `task_delegate` ⚠ | `/rest/tasks.task.delegate.json` → `/rest/tasks.task.get.json` | `{taskId, userId}`; перечитывает `RESPONSIBLE_ID`. Новый ответственный остаётся соисполнителем, если им был |
| `task_accomplices` / `task_auditors` ⚠ | `tasks.task.get` → `/rest/tasks.task.update.json` → `tasks.task.get` | `fields[ACCOMPLICES]` / `fields[AUDITORS]` заменяют список целиком; пустой — `""` (ниже) |
| `user_find` | `/rest/user.get.json` | `FILTER{LAST_NAME}`; находит и неактивных (а фильтр `ACTIVE:false` не находит никого) |
| `task_related_edit` ⚠ | ajax `tasks.v2.Task.Relation.Related.list` → `.Related.add` / `.Related.delete` → `list` | json `{taskId, tasks:[{id}], noOverride:false}` (у `delete` без `noOverride`); `list` — `withSubTasks:false`, `navigation{size:100}`; полная страница → отказ (список мог обрезаться) |
| `task_parent` ⚠ | `tasks.task.get` (`PARENT_ID`) → ajax `tasks.v2.Task.Relation.Child.delete` у старого родителя → `.Child.add` у нового → `tasks.task.get` | json `{taskId: <родитель>, tasks:[{id: <задача>}]}`, у `add` ещё `noOverride:false, relationKind:"parent"` |
| `task_gantt_link` ⚠ | ajax `tasks.v2.Task.Gantt.Dependence.check` → `.add`; или `.delete` | json `{"ganttLink":{taskId, dependentId}}` (+ `type:"finish_start"` у `add`); успех — только `data: true`, читающего метода нет |
| `chat_send` ⚠ | `/rest/im.message.add.json` | `DIALOG_ID` (`chatId` → `"chat"+id`), `MESSAGE`, `REPLY_ID?`; ответ `result` = id сообщения |
| `chat_message_edit` ⚠ | `/rest/im.message.update.json` | `{MESSAGE_ID, MESSAGE}` → `result: true`; пустой текст удалил бы сообщение — мост такой не пропускает |
| `chat_reaction` ⚠ | ajax `im.v2.Chat.Message.Reaction.add` | форма `{messageId, reaction}` → `data.result`; REST-метода реакций через сессию нет |
| `task_chat_post` ⚠ | `tasks.task.get` (`CHAT_ID`) → `/rest/im.message.add.json` | `DIALOG_ID: "chat"+CHAT_ID` |
| `sprint_columns` | `/rest/tasks.api.scrum.sprint.list.json` → `/rest/tasks.api.scrum.kanban.getStages.json` | `filter{GROUP_ID, STATUS:"active"}`, затем `sprintId`; не `task.stages.get` — он про канбан группы |
| `task_move` ⚠ | `/rest/tasks.task.get.json` → `sprint_columns` → `/rest/task.stages.movetask.json` → `/rest/tasks.task.get.json` | `movetask {id, stageId}`; перечитывает `STAGE_ID` — пустой `true` для задачи вне доски спринта → ошибка |
| `task_to_sprint` ⚠ | `/rest/tasks.api.scrum.task.get.json` → `tasks.api.scrum.backlog.get` → `sprint_columns` → из бэклога: `tasks.api.scrum.task.update` → `tasks.api.scrum.kanban.addTask` → `scrum.task.get`; затем `task.stages.movetask` → `tasks.task.get` | `task.update {id, fields{entityId: sprintId}}` меняет только контейнер; `addTask {sprintId, taskId, stageId}` ставит на доску, но колонку не меняет — без него `movetask` отвечает пустым `true` |
| `task_to_backlog` ⚠ | `scrum.task.get` → `backlog.get` → `scrum.task.update` → `scrum.task.get` | `{id, fields{entityId: backlogId}}`; `backlog.get {id: groupId}` |
| `task_create` ⚠ | `sprint_columns` → `user.current` → ajax `bitrix:tasks.kanban` `addTask` | что шлёт «+» доски; endpoint `/bitrix/services/main/ajax.php?mode=class&c=bitrix%3Atasks.kanban&action=addTask`, форма `{taskName, columnId, parentTaskId:0, beforeItemId:0, params{USER_ID, GROUP_ID, GROUP_ID_FORCED:0, SPRINT_ID, IS_COMPLETED_SPRINT:"N", PERSONAL:"N", TIMELINE_MODE:"N"}, personal:"N"}` → `data{id, columnId}` |
| `task_result_add` ⚠ | ajax `tasks.v2.Task.Result.add` | json `{"results":[{taskId,text}]}`; ответ `data[0].id`. Официальный `tasks.task.result.add` — только REST 3.0, через сессию отказ |
| `task_file_attach` ⚠ | `tasks.task.get` → `user.current` → `/rest/disk.storage.getlist.json` → `/rest/disk.folder.uploadfile.json` → `/rest/tasks.task.files.attach.json` → `tasks.task.get` | Диск — ниже |

`ajax` с json-телом — все `tasks.v2.*` и `ui.entityselector.*`; `bitrix:tasks.scrum.doD.*`,
`bitrix:tasks.kanban` и `im.v2.*` — форма.

### Ловушки записи

- **Пустой массив исчезает из формы.** Кодировщик формы разворачивает массив в `key[0]=…`, и у пустого не
  остаётся ни одного ключа: `fields[AUDITORS]=[]` превращается в «Could not find value for parameter
  {fields}». Очистить списочное поле классического `tasks.task.update` — `""` (проверено на `AUDITORS`,
  так же для `ACCOMPLICES`). Теги так **не** очищаются: `fields[TAGS]=""` их оставляет — теги пишет json
  `tasks.v2.Task.update`, где `tags: []` очищает. `null` и `undefined` в форме тоже пропадают, булевы
  уходят строками `"true"` / `"false"`.
- **Список целиком.** `ACCOMPLICES`, `AUDITORS`, теги и `DESCRIPTION` Bitrix заменяет целиком (UI тоже шлёт
  весь список) — операция читает текущее значение, меняет его и записывает; не прочитала — не пишет.
- **Пустой `true`.** `task.stages.movetask` для задачи, которой нет на доске спринта, и
  `kanban.addTask` (в части колонки) отвечают `true`, ничего не изменив, — каждое перемещение перечитывает
  положение и считает «ничего не изменилось» ошибкой. Перечитывать стоит после любой записи: Bitrix
  может ответить успехом и оставить своё (отказать в участнике, сохранить чужой список).
- **Колонки спринта** — `tasks.api.scrum.kanban.getStages {sprintId}`; `task.stages.get {entityId}`
  отдаёт старый канбан группы. Активный спринт — `tasks.api.scrum.sprint.list` по `STATUS:"active"`, не по
  датам. Для задачи не на доске `tasks.task.get` показывает стадию канбана группы.
- **DoD.** Нужен ли он — `doD.isNecessary {groupId, taskId}` (строгий `data: boolean`), и только в группе
  с `TYPE: "scrum"` (`workgroup.get`); неизвестный `TYPE` или ответ `tasks.task.get` без поля проекта —
  отказ, а не закрытие без DoD (без DoD закрывается только задача с проектом `0` / `null`). Типы — `doD.getSettings {groupId, taskId, saveRequest:"N"}` → `types[{id, name, dodRequired}]`.
  Критерии — `doD.getList {groupId, taskId, typeId}` → `data.html`, внутри скрипта страницы JSON-дерево
  `Object.assign(renderTo, {…"items":{"DESCENDANTS":[…]}})` с `FIELDS.{COPIED_ID, PARENT_ID, TITLE,
  SORT_INDEX, IS_IMPORTANT}`. Отметка — `doD.saveList {typeId, taskId, groupId, items[i][NODE_ID|
  PARENT_NODE_ID|COPIED_ID|PARENT_ID|TITLE|SORT_INDEX|IS_COMPLETE|IS_IMPORTANT]}`: всё дерево, родитель
  раньше детей, `NODE_ID` — случайная строка клиента, у детей `PARENT_NODE_ID` = `NODE_ID` родителя. Затем
  `tasks.v2.Task.Status.complete`. Официальный `tasks.task.complete` не используется: он может закрыть
  задачу мимо DoD.
- **Диск через сессию.** Хранилище пользователя — `disk.storage.getlist {filter{ENTITY_TYPE:"user",
  ENTITY_ID: <user.current>}}` → `ROOT_OBJECT_ID`; загрузка — `disk.folder.uploadfile {id: <корень>,
  data{NAME}, fileContent:[имя, base64], generateUniqueName:true}` формой (10 МБ файла ≈ 13 МБ тела; этому
  запросу мост даёт до 4 мин, урезая до остатка бюджета операции); прикрепление —
  `tasks.task.files.attach {taskId, fileId}` → `attachmentId`, его ищут в `UF_TASK_WEBDAV_FILES`
  перечитанной задачи. Ответ загрузки разбирается по полям (`ID`, `NAME`, `SIZE`): его `DOWNLOAD_URL` несёт
  `sessid` и наружу не отдаётся. UI грузит иначе (`ui.fileuploader.upload` + `tasks.v2.File.attach`).
- **Неидемпотентные записи** (сообщение, результат, задача, загрузка, вложение, напоминание): таймаут или
  нераспознанный ответ не значит, что портал ничего не сделал, — ошибка таких операций говорит «могло
  уйти / могло создаться / мог загрузиться», чтобы агент проверил перед повтором.

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
