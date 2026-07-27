# STIMES PRO — Workflow Authoring Spec (paste this into ChatGPT)

Give ChatGPT everything below, then ask it to output **one JSON `graph` object** for the process
you describe. The JSON must follow this schema exactly, because a real BPM engine executes it — any
invented node type or field is silently skipped.

---

## 1. What the app is

STIMES PRO is a PRO‑services / government‑liaison compliance ERP (KSA + UAE). Staff process visas,
work permits, trade licenses, GOSI, Iqama, Emirates ID, etc. against government authorities on behalf
of client companies and their employees. A **workflow** is a repeatable process (a "BPM" graph) that
drives one case from start to finish: collecting documents, getting approvals, submitting to a
government authority, booking appointments, couriering documents, and finally issuing/renewing the
compliance document.

Each workflow runs over a **subject**:
- **employee‑scoped** (`entityType`: visa, iqama, employee, golden, labour, medical, passport, eid) — issues a per‑person document.
- **company‑scoped** (`entityType`: company, trade, commercial, municipal, establishment, gosi, vat, formation, branch) — issues a company‑level document.

---

## 2. The graph JSON — top‑level shape

```json
{
  "nodes": [ { "id": "...", "type": "...", "label": "...", "config": { } } ],
  "edges": [ { "from": "nodeId", "to": "nodeId", "condition": "" } ]
}
```

- `id` — unique string per node (e.g. `"n1"`, `"collect_docs"`).
- `type` — MUST be one of the types in §3. Unknown types are skipped by the engine.
- `label` — human title shown on the canvas and used as the task/step name if `config.title` is absent.
- `config` — type‑specific settings (see §3).
- Edges connect nodes. `condition` is only used to pick a branch out of a `decision` or `approval` node (see §4); leave it `""` for a normal sequential edge.

---

## 3. Node types (the ONLY types the engine runs)

| type | what it does | key `config` fields |
|---|---|---|
| `start` | entry point; auto‑advances. **Exactly one per graph.** | — |
| `task` | a unit of human work; the engine **pauses** here until a person completes it | `title`, `assigneeRole`, `assignee`, `priority` (low/medium/high), `dueDate`, `slaHours` (number), `checklist` (see §5), `requireVerification` (bool), `captures` (see §6) |
| `approval` | human sign‑off; pauses; completer chooses **approve** or **reject** → branches | `title`, `approverRole` (or `assigneeRole`), `slaHours` |
| `decision` | automatic branch on process variables (no human) | `branches`: array of `{ var, op, value, key }` (see §4) |
| `parallel_split` | fan out — activates **all** outgoing edges at once | — |
| `parallel_join` | waits until **every** incoming branch arrives, then continues | — |
| `notify` | sends an in‑app notification, then continues | `channel` (e.g. "Email"), `template` (message text) |
| `issue_document` | writes the result back to Compliance — **issues a new** doc or **renews** an existing one | `docType` (must match a Document Type name), plus optional variable pointers: `expiryVar`, `numberVar`, `issueVar`, `feeVar`, `receiptVar` |
| `draft_invoice` | creates a **draft invoice** in Finance | `amount` (number), `currency` (default "SAR"), `service` (line text) |
| `delay` | records an intended wait, then passes through (no scheduler yet) | `hours` or `days` |
| `webhook` | external call — currently a **stub** (logged, not sent) | `url` |
| `end` | terminates the run. **At least one.** | `result`: "approved" \| "rejected" \| "completed" |

> ⚠️ **Do NOT invent node types.** There is no `government`, `courier`, `meeting`, `department`,
> `assign`, `email`, or `sms` node. Model all of those as **`task`** nodes (see §7).

---

## 4. Branching (decision + approval)

**`decision`** — the engine evaluates `config.branches` top‑to‑bottom against the process variables
and returns the first matching branch's `key` (or `"else"` if none match). You then wire an outgoing
edge for **each** key.

```json
{ "id": "passport_ok", "type": "decision", "label": "Passport valid?",
  "config": { "branches": [
    { "var": "passportValid", "op": "eq", "value": "yes", "key": "yes" }
  ] } }
```
Operators (`op`): `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `contains`, `truthy`.
Then edges:
```json
{ "from": "passport_ok", "to": "next_step", "condition": "yes" },
{ "from": "passport_ok", "to": "reject_case", "condition": "else" }
```

**`approval`** — after a human approves/rejects, the engine follows the edge whose `condition` is
`"approve"` or `"reject"`:
```json
{ "from": "finance_signoff", "to": "submit_gov", "condition": "approve" },
{ "from": "finance_signoff", "to": "notify_rejected", "condition": "reject" }
```

A normal `task` or any auto node uses edges with `condition: ""` (sequential).

---

## 5. Checklists (documents a task must collect)

`task.config.checklist` is an array of items the assignee must tick off before the task can be
completed. If `requireVerification` is true, each required item must be **received AND verified**.
```json
"checklist": [
  { "key": "passport", "label": "Passport copy", "required": true },
  { "key": "photo",    "label": "Photo",          "required": true },
  { "key": "old_visa", "label": "Existing visa",  "required": false }
]
```

---

## 6. Captures (process variables the completer sets) + variable flow

`task.config.captures` lets a completing user set **process variables** that later `decision` and
`issue_document` nodes read. This is how data flows through the run.
```json
"captures": [
  { "var": "passportValid", "label": "Passport valid?", "type": "enum", "options": ["yes","no"] },
  { "var": "newExpiry",     "label": "New expiry date", "type": "date" },
  { "var": "docNumber",     "label": "Document number", "type": "text" }
]
```
Variables the **`issue_document`** node reads (either from captures or from the run's start variables):
- `newExpiry` / `expiryDate` → the issued/renewed document's expiry
- `docNumber` / `documentNumber` → its number
- `issueDate`, `fee`, `receipt` → optional metadata
- `documentId` → **if present, RENEW that existing document** (archives old→new into history); if absent, **ISSUE a new** document
- `employeeId` / `applicant` / `subjectKind` → who the document belongs to (bound automatically when the run is started from a client's Compliance page)

---

## 7. Mapping YOUR requested steps to node types

You asked for government, assignee, department, courier, and meeting steps. Here is exactly how each
maps — **all are `task` nodes**, differentiated by `label`, `assigneeRole`, and `assignee`:

| Real‑world step | Node | How |
|---|---|---|
| **Government submission** (Qiwa / GDRFA / MOHRE / Muqeem / ICP / DED / GOSI / ZATCA) | `task` | `label`: "Submit to Qiwa", `assigneeRole`: the responsible dept, put the authority in the title |
| **Assignee** (a specific person) | any `task`/`approval` | `config.assignee`: "Rashid" |
| **Department / who may complete it** | any `task`/`approval` | `config.assigneeRole`: "pro_officer" \| "admin" \| "accountant" (roles double as departments) |
| **Courier** (send/collect a passport or document) | `task` | `label`: "Courier passport to client", assign to the runner role |
| **Meeting / appointment** (medical, biometrics, client meeting) | `task` | `label`: "Book medical appointment — Smart Salem" |
| **Approval / sign‑off** | `approval` | e.g. finance fee approval, manager sign‑off |
| **Fee / invoice** | `draft_invoice` | raises a draft invoice in Finance |
| **Issue / renew the final document** | `issue_document` | writes the result back to Compliance |

Valid `assigneeRole` values: `pro_officer`, `admin`, `accountant`, `super_admin` (and any custom role you've created). `priority`: `low` \| `medium` \| `high`.

---

## 8. Rules for a VALID, runnable graph (tell ChatGPT to obey all)

1. Exactly **one** `start`; at least one `end`.
2. Every node id is **unique**; every edge `from`/`to` references an existing node id.
3. Every node is **reachable** from `start`, and every path eventually reaches an `end`.
4. Each `decision` needs one outgoing edge per branch `key` it can return, **plus** an `"else"` edge.
5. Each `approval` needs exactly two outgoing edges: `condition:"approve"` and `condition:"reject"`.
6. Every `parallel_split` must be closed later by a matching `parallel_join` (the join waits for all its incoming branches).
7. Sequential edges use `condition: ""`.
8. If the workflow's purpose is to issue/renew a document, include a **`issue_document`** node near the end whose `config.docType` matches a real Document Type name, and make sure an earlier `task` **captures** `newExpiry` and `docNumber`.
9. Keep `label`s short and action‑oriented (they become task titles).
10. Output **only** the JSON graph object — no prose, no markdown fences inside the JSON.

---

## 9. Minimal worked example (employee visa — includes all requested step kinds)

```json
{
  "nodes": [
    { "id": "start", "type": "start", "label": "Start" },
    { "id": "collect", "type": "task", "label": "Collect documents",
      "config": { "title": "Collect employee documents", "assigneeRole": "pro_officer", "assignee": "Rashid", "priority": "high", "slaHours": 48,
        "checklist": [ { "key": "passport", "label": "Passport copy", "required": true }, { "key": "photo", "label": "Photo", "required": true } ],
        "requireVerification": true,
        "captures": [ { "var": "passportValid", "label": "Passport valid?", "type": "enum", "options": ["yes","no"] } ] } },
    { "id": "passport_ok", "type": "decision", "label": "Passport valid?",
      "config": { "branches": [ { "var": "passportValid", "op": "eq", "value": "yes", "key": "yes" } ] } },
    { "id": "fee", "type": "approval", "label": "Finance fee approval",
      "config": { "title": "Approve government fee", "approverRole": "accountant", "slaHours": 24 } },
    { "id": "invoice", "type": "draft_invoice", "label": "Raise fee invoice",
      "config": { "amount": 3200, "currency": "SAR", "service": "Employment visa — government fee" } },
    { "id": "split", "type": "parallel_split", "label": "Process in parallel" },
    { "id": "medical", "type": "task", "label": "Book medical appointment",
      "config": { "title": "Book medical — Smart Salem", "assigneeRole": "pro_officer" } },
    { "id": "gov", "type": "task", "label": "Submit to Qiwa",
      "config": { "title": "Submit work permit to Qiwa (MHRSD)", "assigneeRole": "pro_officer", "priority": "high", "slaHours": 72,
        "captures": [ { "var": "newExpiry", "label": "Visa expiry", "type": "date" }, { "var": "docNumber", "label": "Visa number", "type": "text" } ] } },
    { "id": "join", "type": "parallel_join", "label": "All complete" },
    { "id": "courier", "type": "task", "label": "Courier passport to client",
      "config": { "title": "Courier stamped passport to client", "assigneeRole": "pro_officer" } },
    { "id": "notify_client", "type": "notify", "label": "Notify client",
      "config": { "channel": "Email", "template": "Your employment visa is ready." } },
    { "id": "issue", "type": "issue_document", "label": "Issue Work Visa",
      "config": { "docType": "Employment Visa", "expiryVar": "newExpiry", "numberVar": "docNumber" } },
    { "id": "done", "type": "end", "label": "Done", "config": { "result": "completed" } },
    { "id": "closed", "type": "end", "label": "Rejected / Closed", "config": { "result": "rejected" } }
  ],
  "edges": [
    { "from": "start", "to": "collect", "condition": "" },
    { "from": "collect", "to": "passport_ok", "condition": "" },
    { "from": "passport_ok", "to": "fee", "condition": "yes" },
    { "from": "passport_ok", "to": "closed", "condition": "else" },
    { "from": "fee", "to": "invoice", "condition": "approve" },
    { "from": "fee", "to": "closed", "condition": "reject" },
    { "from": "invoice", "to": "split", "condition": "" },
    { "from": "split", "to": "medical", "condition": "" },
    { "from": "split", "to": "gov", "condition": "" },
    { "from": "medical", "to": "join", "condition": "" },
    { "from": "gov", "to": "join", "condition": "" },
    { "from": "join", "to": "courier", "condition": "" },
    { "from": "courier", "to": "notify_client", "condition": "" },
    { "from": "notify_client", "to": "issue", "condition": "" },
    { "from": "issue", "to": "done", "condition": "" }
  ]
}
```

---

## 10. How to import & test it end‑to‑end (do this yourself in STIMES PRO)

The API is under `http://localhost:4100/api/workflow` (send `Authorization: Bearer <staff token>`).

**A. Import the template** (paste ChatGPT's `graph` as the `graph` value):
```
POST /api/workflow/templates
{ "name": "KSA Employment Visa", "trigger": "manual", "entityType": "visa", "active": true, "graph": { …ChatGPT output… } }
```
It now appears in **Workflow Builder** and in the **New task → kind of work** list.

**B. Start a run.** Two ways, both hit the same real engine:

- **From the UI (easiest):** click **+ New task**, pick your workflow in step 1, choose the **client**
  (and the **applicant** for per‑employee workflows), give it a title, and Create. This now starts a
  full engine instance — its first step immediately appears in **My Tasks**. ⚠️ Pick the client from
  the dropdown so the run is bound to a real company (needed so `issue_document` has an owner).
- **Via API** (for scripting / this test):
  ```
  POST /api/workflow/instances
  { "templateId": "<id from step A>", "title": "Visa — Maria Fernandes", "companyId": "<a real company id>", "clientName": "IONOB INNOVATIONS LLP",
    "variables": { "subjectKind": "employee", "applicant": "Maria Fernandes" } }
  ```

**C. Work the run to the end.** Each `task`/`approval` becomes a live item in **My Tasks / Task List**.
Open each, tick its checklist / fill its captures, and complete it. **Body keys:** `checklistState`
(item ticks) and `variables` (captured values) — NOT `checklist`/`captures`; `outcome` for approvals:
```
POST /api/workflow/tasks/<taskId>/complete
{ "outcome": "approve",
  "checklistState": { "passport": { "received": true, "verified": true } },
  "variables": { "passportValid": "yes", "newExpiry": "2027-07-18", "docNumber": "V-123456" } }
```
(For a plain task omit `outcome`; for an approval use `"approve"`/`"reject"`. A task whose checklist
has required items will 400 unless each required item is `received` — and `verified` too when the
node has `requireVerification: true`.)

**D. Watch it flow.** After each completion the engine advances: decision branches, parallel
split/join, the draft invoice appears in Finance, the notification fires, and the final
`issue_document` writes the new **Employment Visa** into that client's **Compliance** (check the
Compliance screen). The run shows as **completed** in `GET /api/workflow/instances`.

**Verify at each stage:** My Tasks shows the next step with the right assignee/role; Finance shows the
draft invoice; Compliance shows the issued/renewed document; the run's log
(`GET /api/workflow/instances/:id`) lists every node it executed.

---

### Good to know
- **New task → pick a workflow now starts the real engine.** Choosing any workflow (not "Plain task")
  and creating it launches a full instance; the first step lands in **My Tasks** right away, and as
  staff complete steps the engine advances the whole flow. (Only "Plain task" makes a simple to‑do.)
  Bind the **client** (and applicant for per‑employee flows) in the modal so the run has a subject.
- **Government submission, courier, and meeting steps are `task` nodes** — there are no separate node
  types for them. The person working the run performs the real‑world action; the engine tracks the
  step, its SLA, and its department/assignee, and advances when the step is completed.
- `delay` and `webhook` nodes are **stubs** — a `delay` passes straight through (no scheduler yet) and
  a `webhook` is logged but not actually sent. Fine for modeling; just know they don't wait/fire.
