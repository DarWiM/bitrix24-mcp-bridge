# Bitrix24 API notes (reverse-engineered)

Справочник по внутреннему API Bitrix24, добытый **живым реверсом** (у внутренних ajax-контроллеров
нет публичной документации). Предназначен для любого ИИ-агента или разработчика, который вызывает
эти методы через мост (`bitrix_call` / типизированные инструменты) или расширяет каталог.

Наблюдения сняты на портале `example.bitrix24.ru` (облако, мессенджер **im.v2**, задачи в режиме
**scrum-борда**). Имена полей и конвенции стандартны для облачного Bitrix24, но при переносе на другой
портал сверяйся реверсом (`docs/reconnaissance.md`).

---

## 1. Как вызывать

- **Типизированные инструменты** (`bitrix_tasks_list`, `bitrix_task_get`, `bitrix_projects_list`,
  `bitrix_project_get`, `bitrix_chats_recent`, `bitrix_chat_messages`) — с разумными дефолтами.
  Точная выборка — через опциональный аргумент **`params`** (нативный формат Bitrix), он мержится
  **последним** и перекрывает дефолты. Подсказки по параметрам есть в описании каждого инструмента.
- **`bitrix_call { name, params }`** — универсальный вызов любого разрешённого имени из каталога
  (`actions.json`). Тот же `params`-механизм.
- Всё **read-only**: мутирующие вызовы (`…add/update/delete/set/complete/…`) отвергаются при загрузке каталога.

---

## 2. Формат ответа (важно!)

Ajax-контроллеры (`/bitrix/services/main/ajax.php`) отвечают HTTP 200 с конвертом:

```jsonc
{ "status": "success" | "error",
  "data": { ... },
  "errors": [] }          // ПУСТОЙ массив при успехе! (в JS [] — truthy)
```

- Успех определяется `status:"success"` и/или **пустым** `errors`. Непустой `errors` / `status:"error"` /
  top-level `error` — реальная ошибка.
- REST-эндпоинты (`/rest/*.json`) отвечают иначе: `{ "result": …, "next", "total", "time" }` — без `errors`.

---

## 3. Транспорт и конвенции параметров (различаются по методу!)

Мост шлёт `application/x-www-form-urlencoded` со **свежим `sessid`** в теле; вложенность кодируется
PHP-стилем (`filter[STATUS]=2`, `select[0]=ID`). Объект в `params` рекурсивно разворачивается в такие ключи.

| Метод (action / endpoint) | Транспорт | Где `select`/`filter`/`order` | Пагинация |
|---|---|---|---|
| `tasks.task.list` | ajax, форма | **верхний уровень**: `select[]`, `filter{}`, `order{}` | `start` (сдвиг, шаг 50) |
| `tasks.task.get` | ajax, форма | верхний уровень: `taskId`, `select[]` | — |
| `socialnetwork.api.workgroup.list` | ajax, форма | **верхний уровень**: `select[]`, `order{}`, `filter{}` | (nav — не проверено) |
| `socialnetwork.api.workgroup.get` | ajax, форма | **обёрнуто**: `params[groupId]`, `params[select][]` | — |
| `im.v2.Chat.Message.list` | ajax, форма | плоско: `chatId`, `limit`, `filter[lastId]` | `filter[lastId]` + `limit` |
| `im.recent.list` (`/rest/im.recent.list.json`) | rest, форма | плоско: `LIMIT`, `SKIP_OPENLINES`, `UNREAD_ONLY`, … | `LIMIT` |

⚠️ **`tasks.v2.*` (напр. `tasks.v2.Task.get`) шлёт JSON-тело** (`{"task":{"id":N}}`), а мост кодирует
форму — **не используй `tasks.v2.*`**, бери классические `tasks.task.*`. Мессенджер `im.v2.*` при этом
принимает обычную форму (это разные подсистемы, несмотря на общий префикс «v2»).

CSRF: контроллеры требуют `sessid` в теле — расширение подставляет свежий `BX.bitrix_sessid()`
автоматически. Ответ `invalid_csrf`/`invalid_authentication` = сессия протухла (перелогинься в браузере).

---

## 4. Триада: инструмент → action → параметры

| Инструмент | Каталог (`actions.json`) | action / endpoint | Ключевые params |
|---|---|---|---|
| `bitrix_tasks_list` | `tasks.list` | `tasks.task.list` | `filter{RESPONSIBLE_ID,REAL_STATUS,GROUP_ID,…}`, `select[]`, `order{}`, `start` |
| `bitrix_task_get` | `task.get` | `tasks.task.get` | `taskId`, `select[]` |
| `bitrix_projects_list` | `projects.list` | `socialnetwork.api.workgroup.list` | `select[]`, `order{}`, `filter{}` |
| `bitrix_project_get` | `projects.get` | `socialnetwork.api.workgroup.get` | `params[groupId]`, `params[select][]` |
| `bitrix_chats_recent` | `chats.recent` | `/rest/im.recent.list.json` | `LIMIT`, `UNREAD_ONLY`, `SKIP_OPENLINES` |
| `bitrix_chat_messages` | `chat.messages` | `im.v2.Chat.Message.list` | `chatId`, `limit`, `filter[lastId]` |

---

## 5. Справочник полей

**Задача** (`tasks.task.*`): `ID`, `TITLE`, `DESCRIPTION`, `STATUS`, `REAL_STATUS`, `RESPONSIBLE_ID`,
`CREATED_BY`, `CREATED_DATE`, `CHANGED_DATE`, `DEADLINE`, `CLOSED_DATE`, `PRIORITY`, `GROUP_ID`,
`TAGS`, `TIME_ESTIMATE`, `UF_*`. Ответ также подкладывает объекты `group`, `responsible`, `creator`, `action`.

Статусы задачи (`STATUS`): `1` Новая · `2` Ждёт выполнения · `3` Выполняется · `4` Ждёт контроля ·
`5` Завершена · `6` Отложена · `7` Отклонена.

**Группа/проект — список** (`workgroup.list`, camelCase в ответе): `ID`, `NAME`, `DESCRIPTION`,
`NUMBER_OF_MEMBERS`, `OWNER_ID`, `DATE_CREATE`, `PROJECT` (Y/N), `TYPE`.
**Группа — карточка** (`workgroup.get`): плюс `OWNER_DATA`, `SUBJECT_DATA`, `MEMBERS[]`,
`MODERATOR_MEMBERS[]`, `CHAT_ID`, `DIALOG_ID`, `IMAGE_ID`, UF-поля.

**Недавний чат** (`im.recent.list`): `chat_id`, `title`, `type`, `message{id,text,date,author_id}`,
`last_id`, `unread`, `pinned`, `user{…}`, `chat{…}`.
**Сообщение** (`im.v2.Chat.Message.list`): `id`, `chatId`, `authorId`, `date`, `text`, `params`, `viewed`.
Ответ также несёт `users[]` (участники), `additionalMessages[]`, `hasPrevPage`/`hasNextPage`.

---

## 6. Примеры точных выборок

```jsonc
// открытые задачи ответственного 55, по дедлайну, вторая страница
bitrix_tasks_list { "params": { "filter": {"RESPONSIBLE_ID":55,"REAL_STATUS":2},
                                "order": {"DEADLINE":"asc"}, "start": 50 } }

// карточка задачи с расширенным набором полей
bitrix_task_get { "taskId": 4229, "params": { "select": ["ID","TITLE","DESCRIPTION","TAGS","TIME_ESTIMATE"] } }

// проекты, отсортированные по дате создания
bitrix_projects_list { "params": { "order": {"DATE_CREATE":"desc"} } }

// полная карточка группы
bitrix_project_get { "groupId": 15 }

// глубже в историю чата
bitrix_chat_messages { "chatId": 485, "limit": 50, "beforeId": 1936695 }
```

---

## 7. Как расширить (новый домен: календарь, диск, CRM, …)

1. Сними реальные вызовы (`docs/reconnaissance.md` — авто-запись `bun run capture` или HAR).
2. Определи транспорт и форму параметров по разделу 3 (сверься с `sampleParams` из черновика).
3. Добавь запись в `actions.json` (только read-only). Проверь через `bitrix_call { name, params }`.
4. Если удобно — оберни в типизированный инструмент в `src/tools/register.ts` (с дефолтным `select`).

> `actions.json` — данные конкретного портала (gitignored). Этот файл (`api-notes.md`) — переносимые
> знания о самом API; держи его в актуальном состоянии при добавлении новых методов.
