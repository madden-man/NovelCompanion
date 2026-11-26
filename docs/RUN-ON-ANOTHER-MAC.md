# Running Novel Companion on another Mac

1. On this Mac, `npm run install:app` (or `npm run package`) builds `release/build.noindex/Novel Companion-0.1.0-arm64.dmg` (Apple silicon). Copy it over and drag the app to Applications.
2. The build is not notarized, so macOS refuses the first open. Right-click the app and choose Open, or press Open Anyway in System Settings, Privacy and Security. Once per Mac per build.
3. When the keychain asks whether Novel Companion may use its stored items, enter the login password and press Always Allow.

The app does the rest: paste the Atlas connection string on its first screen and the Anthropic key in Settings; each is tested and kept in that Mac's keychain.

## Ending the prompts

The local "Novel Companion Local" certificate (`scripts/make-signing-identity.sh`) keeps the keychain identity stable only on the Mac that holds it. An Apple Developer ID (USD 99 a year) removes the Gatekeeper and keychain prompts everywhere: set `CSC_LINK`, `CSC_KEY_PASSWORD` and the notarization credentials, and give `electron-builder.yml` `identity`, `hardenedRuntime: true`, entitlements and `notarize: true`.
