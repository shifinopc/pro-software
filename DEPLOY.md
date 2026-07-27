# STIMES PRO — Deployment Runbook

| Subdomain | What | Type |
|---|---|---|
| `pro.ionob.in` | Provider **console** (`dist/index.html`) | static files |
| `cp.ionob.in` | Client **portal** (`dist/portal.html`) | static files |
| `proapi.ionob.in` | **API** (Node + MySQL) | long-lived Node process |

The console and portal are **two pages from one build** (`pnpm build`). Both call `https://proapi.ionob.in` (baked in at build time via `.env.production`).

---

## 0. Prerequisites on the server
- Node 18+ and `pnpm` (frontend build) — or build locally and upload `dist/`.
- MySQL 8 with a database `stimespro` + a user.
- `pm2` (`npm i -g pm2`), Nginx, and `certbot` for SSL.
- DNS: `pro`, `cp`, `proapi` A-records → your server IP.

---

## 1. FIRST-TIME DEPLOY

### 1a. Database
```bash
mysql -u root -p -e "CREATE DATABASE stimespro CHARACTER SET utf8mb4;"
# (create/grant a db user too)
```

### 1b. API — proapi.ionob.in
```bash
cd /var/www/stimespro/server        # your checkout location
cp .env.example .env
npm run gen-secrets                 # prints fresh JWT_SECRET + CRED_KEY → paste into .env
# edit .env: real DATABASE_URL, the two secrets, CORS_ORIGINS, CONSOLE_URL, PORTAL_URL
#           (optional) SMTP_* to actually send reset emails

npm install
npx prisma generate
npx prisma migrate deploy           # applies all migrations (NOT migrate dev)
npx tsx prisma/clean.ts             # seeds the 4 staff logins on an empty DB

pm2 start "npm run start" --name stimespro-api   # tsx src/index.ts, listens on PORT (default 4100)
pm2 save && pm2 startup             # survive reboots
```

### 1c. Frontend build
```bash
cd /var/www/stimespro
pnpm install
pnpm build                          # → dist/index.html, dist/portal.html, dist/assets/
```

### 1d. Nginx (3 server blocks) + SSL

```nginx
# ---- API ----
server {
  server_name proapi.ionob.in;
  location / { proxy_pass http://127.0.0.1:4100; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
}
# ---- Console ----
server {
  server_name pro.ionob.in;
  root /var/www/stimespro/dist;
  index index.html;
  location / { try_files $uri /index.html; }   # SPA fallback
}
# ---- Portal (same dist, but portal.html is the root doc) ----
server {
  server_name cp.ionob.in;
  root /var/www/stimespro/dist;
  location / { try_files $uri /portal.html; }
}
```
```bash
sudo certbot --nginx -d pro.ionob.in -d cp.ionob.in -d proapi.ionob.in
sudo nginx -t && sudo systemctl reload nginx
```

### 1e. Smoke test
1. `https://pro.ionob.in` → log in `<seeded-admin-email>` / `<seeded-admin-password>` → **change the password** (Settings → Security).
2. Add a client **with an email** → assign a package.
3. `https://cp.ionob.in` → log in with that client's email / `<seeded-client-password>` → you'll be forced to set a new password.

---

## 2. UPDATING THE LIVE SERVER (redeploy after changes)

> Pull the latest code first: `cd /var/www/stimespro && git pull` (or upload changed files).

### A) Frontend-only change (UI, screens, styles)
```bash
cd /var/www/stimespro
pnpm install          # only if package.json changed
pnpm build            # regenerates dist/
```
Static files are now live — **hard-refresh** the browser (asset filenames are hashed, so no cache issues). Nothing to restart.

### B) Backend-only change (API logic, no DB schema change)
```bash
cd /var/www/stimespro/server
npm install           # only if package.json changed
pm2 restart stimespro-api
pm2 logs stimespro-api --lines 30    # confirm it booted clean
```

### C) Backend change WITH a schema change (new/changed Prisma model)
```bash
cd /var/www/stimespro/server
npm install
npx prisma migrate deploy    # applies any NEW migration files to the live DB (safe, additive)
npx prisma generate          # regenerate the client for the new schema
pm2 restart stimespro-api
```

### D) Both frontend + backend
Do **B or C** first (API), then **A** (frontend). Order matters if the new UI needs the new API.

### Rollback
- Frontend: `git checkout <prev> && pnpm build`.
- Backend: `git checkout <prev> && pm2 restart stimespro-api`. **Do not** roll back a `migrate deploy` — migrations are forward-only; write a new migration to undo instead.

---

## 3. Notes & gotchas
- **`migrate deploy` is additive and safe** — it only applies migration files that haven't run yet; it never drops data on its own. Always back up the DB before it anyway: `mysqldump stimespro > backup.sql`.
- The frontend has **no runtime config** — the API URL is compiled in. If the API domain ever changes, edit `.env.production` and rebuild.
- `.env` (server) is the only secret store. Keep it out of git. Rotating `JWT_SECRET` logs everyone out; rotating `CRED_KEY` makes existing stored credentials unreadable (re-enter them).
- Email (password-reset links) only sends when `SMTP_*` are set; otherwise the link is written to `pm2 logs`.
- Backups: schedule `mysqldump` daily.

## Production readiness checklist
- [ ] HTTPS on all 3 subdomains (API **must** be https)
- [ ] `server/.env`: NEW `JWT_SECRET` + `CRED_KEY`, real `DATABASE_URL`, `CORS_ORIGINS=https://pro.ionob.in,https://cp.ionob.in`
- [ ] `prisma migrate deploy` run; `clean.ts` seeded
- [ ] Admin password changed after first login
- [ ] API under `pm2` with `pm2 save`/`startup`
- [ ] DB backups scheduled
- [ ] (optional) `SMTP_*` set so password-reset emails actually send
