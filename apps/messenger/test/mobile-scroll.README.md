# Mobile scrolling regression

For native WKWebView QA, `/test/mobile-scroll.fixture.html` seeds 40 agents automatically (`?lang=en` selects English); serve it with the same isolated Vite configuration. It includes `viewport-fit=cover`.

Runs the actual Messenger App with `dm-lifecycle.supabase.mjs`, 40 agents, and 61 messages. All external requests are blocked; no credentials or live account are used. No new package is required.

From `apps/messenger`, start the isolated fixture server:

```sh
SCROLL_TEST_PORT=5207 node node_modules/vite/bin/vite.js --config test/mobile-scroll.config.mjs
```

Run with an existing Playwright installation:

```sh
SCROLL_TEST_PORT=5207 PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/mobile-scroll.browser.mjs
SCROLL_TEST_PORT=5207 SCROLL_ENGINE=webkit PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/mobile-scroll.browser.mjs
```

The Chromium run uses a mobile touch context and trusted CDP touch swipes. The WebKit run uses phone viewport dimensions in a normal context because Playwright does not support wheel input in its mobile WebKit context. It checks WebKit layout and scroll behavior; it does not prove iOS WKWebView overscroll animation.

To compare the previous CSS while preserving all current files:

```sh
SCROLL_BASELINE_REF=origin/main SCROLL_TEST_PORT=5208 node node_modules/vite/bin/vite.js --config test/mobile-scroll.config.mjs
SCROLL_TEST_PORT=5208 SCROLL_VARIANT=baseline PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/mobile-scroll.browser.mjs
```

Use the actual prior release commit instead of `origin/main` after merging. Artifacts and measurements are saved under `artifacts/mobile-scroll/{variant}-{engine}/`.

Checks cover 320×568 Korean and 390×844 English: last agent above the bottom navigation; manually reaching, collapsing, and expanding the last section; touch scrolling; chat beginning/end and composer clearance; settings clearance and horizontal overflow; and scrolling with reduced motion. No programmatic scroll positioning or automatic scroll-into-view is used for the home-list reachability assertions. Baseline passing scenarios must not be reported as reproduced defects. OS rubber-band animation and safe-area behavior require a separate native simulator/device check.
