// Self-contained usage guide served to ANY MCP client (via the bitrix_help tool and
// the bitrix://api-notes resource), so an agent that can't read the repo still knows
// how to drive these tools. Keep in sync with docs/api-notes.md.
export const HELP = `# Bitrix24 MCP — usage guide

Read-only access to a Bitrix24 user's tasks, projects and chats. All calls run under the user's
live browser session; mutating calls are rejected.

## Tools
- bitrix_tasks_list      — user's tasks. params: { filter, select, order, start }
- bitrix_task_get        — one task by taskId. params: { select }
- bitrix_projects_list   — workgroups/projects with names. params: { select, order, filter }
- bitrix_project_get     — full group card by groupId. params: { select }
- bitrix_chats_recent    — recent chats (each has chat_id, title, last message). params: { LIMIT, UNREAD_ONLY }
- bitrix_chat_messages   — messages by chatId. args: { chatId, limit, beforeId }
- bitrix_call            — raw: { name, params } for any allowed catalog entry
- bitrix_help            — this guide

Every typed tool takes an optional \`params\` object (Bitrix-native shape) that is merged LAST and
overrides the built-in defaults, so you control field selection / filtering / ordering / pagination.

## Response envelope (IMPORTANT)
Ajax responses look like { "status":"success", "data":{...}, "errors":[] }. An EMPTY errors array
means SUCCESS. Real failure = non-empty errors / status:"error". REST endpoints (/rest/*.json) return
{ "result":..., "next", "total" } instead.

## Param conventions differ per method
- tasks.task.list:  top-level select[], filter{}, order{}, start (offset, step 50)
- tasks.task.get:   top-level taskId, select[]
- workgroup.list:   top-level select[], order{}, filter{}
- workgroup.get:    WRAPPED — params[groupId], params[select][]  (bitrix_project_get handles this)
- im.v2 messages:   flat chatId, limit, filter[lastId]
Nested objects in \`params\` are encoded PHP-style (filter[STATUS]=2, select[0]=ID).

## Common fields
Task: ID, TITLE, DESCRIPTION, STATUS, REAL_STATUS, RESPONSIBLE_ID, CREATED_BY, CREATED_DATE, DEADLINE,
      PRIORITY, GROUP_ID, CLOSED_DATE, TAGS, TIME_ESTIMATE, UF_*.
  Task STATUS: 1 New · 2 Pending · 3 In progress · 4 Awaiting control · 5 Completed · 6 Deferred · 7 Declined.
Group: ID, NAME, DESCRIPTION, NUMBER_OF_MEMBERS, OWNER_ID, DATE_CREATE, PROJECT(Y/N).
Chat item: chat_id, title, message{text,date}, last_id, unread. Message: id, chatId, authorId, date, text.

## Examples
bitrix_tasks_list { "params": { "filter": {"RESPONSIBLE_ID":55,"REAL_STATUS":2}, "order": {"DEADLINE":"asc"}, "start": 50 } }
bitrix_task_get { "taskId": 4229, "params": { "select": ["ID","TITLE","DESCRIPTION","TAGS"] } }
bitrix_projects_list { "params": { "order": {"DATE_CREATE":"desc"} } }
bitrix_chat_messages { "chatId": 485, "limit": 50, "beforeId": 1936695 }
`;
