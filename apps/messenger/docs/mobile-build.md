# Argo Messenger — iPhone / Android

The mobile apps reuse the Messenger React UI, Supabase authentication, organization membership, messages and RLS. They do not start an Argo server or run agent gateways on the phone. Desktop pairing, Hermes/OpenClaw installation and the desktop updater remain desktop-only.

## Build prerequisites

Use the [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/). Install root dependencies (`npm ci` at the repository root), then `npm ci` in `apps/messenger`. Builds require the existing `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` configuration or a user-provided company server profile. Never embed a service-role key or provider secret.

- iOS 16.4 or later: macOS, Xcode, a downloaded iOS simulator runtime, Rust with `aarch64-apple-ios-sim` (simulator) and `aarch64-apple-ios` (device) targets.
- Android 7 or later with an up-to-date Android System WebView (Chromium 107 or newer): JDK 17, Android SDK / NDK, Rust with `aarch64-linux-android` (ARM device/emulator) and the targets needed for other supported architectures. Set `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME` for the shell running Tauri; no global PATH edit is required.

From `apps/messenger`:

```sh
npm run mobile:ios:init
npm run mobile:ios:build -- --debug --target aarch64-sim --no-sign
npm run mobile:android:init
npm run mobile:android:build -- --debug --target aarch64 --apk
```

The iOS simulator archive is under `src-tauri/gen/apple/build/`. It cannot be installed on a physical iPhone. Android debug APKs are under `src-tauri/gen/android/app/build/outputs/apk/` and are for review, not Play Store release. Store distribution requires the product owner's Apple/Google accounts, signing and store review. Do not guess a signing team or reuse an unrelated app's key.

Generated native projects are committed; after changing native identifiers/plugin registration, rerun the relevant init command and review the resulting native manifest/project diff. Local SDK paths, user settings, build outputs and credentials are excluded by the generated project gitignore files.

## Login callback

The [official Tauri deep-link plugin](https://v2.tauri.app/plugin/deep-linking/) registers the mobile custom scheme `argo-messenger`. The only authentication callback accepted by the UI is `argo-messenger://auth/callback`; the receiving client must verify the exact scheme/host/path and exchange a PKCE authorization code using its locally stored verifier. Scheme registration alone is not authentication. Do not accept access/refresh tokens injected through arbitrary URLs.

The suffix wildcard permits the per-attempt nonce query; the client still validates the exact callback path and nonce. Each Supabase project used by the app must allow `argo-messenger://auth/callback**` in Authentication → URL Configuration → Redirect URLs. This includes self-hosted/company servers. Native scheme registration does not change that server setting.

Review URL dispatch without real credentials:

```sh
xcrun simctl openurl booted 'argo-messenger://auth/callback?code=invalid-review-code'
adb shell am start -W -a android.intent.action.VIEW -d 'argo-messenger://auth/callback?code=invalid-review-code' com.beyondworks.argo.messenger
```

A fake callback must never produce a signed-in session. Test both an already running app and a cold start. Real provider login, membership access and sending a message require separate live acceptance evidence; a successful native build does not establish them.

Minimum OS versions describe compatibility prerequisites, not devices tested in this change. Fresh evidence for this revision covers iOS 26.5 simulator and Android 13 emulator only.
