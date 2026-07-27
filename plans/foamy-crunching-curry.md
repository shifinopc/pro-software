# STIMES PRO ERP — Complete Improvement & Roadmap Plan

> **Purpose:** Full status audit + prioritised backlog of fixes, improvements, and new features for the STIMES PRO ERP system. Use this as the single source of truth for what's done, what's broken, and what to build next.

---

## 1. Current App Inventory (What's Built)

### Screens (27 total)
| Screen | Status | Notes |
|--------|--------|-------|
| Dashboard | ✅ Full | Hero KPIs hardcoded; lower tiles use real data |
| Tasks | ✅ Full | Create Task modal added; state resets on navigate |
| Compliance | ✅ Full | Add Record button is a placeholder |
| Projects / Kanban | ✅ Full | New Project / New Card are placeholders |
| Clients | ✅ Full | Edit Client, Add Employee are placeholders |
| Finance / Invoices | ✅ Full | New Invoice modal added; state resets on navigate |
| Reports | ✅ Full | Run / Export buttons are placeholders |
| Activity Timeline | ✅ Full | Filter button is a placeholder |
| Calendar | ⚠️ Partial | Locked to Jan 2025; no real month navigation |
| Approvals | ✅ Full | Approve/Reject work; client filter added |
| SLA Monitor | ✅ Full | Client filter added |
| Audit Trail | ✅ Full | Export is a placeholder |
| Integrations & API | ⚠️ Partial | Reconnect, Webhooks, API Docs are placeholders |
| AI Assistant | ⚠️ Partial | 100% mock responses; no real API |
| Knowledge Base | ✅ Full | Download / Share are placeholders |
| Country Rule Engine | ✅ Full | Add Country, Add Doc Type are placeholders |
| Document Templates | ✅ Full | New Template, Edit, Preview are placeholders |
| Multi-Tenant Admin | ✅ Full | Add Tenant, Branding Editor are placeholders |
| BI Dashboard | ⚠️ Partial | Charts use separate static data; not connected to live data |
| KPI Builder | ✅ Full | Works; state resets on navigate |
| Security Center | ✅ Full | Policy toggle is a placeholder |
| Object Builder | ✅ Full | Preview is a placeholder |
| Form Builder | ✅ Full | Settings, Publish are placeholders |
| Workflow Builder | ✅ Full | New Workflow, All Runs are placeholders |
| Service Packages | ✅ Full | Add Tier, Preview Page are placeholders |
| Marketplace | ✅ Full | Install/uninstall state works; no side effects on other screens |
| Notification Engine | ✅ Full | Connect/Test providers are placeholders |
| Settings | ✅ Full | Invite User, Remove User are placeholders; role assignment works |

### Data Scale
| Dataset | Records | Notes |
|---------|---------|-------|
| CLIENTS | 5 | Small; needs expansion |
| INIT_TASKS | 8 | Small |
| COMPLIANCE_DOCS | 8 | Small |
| INVOICES | 5 | Small |
| ACTIVITIES | 10 | Adequate |
| NOTIFICATIONS | 5 | Static only |
| APPROVAL_DATA | 6 | Adequate |
| SLA_DATA | 7 | Adequate |
| AUDIT_DATA | 8 | Adequate |
| CAL_EVENTS | 10 | Locked to Jan 2025 |

---

## 2. Known Bugs & Broken Flows

### P0 — Broken (incorrect behaviour)
| # | Issue | Location | Fix |
|---|-------|----------|-----|
| B1 | Global search click does not navigate | Header search results `onMouseDown` | Add `onNavigate(screen)` call when result clicked |
| B2 | Calendar locked to January 2025; prev/next buttons do nothing meaningful | `CalendarScreen` month state | Build real month navigation using `Date` arithmetic; generate events from compliance/task due dates |
| B3 | Dashboard hero KPIs are hardcoded numbers | `DashboardScreen` top tiles | Derive from `INIT_TASKS`, `COMPLIANCE_DOCS`, `INVOICES` arrays |
| B4 | BI Dashboard uses separate static data, disconnected from operational data | `BI_REVENUE_DATA`, `BI_COMPLIANCE_DATA` | Connect to `INVOICES` and `COMPLIANCE_DOCS` |
| B5 | All screen state resets when navigating away and back | Every screen using `useState(INIT_TASKS)` etc. | Lift shared state (tasks, compliance, invoices) to App root and pass as props |
| B6 | No role enforcement on screen rendering | `SCREEN_MAP` in App root | Guard `SCREEN_MAP` against role; redirect to dashboard if unauthorized |

### P1 — Placeholder Actions (most common user flows)
| # | Screen | Action | Fix |
|---|--------|--------|-----|
| P1-1 | Compliance | Add Record button | Build modal: person, client, doc type, expiry date |
| P1-2 | Clients | Edit Client | Build edit form pre-filled with client data |
| P1-3 | Clients | Add Employee | Build employee form modal |
| P1-4 | Projects | New Project | Build new project/card modal for Kanban |
| P1-5 | Settings | Invite User | Build invite modal; add to users state |
| P1-6 | Settings | Remove User | Add confirmation + state removal |
| P1-7 | Security Center | Policy toggle | Wire toggles to actual state object |
| P1-8 | Notifications | Individual dismiss | Add ✕ button per notification + individual mark-read |
| P1-9 | Activity | Filter | Add type filter dropdown |

### P2 — Fake Exports (low friction to fix)
All export/download buttons show `toast.success` with no file. Fix with browser `Blob` + `URL.createObjectURL` + `<a download>` pattern to generate real CSV from the current filtered array.

Screens affected: Tasks, Compliance, Finance, Reports, Audit Trail, BI Dashboard.

---

## 3. Improvements to Existing Flows

### 3.1 State Persistence (Critical UX Gap)
**Problem:** Every screen re-initialises from static arrays on mount. Creating a task, then navigating away and back, loses the new task.

**Solution:** Lift shared mutable data to App root state:
```
App root state:
  tasks: Task[]           ← initialised from INIT_TASKS
  complianceDocs: ComplianceDoc[]
  invoices: Invoice[]
  notifications: Notification[]
  clients: Client[]
  activities: ActivityItem[]
```
Pass down as props + setter callbacks. Dashboard, Tasks, Compliance, Finance, Activity all read from the same source. Changes in one screen are immediately visible in another (e.g. marking a task done reflects on the dashboard).

### 3.2 Dashboard — Live KPIs
Connect the 4 hero tiles to real state:
- **Open Tasks** → `tasks.filter(t => t.status !== "done").length`
- **Due Today** → tasks filtered by today's date
- **Expiring Soon** → `complianceDocs.filter(d => d.status === "expiring").length`
- **Overdue Docs** → `complianceDocs.filter(d => d.status === "overdue").length`

### 3.3 Calendar — Real Event Generation
Instead of hardcoded `CAL_EVENTS`, derive events from shared state:
- Compliance doc expiry dates → "Renewal" type events
- Task due dates → "Deadline" type events
- Invoice due dates → "Payment due" type events

Enable full month navigation (any month/year) using `Date` arithmetic.

### 3.4 Global Search — Navigation on Click
When a search result is clicked:
- Client result → navigate to `clients` screen + set `clientId` filter
- Task result → navigate to `tasks` screen
- Compliance result → navigate to `compliance` screen

### 3.5 Notifications — Per-Item Actions
- Add ✕ dismiss button on each notification card
- Add click-to-mark-read on each item
- Auto-generate notifications from state changes: when a task is created, a compliance doc expires, or an invoice goes overdue → push a new notification

### 3.6 BI Dashboard — Live Data Connection
Connect BI charts to shared operational state:
- Revenue chart ← derived from `invoices` grouped by month
- Compliance donut ← from `complianceDocs` status counts
- Officer performance ← from `tasks` grouped by assignee

### 3.7 Expand Mock Data
Increase dataset to feel realistic in demos:
- CLIENTS: 5 → 15 clients
- INIT_TASKS: 8 → 25 tasks
- COMPLIANCE_DOCS: 8 → 20 docs
- INVOICES: 5 → 15 invoices
- ACTIVITIES: 10 → 20 items

---

## 4. New Features to Add

### 4.1 Complete Automated Compliance Renewal Flow
**The core PRO workflow — end-to-end:**

```
Step 1: System detects doc expiring within 30 days
         → Auto-creates a Task (status: todo, priority: high)
         → Pushes a Notification
         → Adds a Calendar event

Step 2: Officer opens Task → marks In Progress
         → Compliance doc status updates to "in_progress"
         → Activity log entry created

Step 3: Officer uploads renewal confirmation → marks Task Done
         → Compliance doc status → "valid", expiry date extended +1 year
         → Invoice auto-drafted for renewal fee
         → Client activity log updated
         → Notification sent: "Renewal complete for [person]"
```

**Implementation:**
- `useEffect` in App root watching `complianceDocs` — when `daysLeft < 30 && status === "expiring"`, auto-create task if none exists for that doc
- "Complete Renewal" button on Task detail → triggers the chain above
- All state changes propagate through shared root state

### 4.2 Complete Invoice → Payment Flow
```
New Invoice created (manual or auto from renewal)
  → Status: draft
  → Officer reviews → sends to client (status: pending)
  → Payment received → mark paid
  → Activity log updated
  → Revenue counters update on Dashboard + BI
```

### 4.3 Client Onboarding Flow (New Client Wizard)
Multi-step modal:
1. Company details (name, CR, industry, city)
2. Primary contact (name, email, phone)
3. Select service package (from ServicePackages screen)
4. Initial compliance docs to track (bulk add)
5. Confirm → client appears in Clients screen + Dashboard count updates

### 4.4 Document Expiry Alert Engine
Automated rules (in-app, no backend needed):
- 90 days before expiry → notification "Expiring in 3 months"
- 30 days → high-priority task auto-created
- 7 days → critical notification + SLA breach risk flag
- 0 days (expired) → compliance doc status → overdue, SLA breached

### 4.5 Bulk Actions
Add bulk selection checkboxes to:
- Tasks table: bulk assign, bulk status change, bulk delete
- Compliance table: bulk start renewal, bulk export
- Finance table: bulk mark paid, bulk send reminders

### 4.6 Real CSV Export
For Tasks, Compliance, Finance, Audit Trail:
```tsx
const exportCSV = (data: object[], filename: string) => {
  const csv = [Object.keys(data[0]).join(","),
    ...data.map(row => Object.values(row).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
};
```

### 4.7 Kanban → Task Sync (Projects ↔ Tasks)
Currently Kanban cards and Tasks are separate arrays. Link them:
- Creating a Task creates a Kanban card in "backlog"
- Moving Kanban card updates Task status
- Completing a card marks Task as "done"

### 4.8 Role-Based Screen Guard
```tsx
const ROLE_SCREENS: Record<Role, Screen[]> = {
  super_admin: [...all screens],
  admin: [...all except multi_tenant],
  pro_officer: ["dashboard","tasks","compliance","projects","clients","activity","calendar","ai_assistant","knowledge_base"],
  accountant: ["dashboard","clients","finance","reports","bi_dashboard","kpi_builder","settings"],
  client_admin: ["dashboard","compliance","calendar"],
};

// In App root SCREEN_MAP:
const allowed = ROLE_SCREENS[role];
if (!allowed.includes(screen)) setScreen("dashboard");
```

### 4.9 Activity Auto-Logging
Every state change should push to the `activities` array:
- Task created / status changed
- Compliance doc renewed
- Invoice created / paid
- Client added
- Approval approved / rejected

This makes Activity Timeline a live audit-style feed instead of static data.

### 4.10 Print / PDF Export (browser native)
Add a "Print" button on key screens using `window.print()` with a `@media print` CSS class that hides sidebar/header and formats the table full-width.

---

## 5. Complete Automated Flow Summary

```
CLIENT EXISTS IN SYSTEM
│
├─ Compliance Doc approaching expiry (daysLeft ≤ 30)
│   ├── [AUTO] Notification created: "Expiring soon: Iqama — Ahmed"
│   ├── [AUTO] High-priority Task created: "Renew Iqama — Ahmed | Global Tech"
│   ├── [AUTO] Calendar event added on expiry date
│   └── [AUTO] SLA clock starts
│
├─ PRO Officer picks up Task
│   ├── Task status → In Progress
│   ├── [AUTO] Activity log: "Khalid started renewal for Ahmed Al-Rashid"
│   └── SLA progress bar starts moving
│
├─ Officer completes renewal
│   ├── Task status → Done
│   ├── [AUTO] Compliance doc status → Valid, expiry += 1 year
│   ├── [AUTO] Invoice drafted: "Iqama Renewal — Ahmed Al-Rashid — SAR 1,500"
│   ├── [AUTO] Activity log: "Renewal completed for Ahmed Al-Rashid"
│   ├── [AUTO] Notification: "Renewal complete — ready for invoicing"
│   └── SLA → On Track / Completed
│
├─ Accountant reviews & sends invoice
│   ├── Invoice status: draft → pending
│   ├── [AUTO] Activity log: "Invoice INV-2025-012 sent to Global Tech LLC"
│   └── Reminder auto-scheduled for due date
│
└─ Payment received
    ├── Invoice status → Paid
    ├── [AUTO] Revenue counters update (Dashboard + BI)
    ├── [AUTO] Activity log: "Payment received — INV-2025-012"
    └── [AUTO] Notification dismissed / archived
```

---

## 6. Implementation Priority Order

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| 🔴 P0 | Lift shared state to App root (tasks, docs, invoices) | High | Fixes state-reset bug across all screens |
| 🔴 P0 | Live dashboard KPIs | Low | Immediate visual correctness |
| 🔴 P0 | Global search navigation | Low | Critical UX fix |
| 🟠 P1 | Automated compliance renewal flow (4.1) | High | Core product value |
| 🟠 P1 | Add Compliance Record modal | Medium | Common daily action |
| 🟠 P1 | Edit Client modal | Medium | Common daily action |
| 🟠 P1 | Auto activity logging (4.9) | Medium | Makes Timeline live |
| 🟠 P1 | Per-notification dismiss + auto-generate | Medium | Polished UX |
| 🟡 P2 | Calendar — real month nav + derived events | Medium | Polished UX |
| 🟡 P2 | Real CSV export (all tables) | Low | Demo-ready feature |
| 🟡 P2 | Role-based screen guard | Low | Security correctness |
| 🟡 P2 | BI Dashboard → live data | Medium | Data consistency |
| 🟢 P3 | Client Onboarding Wizard | High | New feature |
| 🟢 P3 | Bulk actions (tasks, compliance, finance) | Medium | Power-user feature |
| 🟢 P3 | Kanban ↔ Task sync | Medium | Workflow consistency |
| 🟢 P3 | Expand mock data (15 clients, 25 tasks) | Low | Demo realism |
| 🟢 P3 | Print / PDF export | Low | Nice to have |

---

## 7. Files to Modify

All changes are in a single file: **`src/app/App.tsx`**

Key structural changes:
- **App root `useState`**: Add `tasks`, `complianceDocs`, `invoices`, `clients`, `activities`, `notifications` as shared state
- **Screen props**: Update all screens to accept `tasks`/`setTasks`, `complianceDocs`/`setComplianceDocs`, etc. instead of reading from module-level arrays
- **`useEffect` in App root**: Watch compliance docs for auto-task/notification generation
- **`exportCSV` utility function**: Add once, reuse across screens
- **`ROLE_SCREENS` guard**: Add to SCREEN_MAP rendering

---

## 8. Verification Checklist

After implementation, verify end-to-end:

- [ ] Create a task → navigate to Dashboard → open task count updates
- [ ] Mark task done → navigate back → task stays done
- [ ] Compliance doc with daysLeft = 25 → Task auto-appears in Tasks screen
- [ ] Complete renewal → compliance doc expiry extends → invoice drafted automatically
- [ ] Mark invoice paid → Dashboard revenue tile updates → BI revenue chart updates
- [ ] Add new client → client appears in dropdown, Calendar events filtered, etc.
- [ ] Search "Global Tech" → click result → navigates to Clients screen filtered to that client
- [ ] Login as `pro_officer` → try to access Finance → redirected to Dashboard
- [ ] Click Export CSV on Tasks → real .csv file downloads with correct data
- [ ] Calendar shows Feb/Mar events when navigating months
- [ ] New notification appears when compliance doc auto-task is created
- [ ] Dismiss a notification individually → it disappears
