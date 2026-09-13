# Messenger work panel browser regression

This harness renders the actual Messenger `main.jsx`, `App.jsx`, and work panel with an authenticated in-memory fixture. It does not exercise a real scheduler, agent, account, or Supabase deployment.

The Vite configuration disables environment-file loading with `envDir: '/dev/null'` and replaces the Supabase client. Each scenario uses a fresh browser context; requests outside `127.0.0.1` are blocked. Fixture mutations never reach production.

From `apps/messenger`, start the isolated server:

```sh
node node_modules/vite/bin/vite.js --config test/work-panel.config.mjs
```

Run with an installed Playwright module and Chrome/WebKit browser runtime:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/work-panel.browser.mjs
WORK_ENGINE=webkit WORK_FILTER=390 PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/work-panel.browser.mjs
```

Optional `WORK_TEST_PORT` changes the default `5217` in both commands. `WORK_FILTER` restricts scenario IDs. Artifacts are written to `artifacts/work-panel-chromium/` or `artifacts/work-panel-webkit/`; each run replaces that engine's `results.json`.

Covered behavior:

- Team creation, discussion, blocked-work continuation and cancellation. Busy controls prevent duplicate submission; connection retries preserve the draft and request ID.
- Loading, missing-backend upgrade guidance and retry. Legacy agents cannot accept unsupported team work; ordinary automation remains available.
- Automation creation/editing, pause/resume, manual-run request IDs, history, and deletion. Edit/run/delete errors preserve retry state; deletion requires the title and confirmation phrase.
- Deletion-dialog focus containment and Escape cancellation, keyboard return to the work-panel trigger, and owner-only editing controls.
- Pagination through 27 automations, including older records.
- Korean/English, desktop `1280×900`, mobile `390×780`, light/dark themes, and a `390×430` short-viewport editor with reachable bottom actions.

The short viewport checks available layout and scrolling, not an actual on-device keyboard or native safe-area inset. Desktop Tauri, iOS/Android installations, scheduling, crew execution, cloud permissions, and real external integrations require their separate integration gates.

Independent QA found a zero-size deletion-dialog wrapper inside the panel's flex overlay. The implementation now gives the dialog a viewport-sized container and traps focus; this harness detects both regressions.
