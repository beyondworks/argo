// 검수 조건의 두 유실 시나리오를 잰다(#578 재검수).
//   A) approval 방송 유실 — message 방송만 오면 결재 카드가 뜨는가
//   B) 실시간이 끊겼다고 알려진 뒤 방송 없는 새 글이 몇 초 만에 잡히는가
// 서버: node node_modules/vite/bin/vite.js --config test/instant-delivery.config.mjs
// 실행: PLAYWRIGHT_MODULE=<playwright index.mjs 절대 경로> node test/instant-delivery.loss.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.IN_TEST_PORT || 5201;
const b = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });

async function open() {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route('**/*', (r) => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
  // 대조 타이머 — 앱 폴과 같은 10초 간격. 환경이 타이머를 늦추면 여기에도 드러난다.
  await p.addInitScript(() => { localStorage.setItem('argo-lang', 'ko'); window.__ticks = []; setInterval(() => window.__ticks.push(Math.round(performance.now())), 10_000); });
  await p.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html`);
  await p.locator('.msgr-spine').getByText('먼저 있던 글').first().waitFor({ timeout: 20000 });
  await p.evaluate(() => { window.__instant.latency = 60; });
  return { p, errs };
}
async function waitFor(p, fn, capMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < capMs) { if (await p.evaluate(fn)) return Date.now() - t0; await p.waitForTimeout(250); }
  return null;
}
const out = {};

// A) approval 방송 유실
{
  const { p, errs } = await open();
  await p.waitForTimeout(12_000); // 첫 보정 조회(마운트 직후 swept=0)가 지나간 뒤에 잰다 — 검수자가 겪은 측정 함정
  await p.evaluate(() => {
    const s = window.__instant; const id = s.nextId++;
    s.tables.msgr_crew_approvals.push({ id: 'ap-probe', org_id: 'org-fixture', channel_id: 'general', crew_id: 'crew-x', approval_id: 'x1', action: '위험한 작업 탐침', reason: null,
      status: 'pending', risk: 'low', message_id: id, kind: null, payload: null, decided_by: null, decided_at: null });
    s.tables.msgr_messages.push({ id, org_id: 'org-fixture', channel_id: 'general', author_kind: 'crew', author_user_id: null, crew_id: 'crew-x', kind: 'approval_card',
      body: '결재 요청', created_at: new Date().toISOString(), edited_at: null, deleted_at: null, mentions: [{ kind: 'approval', id: 'ap-probe' }], reply_to: null, meta: null, client_msg_id: null });
    s.queries.length = 0;
    // 서버 트리거 모양 그대로(여윈 payload, kind=글 종류). approval 방송은 쏘지 않는다 = 유실.
    s.topics['org:org-fixture'].message.forEach((h) => h({ payload: { id, channel_id: 'general', author_kind: 'crew', author_user_id: null, crew_id: 'crew-x',
      kind: 'approval_card', mentions: [{ kind: 'approval', id: 'ap-probe' }], reply_to: null } }));
  });
  const ms = await waitFor(p, () => document.body.innerText.includes('위험한 작업 탐침'), 25_000);
  out.A_approvalLost = { cardShownAfterMs: ms,
    approvalQueries: (await p.evaluate(() => window.__instant.queries)).filter((q) => q === 'msgr_crew_approvals').length,
    controlTicks: await p.evaluate(() => window.__ticks), pageErrors: errs };
  await p.close();
}

// B) 알려진 끊김 뒤 방송 없는 새 글
{
  const { p, errs } = await open();
  await p.waitForTimeout(12_000); // 첫 보정 조회 뒤
  await p.evaluate(() => window.__instant.post({ body: '방송으로 온 글', withChannelTopic: false })); // rtSeen을 지금으로
  await p.locator('.msgr-row').filter({ hasText: '방송으로 온 글' }).first().waitFor();
  await p.evaluate(() => {
    const s = window.__instant;
    s.status('org:org-fixture', 'CHANNEL_ERROR'); // 끊겼다고 알린다
    s.tables.msgr_messages.push({ id: s.nextId++, org_id: 'org-fixture', channel_id: 'general', author_kind: 'user', author_user_id: 'user-other', crew_id: null, kind: 'text',
      body: '끊긴 동안 온 글', created_at: new Date().toISOString(), edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null }); // 방송 없음
    window.__probeAt = Math.round(performance.now());
  });
  const ms = await waitFor(p, () => document.body.innerText.includes('끊긴 동안 온 글'), 50_000);
  out.B_knownDisconnect = { caughtAfterMs: ms, probeAt: await p.evaluate(() => window.__probeAt), controlTicks: await p.evaluate(() => window.__ticks), pageErrors: errs };
  await p.close();
}
await b.close();
console.log(JSON.stringify(out, null, 2));
