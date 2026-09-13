# Friend search browser regression

Runs actual `main.jsx`, `App.jsx`, i18n/theme providers and CSS against an in-memory wrapper of `dm-lifecycle.supabase.mjs`. All non-loopback browser requests are blocked; identities use `.invalid` addresses. No real friend requests, mail, messages, or production database operations occur.

From `apps/messenger`:

```sh
node node_modules/vite/bin/vite.js --config test/friend-search.config.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/friend-search.browser.mjs
FRIEND_TEST_ENGINE=webkit PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/friend-search.browser.mjs
```

Default port 5213; override with `FRIEND_TEST_PORT` in both processes.

30 scenarios per engine cover existing-member lookup + badge + DM entry, request/accept state transitions, request duplicate prevention while pending, external-person behavior, `@handle`, normalized lookup input, short input validation, relationship removal after a scheduled list refresh without re-search, empty result, lookup failure/retry, and stale search response suppression after input changes. Widths 320/390/1280 cover Korean/English and light/dark; mobile result actions must be at least 44 px. Screenshots and structured results go to ignored `artifacts/friend-search-{chromium,webkit}`.

Boundary: this is rendered browser UI and client integration proof with a fake RPC contract. SQL privacy/relationship semantics require separate PostgreSQL tests. This does not verify installed Tauri binaries, physical iPhone/Android devices, or production notification delivery.
