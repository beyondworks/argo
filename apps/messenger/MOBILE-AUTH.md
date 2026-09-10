# Mobile account authentication

The mobile client uses the existing Argo Supabase project and account. It accesses the same organization/channel tables under their existing RLS. It does not create a parallel identity service.

## Integration contract

`src/mobile-auth.mjs` exports `createMobileAuth({ auth, storage, supabaseUrl, openUrl })`. Keep one controller for the app webview, outside React Auth screen mount/unmount. The mobile Supabase client requires `flowType: 'pkce'`, `persistSession: true`, `detectSessionInUrl: false`, and persistent storage. Preserve the existing desktop loopback handoff and its configuration.

- `start('google' | 'github')` prepares the SDK authorization URL and opens the OS browser. It resolves `{ status: 'waiting' }`, not an authenticated session.
- `pending()` returns only `{ provider, expiresAt }` or `null`; the UI can restore waiting state after a cold start and expire it without repeating a login.
- `consume(url)` returns `{ status: 'signed_in' }` or `{ status: 'ignored', reason }`. The SDK exchanges and saves the session itself. Do not call `setSession` afterward.
- `cancel()` clears the pending intent. It returns `false` while the SDK exchange is in progress: that request commits a session and cannot safely be represented as cancelled. Disable cancellation during that brief phase, or keep waiting when cancellation returns false. Do not implement cancellation by signing out an existing/refreshed session.
- Register Tauri `onOpenUrl` first, then process `getCurrent()` for cold starts. Pass each URL through `consume`. Clean up the listener on app teardown; do not cancel a pending login merely because the Auth screen remounts. Clear pending intent on explicit logout or server-profile change.

The module emits fixed error codes (`start_failed`, `open_failed`, `exchange_failed`, `provider_denied`, `busy`, `cancelled`, `storage_unavailable`). Translate those codes in the UI. Never log callback URLs, SDK exception bodies, pending records, authorization codes, session tokens or the PKCE verifier.

`src/mobile-auth-runtime.js` exports the app singleton: `getMobileAuthSnapshot()`, `subscribeMobileAuth(listener)`, `startMobileSignIn(provider)`, `cancelMobileSignIn()`, and `mountMobileAuth()`. The snapshot contains only `{ waiting, error, exchanging }`. Subscribe with a React effect and return its unsubscribe; mount the native listener once at app scope and return its synchronous cleanup. `startMobileSignIn` returns a boolean promise and stores fixed-code errors. `mountMobileAuth` is a no-op on desktop/browser. Runtime-only error codes additionally include `expired` and `deep_link_unavailable`.

## Required deployment configuration

Register `argo-messenger://auth/callback` as the native callback on iOS and Android. On each configured Supabase Auth service, allow the narrow redirect pattern `argo-messenger://auth/callback**`, because the outgoing redirect includes an unpredictable `argo_state` query parameter. Keep the existing desktop redirect URLs. Google/GitHub provider configuration remains on the same Supabase project.

The app parser accepts only the exact callback path and a matching unexpired pending nonce. Unknown/duplicate query parameters, alternate hosts/paths and implicit token delivery are rejected. Success fragments are rejected. Supabase error fragments are accepted only when they exactly mirror nonempty query error fields and contain one empty `sb=` marker; the matching pending nonce remains mandatory. The allowlist wildcard is not the app's parsing rule.

## Failure and replay behavior

Only one SDK PKCE flow may be pending. A second start is blocked so it cannot overwrite the first verifier. A five-minute deadline and server-origin binding survive a webview restart. The intent is consumed synchronously before exchange, preventing a duplicate event and cold-start callback from exchanging again. If the process dies during exchange, that URL is not replayed; use an already saved SDK session or start a new login. Network/exchange errors require a new login attempt.

The SDK owns verifier storage and normal session refresh; this controller never reads, copies or manually removes SDK session/verifier fields. Cancellation removes only this module's intent, making its callback unusable. The next SDK login replaces the verifier. Persisted SDK state currently uses the existing webview storage model, not a new hardware-backed credential vault. A custom scheme can be intercepted by another installed app; PKCE prevents that app from redeeming the intercepted code without this app's verifier, but does not prevent denial of service. Verified HTTPS app links can be added when a controlled association domain is available.

Email OTP is not silently offered as fallback. Existing repository evidence records code-less email templates and SMTP limits; restoring it requires a separately configured and verified email flow. If redirect configuration is missing, show the actionable login error rather than success.

## Verification and remaining scope

`node --test test/mobile-auth.test.mjs`: 21 tests pass. Tests cover callback boundaries, unsolicited/wrong-nonce callbacks, five-minute expiry, clock rollback, server changes, duplicate events, cancel/SDK commit races, browser/storage failures and corrupt intent recovery. Runtime tests cover listener-before-startup ordering, asynchronous unmount cleanup, duplicate event serialization, expiry state and exchange cancellation, real-format provider cancellation, malformed/mixed/token error fragments, and neutral initialization when no mobile controller is available. One test uses the installed Supabase JavaScript SDK, verifies its actual S256 challenge against its persisted verifier, recreates the SDK client for cold start, and exchanges through an injected HTTP response. It uses isolated in-memory fixtures; no production account, network authentication or user data is used.

iPhone/Android OS browser return, real provider login, release signing and production redirect allowlist are separate release checks. These unit/SDK tests do not establish those checks.

## Primary references

- [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow): SDK verifier persistence, single-use exchange, five-minute code validity and overlapping-flow limitation.
- [Supabase signInWithOAuth](https://supabase.com/docs/reference/javascript/auth-signinwithoauth): the SDK API used here.
- [Supabase native mobile deep linking](https://supabase.com/docs/guides/auth/native-mobile-deep-linking): browser redirects into an app.
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls): allowed redirect configuration.
- [Tauri deep-link JavaScript API](https://v2.tauri.app/reference/javascript/deep-link/): `onOpenUrl` and startup `getCurrent`.

References and installed SDK implementation inspected on 2026-09-10.

OAuth failure callback format was verified against [Supabase Auth external.go lines 821–844](https://github.com/supabase/auth/blob/4eee58f296d9698a1c2c0ae14d7a0b379c7622d3/internal/api/external.go#L821-L844), pinned revision `4eee58f296d9698a1c2c0ae14d7a0b379c7622d3`.
