# DM delivery browser regression

Renders the real Messenger App with an isolated in-memory Supabase adapter. No environment file is loaded; all browser requests except loopback are blocked. Existing production data and delivery endpoints are not touched.

From `apps/messenger`:

```sh
node node_modules/vite/bin/vite.js --config test/dm-delegation.config.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/dm-delegation.browser.mjs
```

Port 5201, Chromium (installed Chrome) and WebKit, Korean/English, 390/1280px. Evidence is saved to ignored `artifacts/dm-delegation/`.

Covers: unsupported/unknown recipient options disabled; runtime upgrade and recipient reload; readiness revoked after selection blocks sending while preserving a removable draft; recipient retrieval failure and retry; ordinary DM send during recipient failure; explicit To/CC delivery without inline names; preserved participant membership; sent recipient labels; @all remaining within the original DM; CC-only payload; private-channel recipient scope unchanged; no document overflow or JavaScript errors. These are client payload/UI checks, not proof of real database authorization, bot execution, Telegram isolation, or native-device delivery. The companion `dm-delivery.test.mjs` pins merge semantics, stale picked-mention rejection and retry snapshot isolation.
