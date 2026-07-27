# STIMES PRO — fresh deploy + DB wipe & seed

Build produced by `pnpm build` → `node scripts/build-deploy.mjs` → `node scripts/zipdir.mjs`.
The console + portal have `https://proapi.ionob.in` **baked in** (injected as `window.STIMES_API`).
To point at a different API: `API_URL=https://your-api node scripts/build-deploy.mjs` then re-zip.

| Zip | Upload to (cPanel docroot / app root) | Serves |
|---|---|---|
| `stimespro-console.zip` | `pro.ionob.in` docroot | provider console |
| `stimespro-portal.zip`  | `cp.ionob.in` docroot  | client portal (portal.html shipped as index.html) |
| `stimespro-api.zip`     | `proapi.ionob.in` Node app root | API + Prisma + seed |

Each zip has its files **at the root** (real PKZIP, forward-slash paths, `.htaccess` included) → "Extract" drops straight into the docroot.

---

## A. Wipe the DB and run the initial seed  (API app root)

> **Back up first**, even though you're wiping — `mysqldump -u USER -p ionobin_stimespro > backup_before_wipe.sql`

Extract `stimespro-api.zip` into the API app root first (your `.env` is **not** in the zip, so it's left untouched).

### Path A — full wipe (recommended, cleanest)
Needs DROP/CREATE DATABASE permission.
```bash
mysql -u USER -p -e "DROP DATABASE ionobin_stimespro; CREATE DATABASE ionobin_stimespro CHARACTER SET utf8mb4;"

# in the API app root (cPanel → Setup Node.js App → Enter virtual environment):
npm install
npx prisma generate
npx prisma migrate deploy      # builds ALL tables from the baseline migration 0_init
npx tsx prisma/seed-prod.ts    # or: npm run seed:prod
```

### Path B — no DB-drop permission (shared hosting)
```bash
npm install
npx prisma generate
npx prisma db push             # syncs schema (adds any missing tables/columns)
npx tsx prisma/seed-prod.ts    # seed-prod wipes all ROWS then re-seeds config
```

Both paths finish in the same state. Then **Restart** the Node app (cPanel → Setup Node.js App → Restart)
and check `https://proapi.ionob.in/api/health` → `{"ok":true,...}`.

### What the seed creates (a working blank system)
- **1 super-admin login.** Set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` before running the seed:

  ```bash
  SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='a-strong-password' npx tsx prisma/seed-prod.ts
  ```

  With no `SEED_ADMIN_PASSWORD` the seed generates a strong one and prints it **once** — save it from the output. Either way, change it after first login (Settings → Security).
- **4 packages** (Silver / Gold / Platinum / Enterprise).
- **9 document types** (Iqama, Work Visa, Passport, Exit/Re-entry, GOSI, Commercial Register, Municipal License, Work Permit, Family Visa).
- **6 government centers** (Qiwa, Muqeem, Absher, GOSI, ZATCA, MHRSD).
- **8 production workflow templates** (Saudi Employment/Family Visa, New Company Formation, Employee Onboarding, GOSI/Exit-Re-entry/Municipal renewals, Visa Processing) — all active.
- **NO client companies / employees / documents / invoices** — you add those from the app.

The seed is **idempotent** (it wipes + re-creates the seeded rows), so it's safe to re-run.

---

## B. Deploy the front-ends
1. `pro.ionob.in` docroot → upload `stimespro-console.zip` → **Extract** (overwrite) → delete the zip. Keep the shipped `.htaccess`.
2. `cp.ionob.in` docroot → same with `stimespro-portal.zip`.
3. Hard-refresh the browser (assets are hash-named — no cache issues).

Order: do **A (API)** first, then **B (front-ends)**.

---

## Notes
- **Migrations are now fixed.** Previously the Workflow/GovCenter/etc. tables were never captured in a
  migration (they were added by `db push`), so `migrate deploy` failed on a fresh DB. This build ships a
  consolidated baseline migration `prisma/migrations/0_init` that creates the whole schema. Future schema
  changes: `prisma migrate dev --name <change>` locally, commit the new migration, `migrate deploy` on live.
- The old migration files were archived to `server/prisma/migrations.legacy.bak/` (not shipped). Safe to delete.
- The frontend has **no runtime config** — the API URL is injected at build time. If the API domain changes,
  rebuild with `API_URL=… node scripts/build-deploy.mjs` and re-zip.
- Keep `server/.env` out of git. Rotating `JWT_SECRET` logs everyone out; rotating `CRED_KEY` makes stored
  site-credentials unreadable.
