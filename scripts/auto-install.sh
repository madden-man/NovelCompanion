#!/bin/sh
# Rebuild and install the app for a push of main. Started in the background by
# .githooks/pre-push; the log is ~/Library/Logs/Novel Companion/auto-install.log.
#
#   sh scripts/auto-install.sh <sha>
#
# 1. Waits for the push to land (origin/main moves to <sha>); a failed push builds nothing.
# 2. Builds that commit in its own checkout (~/Library/Caches/novel-companion-build/tree),
#    so edits in progress in the working copy never end up in the app.
# 3. Installs it: at once when the app is closed, else when you quit it (scripts/swap-app.sh).
# One build runs at a time. A push made meanwhile is picked up when it finishes, and
# an older build waiting for you to quit gives way to the newer one.
set -eu
SHA="$1"
COMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
REPO="$(dirname "$COMMON")"
STATE="$HOME/Library/Caches/novel-companion-build"
TREE="$STATE/tree"
LOG="$HOME/Library/Logs/Novel Companion/auto-install.log"
mkdir -p "$STATE" "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
notify() { osascript -e "display notification \"$1\" with title \"Novel Companion\"" >/dev/null 2>&1 || true; }
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# 1. The push has landed when the remote-tracking ref points at the commit.
landed=0
for _ in $(seq 1 150); do
  if [ "$(git -C "$REPO" rev-parse -q --verify refs/remotes/origin/main 2>/dev/null)" = "$SHA" ]; then
    landed=1
    break
  fi
  sleep 2
done
if [ "$landed" = 0 ]; then
  say "Push of $SHA did not land on origin/main within 5 minutes: nothing built."
  exit 0
fi
echo "$SHA" >"$STATE/wanted"

# One builder at a time; a running one picks up the newer wanted sha.
if ! mkdir "$STATE/lock" 2>/dev/null; then
  if kill -0 "$(cat "$STATE/lock/pid" 2>/dev/null || echo 0)" 2>/dev/null; then
    say "A build is running; it will build $SHA next."
    exit 0
  fi
  rm -rf "$STATE/lock"
  mkdir "$STATE/lock"
fi
echo $$ >"$STATE/lock/pid"

while :; do
  want="$(cat "$STATE/wanted")"
  [ "$want" = "$(cat "$STATE/installed" 2>/dev/null || true)" ] && break
  say "Building $want"
  # 2. Its own checkout, with node_modules cloned from the main one (APFS: no extra disk).
  if [ ! -d "$TREE/.git" ] && [ ! -f "$TREE/.git" ]; then
    git -C "$REPO" worktree prune
    git -C "$REPO" worktree add --detach "$TREE" "$want"
  fi
  git -C "$TREE" checkout -q --force --detach "$want"
  git -C "$TREE" clean -q -fdx -e node_modules
  lock="$(shasum "$REPO/package-lock.json" | cut -d' ' -f1)"
  if [ "$lock" != "$(cat "$STATE/node_modules.lock" 2>/dev/null || true)" ] || [ ! -d "$TREE/node_modules" ]; then
    rm -rf "$TREE/node_modules"
    cp -Rc "$REPO/node_modules" "$TREE/node_modules"
    echo "$lock" >"$STATE/node_modules.lock"
  fi
  if ! cmp -s "$REPO/package-lock.json" "$TREE/package-lock.json"; then
    say "package-lock.json at $want differs from the main checkout's: run npm install there, then push again."
    notify "Build of ${want%"${want#???????}"} skipped: dependencies changed, run npm install."
    break
  fi
  # 3. Build, sign, install (waiting for you to quit a running copy).
  set +e
  (cd "$TREE" && sh scripts/install-app.sh --wait "$want")
  status=$?
  set -e
  case "$status" in
    0)
      echo "$want" >"$STATE/installed"
      say "Installed $want"
      ;;
    2) say "Gave way to a newer push." ;;
    *)
      say "Build of $want failed (exit $status)."
      notify "The build of ${want%"${want#???????}"} failed. See ~/Library/Logs/Novel Companion/auto-install.log"
      break
      ;;
  esac
done
rm -rf "$STATE/lock"
