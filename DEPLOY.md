# STIMES PRO — deploying

Live runs as a **Docker stack**, not the pm2 + Nginx setup this file used to describe.

**[`stack/README.md`](stack/README.md) is the runbook.** Install, seeding, backups, restoring,
secrets, country packs — all of it is there, next to the compose file it describes, which is the
only way it stays true. This page is the short version plus the two things that have actually gone
wrong, and it deliberately repeats nothing else: the old copy of the procedure drifted out of date
and was followed anyway, which is what took the API down on 29 Oct 2026.

| Subdomain | What | Container |
|---|---|---|
| `pro.ionob.in` | Provider **console** | `stimespro-web-1` |
| `cp.ionob.in` | Client **portal** | `stimespro-web-1` (same build) |
| `proapi.ionob.in` | **API** (Node + Prisma) | `stimespro-api-1` |
| — | **MySQL** | `stimespro-db-1`, private network, never public |

The box is `seo-vps`; the stack lives in `~/stimespro` with the checkout in `~/stimespro/app`.

---

## Deploying a change

Back up first — `stack/backup.sh`, or by hand:

```bash
ssh seo-vps 'docker exec stimespro-db-1 sh -c "mysqldump -u root -p\$MYSQL_ROOT_PASSWORD --single-transaction --routines --triggers stimespro" | gzip > ~/stimespro/backups/stimespro-$(date +%Y%m%d-%H%M%S).sql.gz'
```

Then, **from `~/stimespro`, all three lines**:

```bash
cd ~/stimespro/app && git pull
cd .. && docker compose -f app/stack/docker-compose.yml --env-file .env up -d --build
app/stack/purge-cdn.sh
```

The schema is pushed on start (`prisma db push`, additive); the volumes are untouched; nothing is
ever seeded automatically. There is no separate frontend build step — the image builds it.

### The two ways this goes wrong

**Running compose from inside `app/stack/`.** There is no `.env` in that directory, so every
variable resolves to *empty*: the database comes back with blank credentials and the API gets
`DATABASE_URL=mysql://:@db:3306/`. The API then sits in its connection-retry loop and the site
returns 502. Prisma's complaint — `Unknown authentication plugin 'sha256_password'` — points
nowhere near the cause, so check `docker inspect stimespro-api-1` for an empty `DATABASE_URL`
before you believe anything about MySQL. The data is never at risk (MySQL reads those variables
only when initialising an empty data directory), and re-running the command above with
`--env-file .env` fixes it. This cost ~7 minutes of downtime on 29 Oct 2026.

**Skipping the purge.** The console is one ~4 MB document cached at the Cloudflare edge for an
hour. Without a purge, people keep getting the previous build and reloading does not help them,
because the reload returns the same cached copy. `purge-cdn.sh` reads `CF_ZONE_ID` and
`CF_PURGE_TOKEN` from `~/stimespro/.env`; **both are set since 30 Oct 2026**, so the third line of
the deploy purges on its own. If it ever reports that they are missing, or that Cloudflare refused,
it exits non-zero and says so — purge by hand (Cloudflare → ionob.in → Caching → Purge Everything)
and then fix the token, rather than carrying on believing the deploy is done.

The token is a Cloudflare **user** API token named *ionob.in cache purge*, with one permission —
Zone → Cache Purge → Purge on the ionob.in zone — and nothing else. To replace it, Roll it in the
Cloudflare dashboard and write the new value into `.env`; never paste it at a shell prompt, where it
lands in the shell's history file.

---

## Rolling back

```bash
cd ~/stimespro/app && git checkout <previous-sha>
cd .. && docker compose -f app/stack/docker-compose.yml --env-file .env up -d --build
app/stack/purge-cdn.sh
```

A schema change does not roll back with the code — `db push` has already applied it. Restore the
database from a backup (`stack/README.md` → *Restoring from a backup*) or write a forward change
that undoes it.

---

## Before calling a deploy done

- `curl -s -o /dev/null -w "%{http_code}" https://proapi.ionob.in/api/health` → **200**
- `docker logs stimespro-api-1 --tail 20` → `database is up` → `starting API on port 4100`,
  no restart loop
- `curl -s https://pro.ionob.in | grep -c <something only the new build has>` → non-zero,
  and `cf-cache-status` on that response is `MISS` or the purge ran
- the console loads and renders real data, not `{{ bindings }}`
