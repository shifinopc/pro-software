#!/bin/sh
# Bring the schema up to date, then hand over to the API.
#
# Two things this deliberately does NOT do:
#
#   · It never seeds. seed-prod.ts DELETES every row before re-seeding, so a container restart that
#     seeded automatically would wipe the client's data the first time the box rebooted. Seeding is
#     a one-off human decision — see the README.
#   · It never runs `migrate deploy`. Parts of this schema were added with `db push` and have no
#     migration files, so `migrate deploy` would produce an incomplete database.
set -e

echo "[entrypoint] waiting for the database…"
# Prisma is the honest readiness check: it proves the credentials and the schema access work, not
# merely that a TCP port is open.
i=0
until npx prisma db execute --stdin >/dev/null 2>&1 <<'SQL'
SELECT 1;
SQL
do
  i=$((i+1))
  if [ "$i" -ge 30 ]; then
    echo "[entrypoint] database not reachable after 30 attempts — giving up." >&2
    echo "[entrypoint] check DATABASE_URL and that the db service is healthy." >&2
    exit 1
  fi
  sleep 2
done
echo "[entrypoint] database is up."

# Additive by nature: new tables and nullable columns. It will refuse anything destructive rather
# than guess, which is what we want on a database holding real client records.
echo "[entrypoint] syncing schema (prisma db push)…"
npx prisma db push --skip-generate

echo "[entrypoint] starting API on port ${PORT:-4100}"
exec "$@"
