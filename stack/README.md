# STIMES PRO — Docker stack

Runs the whole product as three containers plus its own MySQL, on any Docker host.

| URL | Container | Serves |
|---|---|---|
| `https://pro.ionob.in` | `web` | operations console (staff) |
| `https://cp.ionob.in` | `web` | client portal |
| `https://proapi.ionob.in` | `api` | Express + Prisma API |
| — | `db` | MySQL 8, private network only |

The console and portal share one nginx container, which picks between them by Host header.

---

## Isolation

This stack is self-contained. Its own compose project (`stimespro`), its own database, its own
volumes (`stimespro_db_data`, `stimespro_uploads`), its own private network
(`stimespro_internal`). It reads nothing from, and writes nothing to, any other stack on the box.

The single shared thing is the **`web` network**, and only so the reverse proxy can route to it.
One process can bind `:80`/`:443` and Traefik already does; joining `web` is how a container asks
to be routed. Declaring it `external: true` means this file never creates, alters or deletes that
network — bring this stack down and the proxy is exactly as it was.

### Running without the shared proxy

If you want zero contact with the existing proxy, drop the `web` network and the `traefik.*` labels
from both public services and publish ports instead:

```yaml
    ports:
      - "8080:80"     # web
      - "4100:4100"   # api
```

You then need your own TLS termination in front (a second Traefik or Caddy on different ports, or a
separate IP). Not recommended on a single-IP box — two proxies competing for :443 is the usual
outcome.

---

## Install

DNS for all three hostnames must already point at the box. **Traefik cannot issue certificates
until they resolve here** — that is the usual reason a stack starts cleanly but serves a browser
warning.

```bash
mkdir -p ~/stimespro && cd ~/stimespro
git clone https://github.com/shifinopc/pro-software.git app

cp app/stack/.env.example .env
# fill it in — generate the secrets:
docker run --rm node:22-bookworm-slim node -e "const c=require('crypto');console.log('JWT_SECRET='+c.randomBytes(48).toString('hex'));console.log('CRED_KEY='+c.randomBytes(32).toString('hex'))"

docker compose -f app/stack/docker-compose.yml --env-file .env up -d --build
docker compose -p stimespro logs -f api     # watch it wait for MySQL, then push the schema
```

The API entrypoint waits for the database and runs `prisma db push` on every start — additive and
idempotent, so restarts are safe.

> Tip: put `COMPOSE_FILE=app/stack/docker-compose.yml` and `COMPOSE_ENV_FILE=.env` in `~/stimespro/.env`
> and you can just run `docker compose up -d` from that folder.

## Seed — once, by hand

The entrypoint deliberately does **not** seed. `seed-prod.ts` deletes every row before re-seeding,
so an automatic seed would wipe the client's data the first time a container restarted.

```bash
docker compose -p stimespro exec api \
  env SEED_ADMIN_EMAIL='you@example.com' SEED_ADMIN_PASSWORD='a-strong-password' \
  npx tsx prisma/seed-prod.ts
```

Omit `SEED_ADMIN_PASSWORD` and it generates one and prints it **once** — capture it from the
output, then change it after first sign-in via Settings → Security.

Creates: 1 super-admin, 4 packages, 9 document types, 6 government centres (Qiwa, Muqeem, Absher,
GOSI, ZATCA, MHRSD), 8 active workflow templates, and **no client data**.

It creates **no service catalog**, so packages have nothing attached and client entitlements stay
empty until you add services in Configure → Service Catalog.

## Verify

```bash
curl -s https://proapi.ionob.in/api/health      # {"ok":true,"db":"connected"}
```

Then open `https://pro.ionob.in`, sign in, and confirm Settings → Record Sequence lists five rows
and Admin → Workflow Builder lists eight templates. `https://cp.ionob.in` should render the portal
sign-in — no client accounts exist yet.

## Updating

```bash
cd ~/stimespro/app && git pull
cd .. && docker compose -f app/stack/docker-compose.yml --env-file .env up -d --build
```

The schema is re-pushed on start; the volumes are untouched.

## Things that will cost you time if you skip them

- **`CRED_KEY` is unrecoverable.** AES-256 key for the client credential vault. Lose or change it
  and every stored credential for every client is permanently unreadable. Keep a copy off this box.
- **Two volumes hold everything that matters** — `stimespro_db_data` and `stimespro_uploads`.
  `docker compose down -v` destroys both.
  ```bash
  docker compose -p stimespro exec db mysqldump -u root -p"$DB_ROOT_PASSWORD" stimespro > backup-$(date +%F).sql
  docker run --rm -v stimespro_uploads:/data -v "$PWD":/out alpine tar czf /out/uploads-$(date +%F).tgz -C /data .
  ```
- **The API origin is compiled into the front end.** `API_URL` is a build arg, not a runtime
  variable — repointing means `up -d --build`, not a restart.
- **No SMTP means silent no-ops** across invoice email, renewal notices and portal invitations.
- **Never `prisma migrate deploy`.** Parts of this schema were added with `db push` and have no
  migration files, so it would produce an incomplete database.

## Migrating existing data

Only if you have data worth keeping — otherwise just seed.

```bash
# on the old host
mysqldump -u USER -p OLD_DB > stimespro.sql

# here
docker compose -p stimespro exec -T db mysql -u root -p"$DB_ROOT_PASSWORD" stimespro < stimespro.sql
docker compose -p stimespro restart api      # entrypoint re-pushes the schema over the import
```

Copy the old `uploads-files/` into the `stimespro_uploads` volume too, or every uploaded document
404s.
