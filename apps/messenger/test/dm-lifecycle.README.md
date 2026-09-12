# DM lifecycle browser regression

The fixture renders the real production `src/main.jsx`, `App.jsx`, language/theme providers and styles. A Vite resolver replaces only `src/supabase.js` with an in-memory contract fixture. The browser blocks non-loopback requests, and the test config does not load an environment file. No production organization or conversation is read or changed.

From `apps/messenger`, run the server:

```sh
node node_modules/vite/bin/vite.js --config test/dm-lifecycle.config.mjs
```

Then run the browser harness with an installed Playwright module (or set `PLAYWRIGHT_MODULE` to its absolute `index.mjs` path):

```sh
node test/dm-lifecycle.browser.mjs
```

The default browser channel is installed Chrome; `PLAYWRIGHT_CHANNEL` overrides it. Screenshots and `results.json` are written under ignored `artifacts/dm-lifecycle/`. `DM_TEST_FILTER` filters `language/width/scenario`, and `DM_TEST_VARIANT` places evidence in a separate directory.

Coverage: Korean/English at 1280px/390px; directory crew/user favorites do not create DMs; explicit DM creation and reuse; existing messages survive pin changes; favorite reorder waits for persistence; leave/archive/delete confirmation survives context-menu closure; cancellation is write-free; failures retain actionable dialogs; destructive confirmation requires both name and phrase; a successful leave stays closed even if refreshing fails; private-channel leave preserves the owned-crew guard. A 390x430 mobile viewport checks the scrollable delete dialog and keyboard focus containment.

For the pre-fix baseline, run a second isolated server:

```sh
DM_BASELINE_REF=fca91a7efd2241b7d90f68b3c364e2d57a54761c DM_TEST_PORT=5198 node node_modules/vite/bin/vite.js --config test/dm-lifecycle.config.mjs
DM_TEST_PORT=5198 DM_TEST_VARIANT=baseline DM_TEST_FILTER='^ko/1280/(target-favorites|leave)$' node test/dm-lifecycle.browser.mjs
```

Expected baseline failures: favoriting alone creates one channel; selecting leave closes the context menu without rendering a confirmation card. The config loads the historical App source without replacing files in the checkout.

This verifies browser interactions and client call contracts. It does not prove live database permissions, installed Tauri behavior, device touch/keyboard behavior, or cross-user synchronization.
