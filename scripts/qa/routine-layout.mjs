/* global document, localStorage, getComputedStyle */
// Against an isolated Next dev server only; all API requests are fixture responses.
// QA_ORIGIN selects the server; PLAYWRIGHT_MODULE selects an installed Playwright module.
// QA_CASES is [[viewportWidth, appZoom], ...]; QA_LANG, QA_SIDE and QA_TOUCH cover optional contexts.
// QA_SPACIOUS_MUTATION=1 restores the reported tall layout and must fail the row-height assertion.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.QA_ORIGIN || 'http://127.0.0.1:5237';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Use an isolated local server');
const out = path.resolve(process.env.QA_OUTPUT || 'artifacts/routine-layout/final');
await fs.mkdir(out, { recursive: true });
const agents = [{ slug: 'pepper', name: '페퍼', role: '조직 총괄 조율자', status: 'idle' }];
const routine = (i) => ({ id: `r${i}`, title: ['노션 일정 리마인드', '노션 일정 리마인드 자동 기입 (오전)', '신규 메일 보고 (저녁 19:30)'][i % 3], agentSlug: 'pepper', prompt: '오늘 일정을 확인하고 예정된 회의 30분 전에 알림을 보내줘. 필요한 준비 사항과 장소도 함께 정리해줘.', enabled: true, schedule: { type: 'daily', time: '09:00' }, lastRun: Date.now() - 3600000, lastOk: true });
const base = { company: { id: 'fixture', name: '레이아웃 검수 회사', crewPinned: ['pepper'] }, agents, memories: [], stats: {} };
const lang = process.env.QA_LANG || 'ko';
const labels = Object.fromEntries(Object.entries({ edit: ['루틴 수정', 'Edit routine'], save: ['변경 저장', 'Save changes'], name: ['루틴 이름', 'Routine name'], on: ['가동', 'On'], off: ['정지', 'Off'], run: ['실행', 'Run'], runNow: ['지금 즉시 실행', 'Run now'], close: ['닫기', 'Close'], remove: ['삭제', 'Delete'], cancel: ['취소', 'Cancel'] }).map(([key, values]) => [key, values[lang === 'en' ? 1 : 0]]));
const results = [];
const cases = JSON.parse(process.env.QA_CASES || '[[1600,1],[1440,1],[1280,1],[1024,1],[768,1],[360,1],[1440,1.25],[1440,1.5],[1440,2],[960,2]]');
for (const engine of (process.env.QA_ENGINES || 'chromium,webkit').split(',')) {
  const browser = await ({ chromium, webkit }[engine]).launch({ headless: true, ...(engine === 'chromium' && process.env.QA_CHROME ? { executablePath: process.env.QA_CHROME } : {}) });
  try {
    for (const [width, zoom] of cases) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: process.env.QA_TOUCH === '1' });
      const page = await context.newPage(), errors = [], writes = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(({ zoom, lang }) => {
        localStorage.setItem('argo-zoom', String(zoom)); localStorage.setItem('argo-lang', lang); localStorage.setItem('argo-theme', 'graphite-dark');
      }, { zoom, lang });
      let routines = Array.from({ length: 6 }, (_, i) => routine(i));
      await page.route('**/*', async (route) => {
        const request = route.request(), u = new URL(request.url()), p = u.pathname;
        if (u.origin !== origin) return route.abort();
        if (!p.startsWith('/api/')) return route.continue();
        if (request.method() !== 'GET') {
          writes.push({ path: p, method: request.method(), body: request.postData() });
          if (p.endsWith('/routines') && request.method() === 'PUT') { const body = request.postDataJSON(); routines = routines.map((r) => r.id === body.id ? { ...r, ...body } : r); }
          if (p.endsWith('/routines') && request.method() === 'DELETE') routines = routines.filter((r) => r.id !== u.searchParams.get('id'));
          return route.fulfill({ json: p.endsWith('/routines/run') ? { reply: 'Fixture routine result' } : { ok: true } });
        }
        let data = {};
        if (p === '/api/me') data = { authOn: false, user: { id: 'fixture-user' }, capabilities: { localExecution: true } };
        else if (p.endsWith('/routines/notifications')) data = { channels: ['telegram', 'slack', 'msgr'].map((kind) => ({ kind, ready: true })), messengerChannels: [] };
        else if (p.endsWith('/routines')) data = { routines };
        else if (p.endsWith('/agents')) data = { agents };
        else if (p.endsWith('/tasks')) data = { running: [], recent: [] };
        else if (p.endsWith('/vault')) data = { content: '검수용 보조 문서', docs: [], projects: [] };
        else if (p.endsWith('/fixture')) data = base;
        else if (p.endsWith('/ping')) data = { ok: true, version: 'fixture' };
        else if (p.endsWith('/runners')) data = { runners: [], autoRunnerId: 'claude' };
        return route.fulfill({ json: data });
      });
      await page.goto(`${origin}/c/fixture/routines${process.env.QA_SIDE ? '?side=doc:vault/notes/test.md' : ''}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: labels.edit, exact: true }).first().waitFor();
      await page.waitForFunction(() => document.fonts.status === 'loaded');
      const first = page.locator('main table tbody tr').first();
      await first.scrollIntoViewIfNeeded();
      if (process.env.QA_SPACIOUS_MUTATION === '1') {
        // Reintroduce the reported tall two-column layout to prove the density assertion catches it.
        await page.addStyleTag({ content: `main table tbody tr {display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:14px 20px!important;padding:18px 20px!important} main table tbody tr::after{display:none!important} main table tbody td{display:block!important;order:0!important;margin:0!important} main table tbody td:first-child,main table tbody td:last-child{grid-column:1/-1!important} main table tbody td:not(:first-child):not(:last-child)>span:first-child{display:block!important;margin-bottom:5px!important}` });
      }
      const metrics = await first.evaluate((row, z) => {
        const r = row.getBoundingClientRect();
        const cells = [...row.children].filter((e) => e.tagName === 'TD');
        return { height: r.height / z, display: getComputedStyle(row).display, width: r.width / z, docWidth: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, controls: [...row.querySelectorAll('button')].map((b) => { const q = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label') || b.textContent.trim(), inside: q.left >= r.left - 1 && q.right <= r.right + 1, w: q.width / z, h: q.height / z }; }), summaryWidth: cells[0].getBoundingClientRect().width / z };
      }, zoom);
      assert.equal(metrics.controls.length, 4, 'State, run, edit, delete remain available');
      assert.ok(metrics.controls.every((b) => b.inside), JSON.stringify(metrics));
      if (process.env.QA_TOUCH === '1') assert.ok(metrics.controls.slice(1).every((b) => b.w >= 44 && b.h >= 44), 'Touch actions retain 44px targets');
      assert.ok(metrics.docWidth <= metrics.viewport + 2, JSON.stringify(metrics));
      const headerInside = await first.evaluate((row) => {
        const card = row.closest('.card'), r = card.getBoundingClientRect();
        return [...card.querySelector('.card-head').children].every((child) => { const b = child.getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1; });
      });
      assert.ok(headerInside, 'Routine list heading and active count remain inside the card');
      assert.ok(metrics.height <= (metrics.width >= 512 ? 150 : 270), `Excessive routine row height: ${JSON.stringify(metrics)}`);
      await page.screenshot({ path: path.join(out, `${engine}-${width}-z${zoom}.png`) });
      // Exercise adjacent actions without real work: every API is mocked.
      await first.getByRole('button', { name: labels.edit, exact: true }).click();
      await page.getByRole('button', { name: labels.save, exact: true }).waitFor();
      await page.getByPlaceholder(labels.name, { exact: true }).fill('수정 확인용 루틴');
      await page.getByRole('button', { name: labels.save, exact: true }).click();
      await page.getByText('수정 확인용 루틴', { exact: true }).waitFor();
      assert.ok(writes.some((w) => w.method === 'PUT' && JSON.parse(w.body).title === '수정 확인용 루틴'));
      await first.getByRole('button', { name: labels.on, exact: true }).click();
      await first.getByRole('button', { name: labels.off, exact: true }).waitFor();
      await first.getByRole('button', { name: labels.run, exact: true }).click();
      await page.getByRole('button', { name: labels.runNow, exact: true }).click();
      await page.getByText('Fixture routine result', { exact: true }).waitFor();
      await page.getByRole('button', { name: labels.close, exact: true }).click();
      assert.ok(writes.some((w) => w.path.endsWith('/routines/run')));
      await first.getByRole('button', { name: labels.remove, exact: true }).click();
      await page.getByRole('button', { name: labels.cancel, exact: true }).waitFor();
      await page.getByRole('button', { name: labels.cancel, exact: true }).click();
      assert.equal(writes.filter((w) => w.method === 'DELETE').length, 0, 'Cancel must not delete');
      assert.equal(errors.length, 0, errors.join('\n'));
      results.push({ engine, lang, viewportWidth: width, zoom, ...metrics, errors, editSaved: true, stateToggled: true, runResult: true, deleteCancelled: true });
      console.log(JSON.stringify(results.at(-1)));
      await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
      await context.close();
    }
  } finally { await browser.close(); }
}
