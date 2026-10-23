#!/usr/bin/env bash
#
# Exercise backup.sh's prune() and log() against fixtures.
#
# This function DELETES BACKUPS, which is the one thing in this repository that cannot be undone by
# re-running anything — so it does not get to be the code nobody checks. The function is EXTRACTED
# from backup.sh rather than retyped here, so what is tested is what ships.
#
# The cases that matter are 2 and 3. Two is the bug this was written for: retention counted
# DIRECTORIES, so every manual run evicted a night and a busy afternoon quietly cut a fortnight's
# cover to four days. Three is the failure that pruning by age introduces in its place: if the cron
# stops for a month, every set on disk is "too old" — without a floor the next run deletes the lot.
#
#   bash stack/backup-test.sh
set -uo pipefail

SRC="$(dirname "$0")/backup.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

sed -n '/^prune() {/,/^}/p' "$SRC" > "$WORK/prune.sh"
grep -q "MIN_SETS" "$WORK/prune.sh" || { echo "FAILED to extract prune()"; exit 1; }
sed -n '/^log() {/,/^}/p' "$SRC" > "$WORK/log.sh"
# Checks the EXTRACTION worked, not that the fix is present — a guard that asserts the fix makes
# the case below unreachable the moment anybody breaks it, which is the one time it should run.
grep -q 'LOG' "$WORK/log.sh" || { echo "FAILED to extract log()"; exit 1; }
log() { echo "    $*"; }
# shellcheck disable=SC1090
. "$WORK/prune.sh"

bad=0
ok()   { echo "  OK   $1"; }
no()   { echo "  FAIL $1"; bad=$((bad+1)); }

# Build a directory of sets at given day-offsets from today.
build() {
  local dir="$1"; shift
  rm -rf "$dir"; mkdir -p "$dir"
  local off
  for off in "$@"; do
    if [[ "$off" == nondate:* ]]; then mkdir -p "$dir/${off#nondate:}"; continue; fi
    # "3@1147" = a set covering 3 days ago, taken at 11:47 — so several runs on ONE day are
    # several directories, which is the whole shape of the bug under test.
    if [[ "$off" == *@* ]]; then
      mkdir -p "$dir/$(date -d "${off%@*} days ago" +%F)-${off#*@}"
    else
      mkdir -p "$dir/$(date -d "$off days ago" +%F)-0217"
    fi
  done
}
surviving() { find "$1" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' '; }
has_day()   { [ -d "$1/$(date -d "$2 days ago" +%F)-0217" ]; }

echo "1. an old set goes, a recent one stays"
MIN_SETS=3
build "$WORK/a" 40 30 20 10 5 2 1
prune "$WORK/a" 14 >/dev/null
has_day "$WORK/a" 40 && no "a 40-day-old set survived" || ok "40 days old: pruned"
has_day "$WORK/a" 20 && no "a 20-day-old set survived" || ok "20 days old: pruned"
has_day "$WORK/a" 10 && ok "10 days old: kept" || no "a 10-day-old set was pruned"
has_day "$WORK/a" 1  && ok "yesterday: kept"   || no "yesterday's set was pruned"

echo
echo "2. THE BUG: a pile of manual runs on recent days evicts nothing"
MIN_SETS=3
build "$WORK/b" 13 12 11 10 3 3@1147 3@1233 3@1241 3@1447 2 2@0920 1 0 0@0433 0@0444
before=$(surviving "$WORK/b")
prune "$WORK/b" 14 >/dev/null
after=$(surviving "$WORK/b")
[ "$before" = "$after" ] && [ "$after" = "15" ] && ok "15 distinct sets in 14 days, none pruned" \
  || no "manual runs still evicted history: $before -> $after"
has_day "$WORK/b" 13 && ok "the oldest night survived a day of manual runs" || no "the oldest night was evicted"

echo
echo "3. THE FLOOR: if the cron stopped, the last sets are NOT all deleted"
MIN_SETS=3
build "$WORK/c" 300 290 280 270 260
prune "$WORK/c" 14 >/dev/null
n=$(surviving "$WORK/c")
[ "$n" = "3" ] && ok "every set was older than the cutoff; the newest 3 were kept anyway" \
  || no "floor not honoured: $n sets left, expected 3"
has_day "$WORK/c" 260 && ok "the newest of them survived" || no "the newest set was deleted"

echo
echo "4. fewer sets than the floor: nothing is touched"
MIN_SETS=3
build "$WORK/d" 400 399
prune "$WORK/d" 14 >/dev/null
[ "$(surviving "$WORK/d")" = "2" ] && ok "2 sets, both ancient, both kept" || no "pruned below the floor"

echo
echo "5. a directory that is not a dated set is left alone"
MIN_SETS=1
build "$WORK/e" 400 399 398 nondate:scratch-restore nondate:tmp
prune "$WORK/e" 14 >/dev/null
[ -d "$WORK/e/scratch-restore" ] && ok "scratch-restore: kept" || no "a non-set directory was deleted"
[ -d "$WORK/e/tmp" ] && ok "tmp: kept" || no "a non-set directory was deleted"

echo
echo "6. a missing directory is not an error"
prune "$WORK/does-not-exist" 14 >/dev/null && ok "returned cleanly" || no "errored on a missing directory"

echo
echo "7. monthly retention keeps roughly six months"
MIN_SETS=2
build "$WORK/f" 400 250 180 120 60 1
prune "$WORK/f" 190 >/dev/null
has_day "$WORK/f" 400 && no "a 13-month-old monthly set survived" || ok "400 days old: pruned"
has_day "$WORK/f" 250 && no "an 8-month-old monthly set survived" || ok "250 days old: pruned"
has_day "$WORK/f" 180 && ok "6 months old: kept" || no "a 180-day-old monthly set was pruned"

echo
echo "8. the log is written once under cron, and still shown to a person"
# THE BUG: log() teed to the file AND stderr, while the cron entry redirects stderr into that same
# file — so every scheduled line was stored twice.
cat > "$WORK/logcase.sh" <<EOS
set -euo pipefail
LOG="$WORK/out.log"
$(cat "$WORK/log.sh")
log "hello from a run"
EOS
# Cron: stderr is a FILE, not a terminal.
: > "$WORK/out.log"
bash "$WORK/logcase.sh" >> "$WORK/out.log" 2>&1
n=$(grep -c "hello from a run" "$WORK/out.log")
[ "$n" = "1" ] && ok "cron-style run: recorded once" || no "cron-style run: recorded $n times (expected 1)"

# A person at a terminal must still see it. Needs a pty, so this one is skipped where there is no
# python to make one rather than quietly passing.
PY=$(command -v python3 || command -v python || true)
# `pty` is a Unix-only module, so this case is genuinely unavailable on Windows rather than failing
# there. Checked explicitly: a harness that cannot run must say so, not report the code as broken.
if [ -n "$PY" ] && "$PY" -c "import pty" >/dev/null 2>&1; then
  : > "$WORK/out.log"
  seen=$("$PY" -c "
import pty, sys, os
out = []
def rd(fd):
    d = os.read(fd, 1024); out.append(d); return d
pty.spawn(['bash', r'''$WORK/logcase.sh'''], rd)
sys.stdout.write(b''.join(out).decode('utf-8', 'replace'))
" 2>/dev/null | grep -c "hello from a run" || true)
  n=$(grep -c "hello from a run" "$WORK/out.log")
  [ "$seen" -ge 1 ] && ok "at a terminal: shown to the person" || no "at a terminal: nothing was printed"
  [ "$n" = "1" ] && ok "at a terminal: still recorded once in the file" || no "at a terminal: recorded $n times"
else
  echo "  --   no pty available here (Windows): the terminal case was not exercised"
fi

echo
[ "$bad" = 0 ] && echo "all good" || echo "$bad problem(s)"
exit "$bad"
