#!/bin/sh
# Build Novel Companion, sign it with the stable local identity, and install it in /Applications.
#
# Why the identity matters: an ad hoc signature is a hash of the binary, so every
# rebuild looks like a new app to the macOS keychain and it asks "allow access?"
# again. A certificate named "Novel Companion Local" in the login keychain gives
# every build the same designated requirement, so the keychain asks once.
# Make one with `sh scripts/make-signing-identity.sh`.
#
#   sh scripts/install-app.sh                 build here, close a running copy, install, open
#   sh scripts/install-app.sh --wait <sha>    used by scripts/auto-install.sh: never closes a
#                                             running copy, waits for you to quit it instead
set -eu
cd "$(dirname "$0")/.."
IDENTITY="Novel Companion Local"
APP="release/mac-arm64/Novel Companion.app"

npm run package
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
  codesign --force --deep -s "$IDENTITY" "$APP"
  echo "Signed with $IDENTITY."
else
  codesign --force --deep -s - "$APP"
  echo "No \"$IDENTITY\" identity in the keychain: signed ad hoc, so the keychain will ask again after this build."
fi
sh scripts/swap-app.sh "$APP" "$@"
