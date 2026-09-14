# DM delivery browser regression

Renders the real Messenger App with an isolated in-memory Supabase adapter. No environment file is loaded; all browser requests except loopback are blocked. Existing production data and delivery endpoints are not touched.

From `apps/messenger`:

```sh
node node_modules/vite/bin/vite.js --config test/dm-delegation.config.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/dm-delegation.browser.mjs
```

Port 5201, Chromium (installed Chrome) and WebKit, Korean/English, 390/1280px. Evidence is saved to ignored `artifacts/dm-delegation/`.

Covers (1:1 To/CC as composer commands — @name or `/to` pick = To, `/cc` pick = CC chip, no separate panel): recipient retrieval failure surfaces inside the `/cc` list with a retry, and retry also exists when the list is ready; ordinary DM send during recipient failure; unsupported/unknown agents disabled in the list; runtime upgrade and reload; `/cc` keeps the DM partner (context only) while `/to` drops it; readiness revoked after a CC pick blocks sending while the chip stays removable; `/to` inserts `@name ` like the @ popup; delivery payload = role-less inline mention (server reads it as To) + `role: 'cc'` chip, participant membership preserved, sent CC label, chips cleared after send; `@all` remaining within the original DM; CC-only payload; Escape drops the command; channels offer no `/to`·`/cc` and no CC picker; private-channel recipient scope unchanged; no document overflow or JavaScript errors. These are client payload/UI checks, not proof of real database authorization, bot execution, Telegram isolation, or native-device delivery. The companion `dm-delivery.test.mjs` pins merge semantics, stale picked-mention rejection and retry snapshot isolation; `slash-commands.test.mjs` pins the `/to`·`/cc` candidate rules.
