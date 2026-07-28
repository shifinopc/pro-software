---
name: run-stimes-pro
description: Launch and drive STIMES PRO (the PRO-services ERP in this repo) — starts the API and the Vite dev server, signs in to the operations console and the client portal, and verifies changes. Use when asked to run, start, open, screenshot, or manually check this app.
---

# Running STIMES PRO

Two processes, two front ends, one database. Both servers must be up: the front
ends are static pages that call the API over CORS, so a page that "loads" with
the API down looks fine and shows nothing real.

| | Command | Port |
|---|---|---|
| API (Express + Prisma + MySQL) | `cd server && pnpm dev` | **4100**, fixed |
| Front end (Vite) | `pnpm dev` (repo root) | **dynamic** — see below |

`server` runs under `tsx watch`, so it reloads on save. The root `pnpm dev` is
plain `vite`.

## The Vite port is not fixed

`vite.config.ts` sets no port, so Vite takes the next free one — this machine
runs several projects, and it has come up on **5188** rather than 5173.
`.claude/launch.json` still claims 5173 and is stale. Read the real port:

```bash
netstat -ano | grep LISTENING | grep -E ":(517[0-9]|518[0-9])"
```

or take it from the dev server's own startup line. Don't hardcode it.

## Two apps behind clean-URL rewrites

A Vite middleware rewrites extensionless paths, so use the pretty URLs:

- **Operations console** (staff) → `http://localhost:<port>/dashboard`,
  `/invoices`, `/clients`, `/settings`, `/print-layout` … served from `index.html`
- **Client portal** → `http://localhost:<port>/portal/dashboard`,
  `/portal/invoices` … served from `portal.html`

Anything containing a `.` or starting with `/@` or `/api` passes through.

## Signing in

Staff console — POST and stash the JWT under `stimespro:token`. The local admin
account is whatever `server/prisma/seed.ts` created; don't hardcode credentials
here, read them from the seed or ask:

```js
const r = await fetch('http://localhost:4100/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: '<admin email>', password: '<admin password>' }) });
localStorage.setItem('stimespro:token', (await r.json()).token);
```

**Portal: never change a client's password to get in.** There is a super-admin
impersonation route that mints a portal token with no credentials:

```js
// staff token in hand:
const j = await (await fetch(`http://localhost:4100/api/users/${portalUserId}/login-as`,
  { method: 'POST', headers: { Authorization: 'Bearer ' + staffToken } })).json();
localStorage.setItem('stimespro:portalToken', j.token);   // then visit /portal/dashboard
```

Find `portalUserId` from `GET /api/users` (`type === 'portal'`). Clear the key
when finished. Overwriting a real client's `passwordHash` is unrecoverable —
the old hash is gone.

## Screenshots do not work here

`computer{action:"screenshot"}` times out: the Browser pane isn't displayed, so
the page never composites frames. Verify rendering through the DOM instead —
element geometry proves paint, because a failed render collapses to zero size:

```js
const el = document.querySelector('[data-inv-preview] .band');
const b = el.getBoundingClientRect();          // width/height > 0 = actually laid out
getComputedStyle(el).backgroundImage;          // and actually styled
```

## Console errors are stale across HMR

The console buffer survives for the tab's lifetime, so mid-edit HMR errors
reappear in `read_console_messages` long after the code is fixed and read as
fresh breakage. This has caused false "I broke it" diagnoses more than once.
Install a probe on a clean load and trust only that:

```js
window.__err = []; window.addEventListener('error', e => window.__err.push(String(e.message)));
// … exercise the screen, then read window.__err
```

Cross-check the served file (`await (await fetch('/index.html')).text()`) before
believing a stale symbol reference.

## Driving it

Launching proves the entrypoint resolves; it isn't running the app. Exercise the
path you changed. The invoice lifecycle touches the most machinery:

1. `/invoices` → **+ Create invoice** → pick a client → add a line → **Save**
   → row appears as **Draft** with Edit/Approve
2. **Approve** → row becomes **Unpaid**, actions swap to Record payment/Extend
3. **Open** → drawer renders the real document (gradient band, items table, total)

The scheduler is the other half of the system:

```bash
curl -s -X POST http://localhost:4100/api/cron/tick -H "Authorization: Bearer $TOKEN"
```

Returns a per-job summary (compliance, renewals, sla, parked, billing, dunning,
drafts, orphans). **It acts on real data** — it can start renewals, raise
invoices and send notifications. Every job is idempotent, but a tick run to
"see if it works" has real side effects on whatever is in the database.

## Gotchas that cost time

- **`prisma generate` fails `EPERM`** while the API is running — the process
  holds `query_engine-windows.dll.node`. Stop the server, generate, restart.
  Skipping this leaves a stale client that silently omits new columns.
- **Deleting a temp `.ts` under `server/src/` kills `tsx watch`.** Put throwaway
  scripts elsewhere, or expect to restart the API.
- **`prisma db push`, not migrations** — there is no migrations directory.
- **`pnpm build` is for validation only.** Do not produce deploy archives unless
  explicitly asked.
- **Clean up test data.** This database holds real client records; delete
  fixtures you create and revert rows you mutate.
