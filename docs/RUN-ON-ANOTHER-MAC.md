# Running Novel Companion on another Mac

The bible lives in MongoDB Atlas, so any Mac with the app and the connection string sees the same data.

## Install

1. Build on this Mac with `npm run install:app` (or `npm run package`); the installer is `release/build.noindex/Novel Companion-0.1.0-arm64.dmg`. It is built for Apple silicon.
2. Copy the DMG to the other Mac (AirDrop, a drive, iCloud) and drag the app to Applications.
3. The app is not notarized by Apple, so the first open is refused as "from an unidentified developer". Open it anyway: right-click the app and choose Open, or go to System Settings, Privacy and Security, and press Open Anyway next to the message. Once per Mac per build.
4. On the first screen the app says no MongoDB connection string is stored and shows a box to paste it. Paste the Atlas connection string and press Test, then Save. It goes into that Mac's keychain.
5. When the keychain asks whether Novel Companion may use the stored string, enter the login password and press Always Allow. Once per Mac for the current build.
6. Settings holds the Anthropic API key (for Claude features) and, if wanted, the Google Drive client. Both are per Mac.

## Why the prompts, and how to end them

A build signed with the local "Novel Companion Local" certificate (see `scripts/make-signing-identity.sh`, used by `npm run install:app`) keeps the same identity across rebuilds on the Mac that holds the certificate, so that keychain asks once. Another Mac does not trust that certificate, so it may ask again after each new build.

Apple's Developer ID certificate removes every prompt everywhere: a notarized build opens with a double click on any Mac and its keychain identity is stable. It needs the Apple Developer Program (USD 99 a year) and about an hour of setup: enroll, make a Developer ID Application certificate in Xcode or the developer site, export it, and set `CSC_LINK` and `CSC_KEY_PASSWORD` plus the notarization credentials for electron-builder (`electron-builder.yml` then gets `identity`, `hardenedRuntime: true`, entitlements and `notarize: true`). Say so when you have enrolled and the wiring is a small change.
