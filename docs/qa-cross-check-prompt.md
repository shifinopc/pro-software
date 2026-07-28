# STIMES PRO — cross-app flow audit prompt

Paste everything below the line into Claude in Chrome, with two tabs open in one tab group:

- **Operations console** — http://localhost:5188/dashboard
- **Client portal** — http://localhost:5188/portal/dashboard

Sign in first (credentials are in the prompt). Re-run the QA account setup if the accounts are gone;
delete them when the audit is finished — the snippet is at the bottom of this file.

---

You are auditing **STIMES PRO**, a PRO-services ERP for a Saudi business-services firm. It has two
front ends that share one database and one API:

- **Operations console** — used by the PRO firm's own staff. Tab: `localhost:5188/dashboard`
- **Client portal** — used by their client companies. Tab: `localhost:5188/portal/dashboard`
- API: `http://localhost:4100`. Currency is **SAR**.

Your job is to check, area by area, **whether each flow actually completes end to end and stays
consistent across both apps**, and to produce a findings list I can fix. Both tabs are in your tab
group — use them together: do something in one, then switch to the other and verify what the other
side sees.

## Accounts — use ONLY these

| Where | Email | Password |
|---|---|---|
| Console (staff, super admin) | `qa-staff@example.invalid` | _paste the throwaway password here_ |
| Portal (client) | `qa-portal@example.invalid` | _paste the throwaway password here_ |

Create both accounts fresh before a run and delete them after; never write a working password into
this file — it is tracked in a public repository.

The portal account belongs to the company **"QA Test Co (delete me)"**. Every record you create must
belong to that company.

## Rules — read before touching anything

1. **Never modify data belonging to any other client.** The real ones are `IONOB INNOVATIONS LLP`,
   `stimes`, and `Al Noor Trading Est`. Do not void their invoices, edit their documents, change
   their package, or open destructive dialogs on their rows. If you open one by mistake, cancel it
   and say so in your report.
2. **Never change any password** or use "log in as" on a real user.
3. **Never delete** a service catalog entry, package, workflow template, user, or company. Creating
   is fine; deleting is not — except records you created yourself on QA Test Co.
4. Email sending is disabled in this environment. "No email arrived" is expected and is **not** a
   finding — but note whether the app *claims* an email was sent.
5. If a screen is empty because QA Test Co is new, that is **not** a finding. Create the data you
   need through the UI, then check the flow.

## What counts as a finding

Report anything where the app is **untruthful, incomplete, or inconsistent between the two apps**:

- **Dead control** — a button or link that does nothing when clicked.
- **Fabricated data** — a number, name, date or amount on screen that does not match the database or
  what you entered. Invented client names, wrong currency (AED instead of SAR), placeholder totals.
- **Broken hand-off** — something done in one app that does not appear, or appears wrong, in the
  other.
- **False confirmation** — a success message for something that did not happen ("sent", "uploaded",
  "paid", "emailed") when nothing was actually recorded.
- **Missing automation** — a status change that should trigger a notification, task, reminder or
  invoice and does not.
- **Wrong state exposure** — a client seeing something they should not (a draft or voided invoice
  presented as payable, another company's data), or not seeing something they should.
- **Dead end** — a status a record can enter with no way out, or an action with no undo where one
  is needed.

## Method — for each area

1. Open the area in the console. Note every control on the page.
2. Click each control. Record what happens: does it open something, save something, or nothing?
3. For anything that writes data, switch to the portal tab and check what the client now sees.
4. Then do the reverse: act as the client, and check what the console shows.
5. Walk the **statuses**, not just the happy path. For each record type, take it through every state
   you can reach and check both apps at each step.

To confirm whether something was really saved, you can call the API directly from the page console
with the stored token, e.g.

```js
await (await fetch('http://localhost:4100/api/invoices', {
  headers: { Authorization: 'Bearer ' + localStorage.getItem('stimespro:token') }
})).json()
```

The portal's token is under `stimespro:portalToken`.

## Cross-checks that matter most

Do these first — they are the flows that span both apps.

1. **Service request** — client raises one in the portal → appears in the console Requests Queue →
   staff replies → client sees the reply and an unread badge → staff resolves → client sees resolved.
2. **Quotation** — staff creates and sends one → client sees it (a *draft* must not appear) → client
   accepts → console reflects accepted → convert to invoice → client sees the invoice.
3. **Invoice states** — draft / sent / part-paid / paid / overdue / void. A **draft** must never be
   visible or payable to the client. A **void** must never be payable. Check the outstanding totals
   and counts on both sides agree at every step.
4. **Payment** — staff records a payment against an invoice → portal payment history and balance
   update → print the receipt from both apps and check the figures match the invoice.
5. **Add-on** — client requests a locked service from the portal catalog → console shows it in the
   Clients banner and the Approvals queue → staff approves with a price → client's catalog unlocks,
   a draft invoice is raised, the client's Package tab lists it → then remove it and check the
   client loses access and can request it again.
6. **Document** — client uploads a document → console Documents shows it as pending verification →
   staff verifies → client sees verified. Then set an expiry in the near past and check the renewal
   and overdue signals appear on both sides.
7. **Employee** — client adds an employee in the portal → console Employees shows them → staff edits
   → client sees the change. Then the exit flow: client requests exit → console confirms → status
   on both sides.
8. **Appointment** — book from the portal → console Appointments → staff confirms / reschedules /
   cancels → check the client is told the *right* thing each time (a note-only edit must not
   announce a reschedule).
9. **Suspension** — staff suspends the QA client → portal must block access with a clear reason →
   unsuspend → access returns.
10. **Package change** — staff changes QA Test Co's package → portal plan card, entitlements and the
    service catalog locks all update to match.

## Areas to cover

**Console** — Dashboard, Activity Timeline, My Tasks, Requests Queue, Workflow Builder & Instances,
Appointments, Government Centers, Couriers, Clients (and all detail tabs: Overview, Contacts,
Package, Employees, Credentials, Documents, Notes & Files, Activity), Compliance, Documents,
Employees, Renewals, Invoices, Payments, Quotations, Reports, Group Overview, Service Catalog,
Plan & Billing, Country Rules, Document Types, Departments, Object Builder, Form Builder,
Print Layout, Users & Roles, Audit Log, Settings (every tab), Notifications, Integrations.

**Portal** — Dashboard, My Company, Service Catalog, My Requests, Renewals, Employees, Documents,
Quotations, Invoices, Payments, Plan & Billing, Appointments, Support Center, Notifications,
Profile & Settings.

## Things that will mislead you

- **Hard-reload each tab (Ctrl+Shift+R) before you start.** A cached bundle will show you old
  behaviour and you will report bugs that are already fixed.
- **The browser console log accumulates across reloads.** An error you see may be from a previous
  page load. Only trust an error you can reproduce on a fresh load.
- **Signed-out screens show sample data by design.** If you see invented names, confirm you are
  actually signed in before reporting it.
- Some numbers are legitimately zero or "—" because QA Test Co is new. Check against the database
  before calling something wrong.

## Output

Give me one table, most severe first:

| # | Severity | App | Area | What's wrong | Steps to reproduce | Expected | Actual |
|---|---|---|---|---|---|---|---|

Severity: **High** = wrong money, wrong client data, a client sees something they must not, or a
false confirmation. **Medium** = broken hand-off between the apps, missing automation, dead end.
**Low** = dead link, cosmetic inconsistency, wording.

Then add two short lists:

- **Verified working** — flows you tested end to end that behaved correctly (so I know what was
  actually covered, not just what failed).
- **Not covered** — anything you could not test, and why.

Be specific: name the screen, quote the exact text on screen, and give the record number
(INV-…, REQ-…) so I can find it. Do not report anything you have not reproduced yourself.

---

## Cleanup after the audit

Run from `M:\Projects\Stimes Pro\server`:

```js
// node _cleanup.cjs
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  for (const m of ['payment','invoice','document','employee','serviceRequest','upgradeRequest','quotation','appointment'])
    { try { await p[m].deleteMany({ where: { companyId: 'qa_co' } }); } catch (e) {} }
  await p.user.deleteMany({ where: { id: { in: ['qa_staff','qa_portal'] } } });
  await p.subscription.deleteMany({ where: { id: 'qa_sub' } });
  await p.company.deleteMany({ where: { id: 'qa_co' } });
  console.log('QA accounts and data removed');
})().finally(() => p.$disconnect());
```
