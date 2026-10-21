#!/bin/sh
# Run by launchd every 10 minutes (scripts/install-auto-update.sh): when origin/main has
# moved past the installed build, hand the new commit to scripts/auto-install.sh. This
# catches pushes made from anywhere (another clone, a GitHub merge), not only this checkout.
set -eu
cd "$(dirname "$0")/.."
STATE="$HOME/Library/Caches/novel-companion-build"
git fetch -q origin main 2>/dev/null || exit 0
sha="$(git rev-parse refs/remotes/origin/main)"
[ "$sha" = "$(cat "$STATE/installed" 2>/dev/null || true)" ] && exit 0
# A commit whose build failed is not retried; the next push is.
[ "$sha" = "$(cat "$STATE/failed" 2>/dev/null || true)" ] && exit 0
exec sh scripts/auto-install.sh "$sha"
