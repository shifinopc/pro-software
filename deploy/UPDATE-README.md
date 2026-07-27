# STIMES PRO — live update (upload & extract these 3 zips)

Built from the current code. Frontend already has `https://proapi.ionob.in` compiled in — do **not** rebuild it.

| Zip | Upload to (cPanel docroot) | Serves |
|---|---|---|
| `stimespro-console.zip` | `pro.ionob.in` document root | console |
| `stimespro-portal.zip`  | `cp.ionob.in` document root | portal |
| `stimespro-api.zip`     | `proapi.ionob.in` app root (the Node app folder) | API |

Each zip has its files **at the root** (no wrapper folder), so "Extract" drops them straight into the docroot.

---

## 0. Back up first (once)
In cPanel → phpMyAdmin (or terminal): export/`mysqldump` the `ionobin_stimespro` DB before touching it.

## 1. Console  (pro.ionob.in)
1. File Manager → the `pro.ionob.in` docroot → **Upload** `stimespro-console.zip`.
2. Right-click → **Extract** (into the same folder) → **overwrite** when asked.
3. Delete the zip. Keep the existing `.htaccess` (the zip ships the correct one).

## 2. Portal  (cp.ionob.in)
Same as above with `stimespro-portal.zip` into the `cp.ionob.in` docroot.

## 3. API  (proapi.ionob.in)  — code + DB schema
1. File Manager → the API app root → **Upload** `stimespro-api.zip` → **Extract** → overwrite.
   - This updates `src/` (incl. the new `workflow.ts`), `prisma/schema.prisma`, `package.json`.
   - Your existing **`.env` is NOT in the zip**, so it is left untouched. ✅
2. cPanel → **Setup Node.js App** → your API app → **"Enter to the virtual environment"** (copy/run that command), then:
   ```bash
   npm install                 # only pulls anything new; safe to run
   npx prisma generate         # regenerate the client for the new tables
   npx prisma db push          # ⬅ adds the new Workflow/Checklist tables & columns (see note)
   npm run build               # tsc → dist/index.js  (Passenger startup file)
   ```
3. Back in **Setup Node.js App**, click **Restart**.
4. Check: open `https://proapi.ionob.in/api/health` → `{"ok":true,"db":"connected"}`.

### ⚠️ Why `prisma db push`, not `migrate deploy`
The BPM **Workflow** engine + **document-checklist** tables (`WorkflowTemplate/Instance/Task/Log`, `ChecklistRule`, and `WorkflowTask.checklistState/requireVerification`) were added to the schema **without migration files**, so `migrate deploy` would NOT create them. `db push` syncs the live DB to `schema.prisma`. All changes here are **additive** (new tables + new nullable columns) — it won't drop or rewrite existing data. (Back up anyway, per step 0.)

---

## What's in this update
- **Console/Portal (UI):** dashboard cards are click-through to their pages; client portal now uses the console-style top header, a flat (ungrouped) sidebar menu, and a fixed collapse toggle with a smooth collapse/expand animation.
- **API:** "My Work" is now personal (only your role's / your name's workflow steps — the Approvals page keeps the full oversight view); PRO officers can now create/update tasks (delete stays admin-only); per-item checklist activity logging (received/verified/rejected) and note/reference capture.
- **DB:** the Workflow + Checklist tables/columns (applied by `prisma db push` above).

## Order
Do the **API first** (steps 0→3), then Console + Portal. Then hard-refresh the browser (assets are hash-named, so no cache issues).

## Rollback
- Frontend: re-extract the previous console/portal zip.
- API: `db push` changes are additive; to revert code, re-upload the previous `src/`, `npm run build`, Restart.
