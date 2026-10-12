#!/bin/sh
# Build Novel Companion, sign it with the stable local identity, and install it in /Applications.
#
# Why the identity matters: an ad hoc signature is a hash of the binary, so every
# rebuild looks like a new app to the macOS keychain and it asks "allow access?"
# again. A certificate named "Novel Companion Local" in the login keychain gives
# every build the same designated requirement, so the keychain asks once.
# Make one with `sh scripts/make-signing-identity.sh`.
set -eu
cd "$(dirname "$0")/.."
IDENTITY="Novel Companion Local"
APP="release/mac-arm64/Novel Companion.app"
DEST="/Applications/Novel Companion.app"

npm run package
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
  codesign --force --deep -s "$IDENTITY" "$APP"
  echo "Signed with $IDENTITY."
else
  codesign --force --deep -s - "$APP"
  echo "No \"$IDENTITY\" identity in the keychain: signed ad hoc, so the keychain will ask again after this build."
fi
pkill -f "$DEST/Contents/MacOS" 2>/dev/null || true
sleep 1
rm -rf "$DEST"
cp -R "$APP" "$DEST"
codesign -d -r- "$DEST" 2>&1 | grep designated
open "$DEST"
echo "Installed and opened $DEST"
