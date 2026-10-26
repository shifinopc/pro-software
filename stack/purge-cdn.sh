#!/bin/sh
# Purge the Cloudflare edge cache. The last step of every deploy.
#
# WHY THIS IS A SCRIPT AND NOT A LINE IN THE README.
#
# The console is one 3.7 MB document held at the edge for an hour, so a deploy that does not purge
# leaves people on the previous build for up to an hour — and a reload does not help them, because
# the reload gets the same cached copy. That step WAS a line in the README, under "Updating". It was
# forgotten, the stale build was blamed on the cache, and the cache rule was replaced by a bypass.
#
# Page loads went from 0.8 s to 2.6 s the moment that happened. Measured, both times.
#
# So the rule goes back and this removes the step that failed: it is a command, it either purges or
# says plainly that it did not, and it exits non-zero so a deploy script stops rather than carrying
# on believing it is done.
#
#   ./stack/purge-cdn.sh
#
# Reads CF_ZONE_ID and CF_PURGE_TOKEN from ~/stimespro/.env (or $ENV_FILE). The token needs exactly
# one permission — Zone → Cache Purge → Purge — on the ionob.in zone, and nothing else: it cannot
# read your DNS, change a rule, or touch another zone. Create it at
# https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token.
#
# NOTE ON WHAT IT PURGES. Purge-by-hostname and purge-by-prefix are Enterprise features, and
# purge-by-URL is no use here because every clean URL (/clients, /dashboard, …) is its own cache
# key. So this purges the whole ionob.in zone. The other sites on it are small and simply re-fetch.
set -eu

ENV_FILE="${ENV_FILE:-$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)/.env}"

# Read one key out of the env file without sourcing it — a value with a space or a quote in it
# should not become three shell words.
val() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | head -1 | sed 's/^["'"'"']//; s/["'"'"']$//'
}

ZONE="${CF_ZONE_ID:-$(val CF_ZONE_ID)}"
TOKEN="${CF_PURGE_TOKEN:-$(val CF_PURGE_TOKEN)}"

if [ -z "$ZONE" ] || [ -z "$TOKEN" ]; then
  echo "purge-cdn: CF_ZONE_ID and CF_PURGE_TOKEN are not set (looked in $ENV_FILE)." >&2
  echo "           The deploy is live at the origin but the edge will serve the PREVIOUS build" >&2
  echo "           for up to an hour. Purge by hand now:" >&2
  echo "           Cloudflare -> ionob.in -> Caching -> Configuration -> Purge Everything" >&2
  echo "           Then add the two values to $ENV_FILE so this never needs doing by hand again." >&2
  exit 1
fi

out=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/purge_cache" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}') || {
    echo "purge-cdn: could not reach Cloudflare. The edge is still serving the previous build." >&2
    exit 1
  }

case "$out" in
  *'"success":true'*)
    echo "purge-cdn: edge cache purged — the new build is what people get."
    ;;
  *)
    echo "purge-cdn: Cloudflare refused the purge. The edge is still serving the previous build." >&2
    echo "           $out" >&2
    echo "           Check the token has Zone -> Cache Purge -> Purge on ionob.in." >&2
    exit 1
    ;;
esac
