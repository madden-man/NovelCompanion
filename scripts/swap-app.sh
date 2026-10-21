#!/bin/sh
# Put a built "Novel Companion.app" into /Applications.
#
#   sh scripts/swap-app.sh <built .app> [--wait <sha>]
#
# Without --wait (npm run install:app) a running copy is closed first, as before.
# With --wait (the push hook) a running copy is never closed: the script asks you to
# quit, waits, then swaps the new build in and reopens it. It gives up waiting, with
# exit 2, when a newer push is wanted (scripts/auto-install.sh writes the wanted sha).
# The swap is two renames, so /Applications never holds a half-copied app.
set -eu
APP="$1"
MODE="${2:-}"
SHA="${3:-}"
DEST="/Applications/Novel Companion.app"
NEW="/Applications/.Novel Companion.new.app"
OLD="/Applications/.Novel Companion.old.app"
STATE="$HOME/Library/Caches/novel-companion-build"
running() { pgrep -f "$DEST/Contents/MacOS/Novel Companion" >/dev/null 2>&1; }
notify() { osascript -e "display notification \"$1\" with title \"Novel Companion\"" >/dev/null 2>&1 || true; }

reopen=0
if running; then
  if [ "$MODE" = "--wait" ]; then
    echo "The app is open: waiting for it to quit."
    notify "A new build is ready. Quit Novel Companion and it reopens with it."
    while running; do
      if [ -n "$SHA" ] && [ "$(cat "$STATE/wanted" 2>/dev/null)" != "$SHA" ]; then
        echo "A newer push is wanted; not installing $SHA."
        exit 2
      fi
      sleep 5
    done
    sleep 1
  else
    pkill -f "$DEST/Contents/MacOS" 2>/dev/null || true
    sleep 1
  fi
  reopen=1
fi

rm -rf "$NEW" "$OLD"
cp -R "$APP" "$NEW"
[ -d "$DEST" ] && mv "$DEST" "$OLD"
mv "$NEW" "$DEST"
rm -rf "$OLD"
codesign -d -r- "$DEST" 2>&1 | grep designated || true
# The renames above can leave Spotlight without an entry for the new copy; index it so
# Spotlight and Launchpad open this one.
mdimport "$DEST" 2>/dev/null || true
if [ "$MODE" != "--wait" ] || [ "$reopen" = 1 ]; then
  open "$DEST"
fi
echo "Installed $DEST"
