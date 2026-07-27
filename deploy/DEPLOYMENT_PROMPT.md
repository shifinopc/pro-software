# Deployment prompt — cPanel shared hosting (Passenger + AutoSSL)

You are deploying **STIMES PRO** on **cPanel shared hosting** (unprivileged user — NO root, NO nginx/certbot/pm2/systemd). Use the cPanel-native path only: MySQL Databases UI → Setup Node.js App (Passenger) → static sites with `.htaccess` SPA fallback → AutoSSL. Three subdomains, DNS already resolving:

| Subdomain | Role | Uploaded folder | Served doc |
|---|---|---|---|
| `pro.ionob.in` | Console (static SPA) | `<CONSOLE_DIR>` = `deploy/console/` | `index.html` |
| `cp.ionob.in` | Portal (static SPA) | `<PORTAL_DIR>` = `deploy/portal/` | `index.html` |
| `proapi.ionob.in` | API (Node/Express + MySQL) | `<API_DIR>` = `deploy/api/` | Node app via Passenger |

The frontends already have `https://proapi.ionob.in` compiled in — do NOT rebuild them. Each frontend folder also ships a `.htaccess` (SPA fallback) — make sure it's uploaded alongside `index.html`.

> The user handles anything requiring passwords in cPanel forms (DB creation, accepting certs, app logins). You run the terminal/venv steps and report.

---

## Step 1 — MySQL (user does this in the cPanel UI)
In **MySQL Databases**: create DB `ionobin_stimespro`, create a user, add the user to the DB with **ALL PRIVILEGES**. The user will give you the connection string in this form (note the cPanel name prefixes and URL-encode `@`→`%40`, etc. in the password):
```
mysql://ionobin_dbuser:URLENCODED_PASSWORD@localhost:3306/ionobin_stimespro
```
Do NOT create DB accounts or type DB passwords into forms yourself — get the finished string from the user.

## Step 2 — API via "Setup Node.js App" (Passenger)
In cPanel → **Setup Node.js App** → **Create Application**:
- Node version: **20 or 22**
- Application root: `<API_DIR>`
- Application URL: `proapi.ionob.in`
- Application startup file: **`dist/index.js`**  ← (compiled output; see build below)

cPanel prints an "Enter to the virtual environment" command like `source /home/ionobin/nodevenv/.../bin/activate && cd <API_DIR>`. Run it, then inside the venv:
```bash
# write secrets + env (secrets are generated on-box, never leave it)
cp .env.example .env
npm run gen-secrets            # copy JWT_SECRET=... and CRED_KEY=... into .env
# edit .env and set: DATABASE_URL (from Step 1), JWT_SECRET, CRED_KEY,
#   CORS_ORIGINS="https://pro.ionob.in,https://cp.ionob.in",
#   CONSOLE_URL="https://pro.ionob.in", PORTAL_URL="https://cp.ionob.in"
#   (optional) SMTP_* to send password-reset emails
# NOTE: Passenger uses PORT from its own env automatically — do NOT hardcode a port.

npm install                    # installs deps incl. typescript (needed to build)
npx prisma generate            # MUST run BEFORE build — generates the Prisma client types tsc needs
npm run build                  # tsc → dist/index.js  (Passenger startup file)
npx prisma migrate deploy      # apply migrations to the DB (NOT migrate dev)
npx tsx prisma/clean.ts        # seed the 4 staff logins on an empty DB
```
Back in **Setup Node.js App**, click **Restart** (or "Run JS script" isn't needed — Passenger auto-runs `dist/index.js`). If you change `.env` later, hit Restart again.

> If the app doesn't pick up `.env`, set the same vars in the Node.js App UI's "Environment variables" section instead (equivalent).

## Step 3 — Frontends (static)
Point the `pro.ionob.in` and `cp.ionob.in` document roots at `<CONSOLE_DIR>` and `<PORTAL_DIR>` (in cPanel **Domains** / subdomain docroot). Both folders already contain `index.html`, `assets/`, and a `.htaccess` that rewrites unknown paths to `index.html` (so console clean-paths like `/clients` survive refresh). Nothing to build.

## Step 4 — SSL via AutoSSL (confirm with the user before triggering)
cPanel → **SSL/TLS Status** (AutoSSL) → run AutoSSL for `pro.ionob.in`, `cp.ionob.in`, `proapi.ionob.in`. All three MUST end up on valid HTTPS (an https page can't call an http API).

## Step 5 — Verify (you do the health checks; user does the logins)
- `https://proapi.ionob.in/api/health` → `{"ok":true,"db":"connected"}`  ← your check
- `https://pro.ionob.in` and `https://cp.ionob.in` load over HTTPS with no mixed-content errors ← your check
- **Hand to the user:** log into `pro.ionob.in` (`<seeded-admin-email>` / `<seeded-admin-password>`), change the password (Settings → Security), add a client with an email + a service package, then log into `cp.ionob.in` with that client's email / `<seeded-client-password>` (forced password change). Do NOT perform these logins yourself.

## Troubleshooting (shared-hosting specific)
- **App won't start / 500 from Passenger** → check the app's stderr log (Setup Node.js App shows the log path, usually `<API_DIR>/stderr.log`). Most common: `dist/index.js` missing (run `npm run build`), or `.env` not loaded (set env vars in the Node App UI).
- **`/api/health` returns db error** → `DATABASE_URL` wrong; on cPanel it's `ionobin_dbuser` / `ionobin_stimespro` with the password `@`-encoded, host `localhost`.
- **CORS error in browser** → `CORS_ORIGINS` must exactly match the https origins; Restart the app after editing `.env`.
- **404 on refresh at `pro.ionob.in/clients`** → the `.htaccess` didn't upload into the console docroot; re-upload it (it's a hidden file).
- **Node version** → if `npm run build` errors on syntax, the app is on an old Node; pick 20 or 22 in Setup Node.js App.
