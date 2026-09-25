#!/usr/bin/env bash
#
# STIMES PRO — nightly backup.
#
# Everything that cannot be rebuilt from the repository lives in four places, and this script is the
# only thing that copies them anywhere:
#
#   stimespro_db_data          the database — clients, tasks, invoices, the encrypted credentials
#   stimespro_uploads_private  client document scans (passports, visas, licences)
#   stimespro_uploads          publicly served files (logos)
#   .env                       JWT_SECRET and, critically, CRED_KEY
#
# CRED_KEY is the one that has no second chance. It is the AES-256 key for the credential vault:
# without it the database still restores, but every stored portal password for every client is
# permanently unreadable. A database backup that does not travel with the key is not a backup of
# the credentials — it is a backup of some ciphertext nobody can open.
#
# Install:
#   ~/stimespro/app/stack/backup.sh --install     # writes the crontab entry, then runs once
#   ~/stimespro/app/stack/backup.sh               # run by hand any time; safe to repeat
#
# Restore is in README.md under "Restoring from a backup".

set -euo pipefail

STACK_DIR="${STACK_DIR:-$HOME/stimespro}"
OUT_DIR="${OUT_DIR:-$STACK_DIR/backups}"
PROJECT="${PROJECT:-stimespro}"
LOG="$OUT_DIR/backup.log"

# How long to keep things. The whole set is ~4 MB a night, so these are generous rather than tight —
# but the box was at 87% full when this was written, hence the free-space check below rather than
# trusting the arithmetic.
KEEP_DAILY="${KEEP_DAILY:-14}"      # every night
KEEP_MONTHLY="${KEEP_MONTHLY:-6}"   # the 1st of each month, kept much longer
MIN_FREE_MB="${MIN_FREE_MB:-1024}"

STAMP="$(date +%F-%H%M)"
DAY_OF_MONTH="$(date +%d)"
TAG="daily"; [ "$DAY_OF_MONTH" = "01" ] && TAG="monthly"
SET_DIR="$OUT_DIR/$TAG/$STAMP"

mkdir -p "$OUT_DIR/daily" "$OUT_DIR/monthly"

log() { printf '%s  %s\n' "$(date +'%F %T')" "$*" | tee -a "$LOG" >&2; }
die() { log "FAILED — $*"; exit 1; }

# ── Install mode ──────────────────────────────────────────────────────────────
# Idempotent: re-running replaces the line rather than adding a second one.
if [ "${1:-}" = "--install" ]; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  LINE="17 2 * * * $SELF >> $LOG 2>&1"
  ( crontab -l 2>/dev/null | grep -Fv "$SELF" ; echo "$LINE" ) | crontab -
  log "installed: $LINE"
  exec "$SELF"
fi

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v docker >/dev/null || die "docker not on PATH"
[ -f "$STACK_DIR/.env" ] || die "no .env at $STACK_DIR/.env — wrong STACK_DIR?"

FREE_MB=$(df -Pm "$OUT_DIR" | awk 'NR==2 {print $4}')
[ "$FREE_MB" -ge "$MIN_FREE_MB" ] || die "only ${FREE_MB}MB free, need ${MIN_FREE_MB}MB — prune $OUT_DIR first"

docker compose -p "$PROJECT" ps --status running --format '{{.Service}}' | grep -qx db \
  || die "the db container is not running"

mkdir -p "$SET_DIR"
log "start $TAG set → $SET_DIR (${FREE_MB}MB free)"

# ── 1. Database ───────────────────────────────────────────────────────────────
# --single-transaction so the dump is consistent without locking the app out mid-write. The password
# is read inside the container from its own environment, so it never appears in this process list.
docker compose -p "$PROJECT" exec -T db sh -c \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --quick --routines --triggers --databases stimespro' \
  2>/dev/null | gzip -9 > "$SET_DIR/db.sql.gz" || die "mysqldump failed"

# A dump that fails halfway still exits 0 through a pipe, and a truncated dump that nobody notices is
# worse than no backup at all — so look for mysqldump's own end marker before believing this worked.
zcat "$SET_DIR/db.sql.gz" | tail -5 | grep -q '^-- Dump completed' \
  || die "dump is truncated — no '-- Dump completed' marker"
DB_ROWS=$(zcat "$SET_DIR/db.sql.gz" | grep -c '^INSERT INTO' || true)
log "  db.sql.gz     $(du -h "$SET_DIR/db.sql.gz" | cut -f1)  ($DB_ROWS insert statements)"

# ── 2. Uploaded files ─────────────────────────────────────────────────────────
for vol in uploads uploads_private packs; do
  docker volume inspect "${PROJECT}_${vol}" >/dev/null 2>&1 || { log "  (no ${PROJECT}_${vol} volume — skipped)"; continue; }
  docker run --rm -v "${PROJECT}_${vol}":/data -v "$SET_DIR":/out alpine \
    tar czf "/out/${vol}.tgz" -C /data . || die "could not archive ${vol}"
  N=$(docker run --rm -v "${PROJECT}_${vol}":/data alpine sh -c 'find /data -type f | wc -l')
  log "  ${vol}.tgz  $(du -h "$SET_DIR/${vol}.tgz" | cut -f1)  ($N files)"
done
# Written as root by the container above; make them readable to whoever runs the restore.
sudo -n chown "$(id -u):$(id -g)" "$SET_DIR"/*.tgz 2>/dev/null || chmod u+r "$SET_DIR"/*.tgz 2>/dev/null || true

# ── 3. Secrets ────────────────────────────────────────────────────────────────
# 0600 because this file is the credential vault's key. It is in the backup set deliberately: see the
# note at the top about what a database restore is worth without it.
install -m 600 "$STACK_DIR/.env" "$SET_DIR/env.txt"
log "  env.txt       (CRED_KEY + JWT_SECRET — keep this set off the box)"

# ── 4. Manifest ───────────────────────────────────────────────────────────────
{
  echo "STIMES PRO backup"
  echo "taken     : $(date -Is)"
  echo "host      : $(hostname)"
  echo "commit    : $(git -C "$STACK_DIR/app" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "files     :"
  # Everything except the manifest itself, which is still open on this line and would otherwise be
  # listed with the hash of a half-written file — and fail its own `sha256sum -c` on restore.
  ( cd "$SET_DIR" && find . -maxdepth 1 -type f ! -name MANIFEST.txt -print0 | sort -z | xargs -0 sha256sum )
} > "$SET_DIR/MANIFEST.txt"

# ── 5. Rotation ───────────────────────────────────────────────────────────────
# `find`, not a glob: an empty directory makes `ls dir/*/` exit 2, and under `pipefail` that status
# reaches the assignment and `set -e` kills the whole run — after the backup is safely written, which
# is the most misleading moment possible for the script to report failure.
prune() {
  local dir="$1" keep="$2" sets=() i
  while IFS= read -r d; do sets+=("$d"); done     < <(find "$dir" -mindepth 1 -maxdepth 1 -type d | sort)
  local n=${#sets[@]}
  [ "$n" -gt "$keep" ] || return 0
  for (( i = 0; i < n - keep; i++ )); do
    rm -rf "${sets[i]}"; log "  pruned $(basename "${sets[i]}")"
  done
}
prune "$OUT_DIR/daily"   "$KEEP_DAILY"
prune "$OUT_DIR/monthly" "$KEEP_MONTHLY"

log "done — $(du -sh "$SET_DIR" | cut -f1) in $SET_DIR; $(du -sh "$OUT_DIR" | cut -f1) total"

# ── 6. Off the box ────────────────────────────────────────────────────────────
# NOT CONFIGURED. Everything above is still on the one disk that holds the thing it is backing up,
# so it survives a bad deploy or a dropped table and does NOT survive losing this server.
#
# Set OFFSITE_CMD in ~/stimespro/.env to close that gap — it is run with the set directory as $1:
#   OFFSITE_CMD='rclone copy "$1" remote:stimespro/'
#   OFFSITE_CMD='aws s3 sync "$1" s3://bucket/stimespro/'
#   OFFSITE_CMD='scp -r "$1" user@otherhost:~/stimespro-backups/'
OFFSITE_CMD="$(grep -E '^OFFSITE_CMD=' "$STACK_DIR/.env" 2>/dev/null | cut -d= -f2- | sed -e 's/^"//' -e "s/^'//" -e 's/"$//' -e "s/'$//")" || true
if [ -n "${OFFSITE_CMD:-}" ]; then
  log "offsite: $OFFSITE_CMD"
  bash -c "$OFFSITE_CMD" _ "$SET_DIR" && log "offsite copy ok" || log "WARNING offsite copy FAILED — the set is only on this box"
else
  log "WARNING no OFFSITE_CMD set — this backup lives only on the machine it came from"
fi
