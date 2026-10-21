#!/bin/sh
# Keep /Applications/Novel Companion.app on the latest origin/main: a launchd agent runs
# scripts/poll-install.sh at login and every 10 minutes. Run once per Mac.
#
#   sh scripts/install-auto-update.sh            install (or refresh) the agent
#   sh scripts/install-auto-update.sh --remove   remove it
set -eu
cd "$(dirname "$0")/.."
LABEL=com.maddenman.novelcompanion.autoupdate
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/Novel Companion/auto-install.log"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = --remove ]; then
  rm -f "$PLIST"
  echo "Removed $LABEL."
  exit 0
fi
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$(pwd)/scripts/poll-install.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$(command -v node)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>600</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL: checks origin/main at login and every 10 minutes (log: $LOG)."
