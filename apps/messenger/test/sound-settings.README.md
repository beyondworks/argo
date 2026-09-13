# Notification sound UI regression

The actual production `index.html` and App render against the existing isolated in-memory Supabase adapter. No real session, account or push permission is changed.

From `apps/messenger`:

```sh
DM_TEST_PORT=5183 node node_modules/vite/bin/vite.js --config test/dm-lifecycle.config.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/sound-settings.browser.mjs
```

Override the browser target with `SOUND_TEST_PORT`. Chromium and WebKit × 320/390/1280px × light/dark × Korean/English = 24 cases. Covers aligned 44px controls, no overlap or horizontal overflow, native picker semantics and keyboard access (WebKit uses macOS Option-Tab), explicit preference preservation, invalid preferences, default wood knock and preview interaction. Screenshots and results go to ignored `artifacts/sound-settings/`.

The shared `dm-lifecycle.fixture.html` now includes the production body's `argo-messenger` class. Without it, scoped mobile styles were absent from older fixture checks. `dm-delegation.browser.mjs` accepts `DM_TEST_PORT` for isolated concurrent checks.

Server fallback and legacy token preferences are verified on disposable PostgreSQL:

```sh
bash scripts/billing-pg-drill.sh test/msgr-sound-default-pg.test.mjs
node --test test/msgr-push.test.mjs
```

These are browser/SQL/payload checks. Native iOS/Android delivered notification sound and device picker appearance require native-device verification.
