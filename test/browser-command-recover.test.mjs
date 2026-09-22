// K58 — 브라우저 명령 하나가 중단되거나 CDP 30초 상한에 걸려도 그 실행(run)의 브라우저가 영구히 닫히지 않는다.
// 그 탭만 정리하고 다음 호출은 새 탭으로 이어간다. 실행 전체의 종료는 close()만 한다(native-query finally·브리지 close).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession, browserRunners, closeAllBrowsers, findChrome } from '../src/engine/browser-tools.mjs';

test('K58. 명령 중단·시간 초과 뒤에도 같은 실행의 다음 브라우저 호출이 새 탭으로 돈다; close()는 여전히 영구 종료', { skip: !findChrome() && 'No Chromium installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-browser-k58-'));
  const env = { ...process.env, ARGO_ROOT: join(root, 'workspaces'), ARGO_BROWSER_HEADLESS: '1' };
  const http = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title>`); });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const r = browserRunners({ wsId: 'k58', slug: 'shuri', runId: 'run1', env, headless: true });
  try {
    await r.browser_navigate({ url: `${origin}/one` });
    // ① 요청 하나 중단(브리지의 요청별 신호 — 호출 측 MCP 시간 초과·연결 끊김)
    const ac = new AbortController();
    const slow = r.browser_eval({ js: 'new Promise(r => setTimeout(() => r("late"), 60000))' }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(slow);
    await r.browser_navigate({ url: `${origin}/two` });
    assert.equal(await r.browser_eval({ js: 'document.title' }), '/two', '중단 뒤 다음 호출이 이어진다');
    // ② CDP 명령 30초 상한(Browser command timed out) — 실제 문구로 한 번 실패시킨다
    const page = BrowserSession.peek('k58', { env, slug: 'shuri' }).pages.get('run1');
    page.evaluate = async () => { throw new Error('Browser command timed out'); };
    await assert.rejects(r.browser_eval({ js: '1' }), /timed out/);
    await r.browser_navigate({ url: `${origin}/three` });
    assert.equal(await r.browser_eval({ js: 'document.title' }), '/three', '시간 초과 뒤 다음 호출이 새 탭으로 이어진다');
    // ③ 실행 종료는 여전히 영구
    await r.close();
    await assert.rejects(r.browser_eval({ js: 'document.title' }), /Browser task closed/);
  } finally { await closeAllBrowsers(); await new Promise((resolve) => http.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
});
