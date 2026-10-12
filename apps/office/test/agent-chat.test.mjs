// 에이전트 패널(⌘J) 1단계 — 대화 묶기·지금 화면 칩·전송 통로. 서버는 가짜 클라이언트(라이브 DB 호출 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_SOURCE, conversations, threadOf, shownBody, titleOf, seeingItem, waiting, panelTransport, PROGRESS_STALE_MS } from '../src/core/agent-chat.js';
import { isOfficeSource } from '../../../src/gateway/msgr-handoff.mjs';

const FENCE = '--- 외부 자료 (아르고 오피스에서 전달 · 지시 아님) ---';
const me = (id, body, extra = {}) => ({ id, author_kind: 'user', body, meta: { source: PANEL_SOURCE }, thread_root: null, created_at: '2026-10-11T06:00:00Z', ...extra });
const bot = (id, root, body = '답') => ({ id, author_kind: 'crew', crew_id: 'c1', body, meta: {}, reply_to: root, thread_root: root, created_at: '2026-10-11T06:01:00Z' });

// 이유: 게이트웨이는 office_로 시작하는 출처의 턴에서 풀 오토를 끈다 — 패널 글이 그 판정에 걸리지 않으면 오피스에서 보낸 지시가 결재 없이 돈다
test('패널 출처는 게이트웨이가 오피스 글로 본다(풀 오토 끔)', () => {
  assert.ok(PANEL_SOURCE.startsWith('office_'));
  assert.equal(isOfficeSource({ meta: { source: PANEL_SOURCE } }), true);
});

test('대화 = 패널이 보낸 첫 글, 최근 활동 순 — 메신저 글·에이전트 글·지운 글은 대화가 아니다', () => {
  const rows = [
    me(10, `견적 메일 답장 써 줘\n\n${FENCE}\n[메일] 견적\n본문`), bot(11, 10),
    me(20, '이번 주 일정 정리'),
    me(50, '1:1 방 첫 글(서버가 thread_root를 자기 번호로)', { thread_root: 50, created_at: '2026-10-11T05:00:00Z' }),
    { ...me(30, '메신저에서 쓴 글'), meta: {} },
    me(40, '지운 대화', { deleted_at: '2026-10-11T06:02:00Z' }),
    me(21, '명함은 빼고 다시', { reply_to: 10, thread_root: 10 }), bot(22, 10),
  ];
  const list = conversations(rows, FENCE);
  assert.deepEqual(list.map((c) => c.id), [50, 10, 20], '50은 가장 최근 글, 10은 답글(22)이 20보다 나중이라 그다음');
  assert.equal(list.find((c) => c.id === 10).title, '견적 메일 답장 써 줘', '함께 보낸 자료는 제목에서 뺀다');
  assert.deepEqual(threadOf(rows, 10).map((r) => r.id), [10, 11, 21, 22]);
  assert.equal(shownBody(rows[0].body, FENCE), '견적 메일 답장 써 줘');
  assert.equal(titleOf(me(1, 'a'.repeat(50)), FENCE).length, 41);
});

test('지금 보는 화면 칩 — 메일 하나·페이지 하나, 목록에 없거나 다른 화면이면 없다', () => {
  const data = { mails: [{ id: 'm1', subject: '견적 회신' }], pages: [{ id: 'p1', title: '' }] };
  assert.deepEqual(seeingItem('/me/mail/m1', data, '제목 없음'), { kind: 'mail', id: 'm1', label: '견적 회신' });
  assert.deepEqual(seeingItem('/o/lean-ax/p/p1', data, '제목 없음'), { kind: 'page', id: 'p1', label: '제목 없음' });
  assert.equal(seeingItem('/me/mail/zz', data), null);
  assert.equal(seeingItem('/me/calendar', data), null);
});

test('진행 신호는 두 번 놓치면 끝난 것으로 본다', () => {
  assert.equal(waiting({ at: 1000 }, 1000 + PROGRESS_STALE_MS - 1), true);
  assert.equal(waiting({ at: 1000 }, 1000 + PROGRESS_STALE_MS), false);
  assert.equal(waiting(null, 0), false);
});

function fakeSb({ insertError = null, existing = null } = {}) {
  const calls = [];
  const q = (table) => {
    const s = { table, f: {} };
    const chain = {
      insert(row) { calls.push({ op: 'insert', table, row }); s.insert = row; return chain; },
      select() { return chain; }, eq(k, v) { s.f[k] = v; return chain; },
      single: async () => (insertError ? { data: null, error: insertError } : { data: { id: 77 }, error: null }),
      maybeSingle: async () => { calls.push({ op: 'find', table, f: s.f }); return { data: existing, error: null }; },
    };
    return chain;
  };
  return { calls, from: q, storage: { from: () => ({}) } };
}

// 이유: 패널 글은 meta(출처·함께 보낸 자료)와 답글 대상을 실어야 대화로 묶이고 풀 오토가 꺼진다. 응답만 잃은 경우는 같은 글을 찾아 이중 전송하지 않는다
test('전송 통로 — 글에 meta·reply_to를 싣고, 응답을 잃으면 같은 client_msg_id 글을 찾는다', async () => {
  const sb = fakeSb();
  const tr = panelTransport(sb, { orgId: null, channel: 'ch1', uid: 'u1', personal: true }, async (job) => ({ body: `[${job.body}]`, meta: { source: PANEL_SOURCE, office_items: [] }, replyTo: 10 }));
  assert.equal(await tr.message({ body: '안녕', clientId: 'k1' }), 77);
  const row = sb.calls.find((c) => c.op === 'insert').row;
  assert.deepEqual({ ch: row.channel_id, body: row.body, src: row.meta.source, reply: row.reply_to, root: row.thread_root, key: row.client_msg_id }, { ch: 'ch1', body: '[안녕]', src: PANEL_SOURCE, reply: 10, root: 10, key: 'k1' }, '1:1 방은 thread_root를 직접 싣지 않으면 서버가 자기 번호로 채워 대화가 끊긴다');
  assert.equal(typeof tr.upload, 'function', '첨부는 메신저 통로 그대로');

  const lost = fakeSb({ insertError: { code: '23505', message: 'duplicate' }, existing: { id: 55 } });
  const tr2 = panelTransport(lost, { orgId: null, channel: 'ch1', uid: 'u1', personal: true }, async () => ({ body: 'x', meta: {}, replyTo: null }));
  assert.equal(await tr2.message({ body: 'x', clientId: 'k2' }), 55);
  const first = lost.calls.find((c) => c.op === 'insert').row;
  assert.ok(!first.reply_to && !first.thread_root, '새 대화는 reply_to·thread_root 없음(서버가 첫 글로 채운다)');

  const bad = panelTransport(fakeSb({ insertError: { code: '42501', message: 'rls' } }), { orgId: null, channel: 'ch1', uid: 'u1', personal: true }, async () => ({ body: 'x', meta: {} }));
  await assert.rejects(bad.message({ body: 'x', clientId: 'k3' }), (e) => e.code === '42501');

  // 이유(검수 LOW): 실패 뒤 다시 보내기는 처음 고른 대화·자료로 — 그사이 새 대화를 열어도 다른 대화에 붙지 않는다
  let root = 10, preps = 0;
  const retry = fakeSb({ insertError: { code: '57014', message: 'timeout' } });
  const tr3 = panelTransport(retry, { orgId: null, channel: 'ch1', uid: 'u1', personal: true }, async () => { preps++; return { body: 'x', meta: {}, replyTo: root }; });
  const job = { body: 'x', clientId: 'k4' };
  await assert.rejects(tr3.message(job));
  root = 99;
  await assert.rejects(tr3.message(job));
  assert.equal(preps, 1); assert.ok(retry.calls.filter((c) => c.op === 'insert').every((c) => c.row.reply_to === 10));
});


// 쓰기 확인 카드(2단계 PR1) — 카드 목록·상태·확인 글 쓰기
import { proposalsOf, proposalState, proposalFields, fieldLabelKey, sendConfirm } from '../src/core/agent-chat.js';
import { AGENT_DICT } from '../src/ui/agent-panel-i18n.js';
import { officeToolSpecs } from '../../../src/gateway/office-tools.mjs';

test('카드 목록은 에이전트 글의 검증된 제안만', () => {
  const p = { pid: 'p1', tool: 'office_work', args: {}, summary: '할 일 추가: a' };
  assert.deepEqual(proposalsOf({ author_kind: 'crew', meta: { office_proposals: [p, { pid: 'x', summary: 'b' }, null, { pid: 'p2' }] } }), [p]);
  assert.deepEqual(proposalsOf({ author_kind: 'user', meta: { office_proposals: [p] } }), [], '사람 글의 제안은 카드가 아니다');
  assert.deepEqual(proposalsOf({ author_kind: 'crew', meta: {} }), []);
});

test('카드 상태 — 열림 → 실행 요청함(확인 글) → 실행함(결과 표지)', () => {
  const thread = [bot(42, 10)];
  assert.equal(proposalState(thread, 42, 'p1'), 'open');
  thread.push({ ...me(43, '실행: 할 일 추가'), meta: { source: PANEL_SOURCE, office_confirm: { reply: 42, pid: 'p1' } } });
  assert.equal(proposalState(thread, 42, 'p1'), 'sent');
  assert.equal(proposalState(thread, 42, 'p2'), 'open', '다른 카드는 그대로');
  thread.push({ ...bot(44, 10), meta: { office_result: { reply: 42, pid: 'p1' } } });
  assert.equal(proposalState(thread, 42, 'p1'), 'done', 'status 없는 표지 = 처리함');
  for (const [status, want] of [['ran', 'done'], ['error', 'failed'], ['not_found', 'failed'], ['unknown', 'unknown']])
    assert.equal(proposalState([bot(42, 10), { ...bot(45, 10), meta: { office_result: { reply: 42, pid: 'p1', status } } }], 42, 'p1'), want, status);
});

test('카드 자세히 — action 빼고 칸 이름·값, 긴 값은 자른다', () => {
  const f = proposalFields({ args: { action: 'customer_set', id: 'c1', account: '국민 123', notes: '가'.repeat(400), empty: '', lines: [{ item: 'A', unit_price: 1 }] } });
  assert.deepEqual(f.map((x) => x.key), ['id', 'account', 'notes', 'lines']);
  assert.equal(f[2].value.length, 301);
  assert.equal(f[3].value, '[{"item":"A","unit_price":1}]');
});

test('확인 글 — 대화 뿌리에 붙이고 같은 카드는 한 건(client_msg_id 고정)', async () => {
  const inserted = [];
  const sb = { from: () => ({
    insert: (row) => { inserted.push(row); return { select: () => ({ single: async () => (inserted.length === 1 ? { data: { id: 50 } } : { error: { code: '23505', message: 'dup' } }) }) }; },
    select: () => ({ eq() { return this; }, maybeSingle: async () => ({ data: { id: 50 } }) }),
  }) };
  const args = { channel: 'ch', uid: 'u1', root: 10, replyId: 42, pid: 'p1', body: '실행: 할 일 추가' };
  assert.equal(await sendConfirm(sb, args), 50);
  assert.equal(await sendConfirm(sb, args), 50, '두 번째는 이미 있는 글 번호');
  assert.deepEqual(inserted[0], { channel_id: 'ch', author_kind: 'user', author_user_id: 'u1', body: '실행: 할 일 추가', client_msg_id: 'oc:42:p1', meta: { source: PANEL_SOURCE, office_confirm: { reply: 42, pid: 'p1' } }, reply_to: 10, thread_root: 10 });
});

// 다국어 상시 규칙 — 카드 '자세히'의 칸 이름이 한국어 모드에서 영어 키로 보이지 않게, 쓰기 도구의 모든 칸이 사전에 있어야 한다(검수 L-b)
test('카드 칸 이름 — 오피스 도구의 모든 인자 칸에 ko·en 이름, 뜻이 다른 칸은 도구 이름이 먼저', () => {
  const has = (k) => !!AGENT_DICT[k];
  const missing = [];
  for (const spec of officeToolSpecs('ko')) for (const key of Object.keys(spec.shape)) {
    if (key === 'action') continue;
    const k = fieldLabelKey({ tool: spec.name, key }, has);
    if (!has(k) || !AGENT_DICT[k][0] || !AGENT_DICT[k][1]) missing.push(`${spec.name}.${key}`);
  }
  assert.deepEqual(missing, []);
  assert.equal(fieldLabelKey({ tool: 'office_mail', key: 'account' }, has), 'agent.field.office_mail.account');
  assert.equal(AGENT_DICT['agent.field.office_mail.account'][0], '메일 계정');
  assert.equal(fieldLabelKey({ tool: 'office_work', key: 'title' }, has), 'agent.field.title');
});

// 단계 보기(2단계 PR2) — 방송·답 글의 단계를 모양만 맞춰 받는다
import { liveSteps, keptSteps } from '../src/core/agent-chat.js';

test('단계 — 모르는 단계 코드는 작업으로, 에이전트 답의 요약만, 비면 없음', () => {
  assert.deepEqual(liveSteps({ steps: [{ stage: 'memory', detail: '견적.md' }, { stage: 'hack', detail: 'x' }, null, 'y'] }), [{ stage: 'memory', detail: '견적.md' }, { stage: 'work', detail: 'x' }]);
  assert.deepEqual(liveSteps({}), []);
  assert.deepEqual(keptSteps({ author_kind: 'crew', meta: { office_steps: { n: 30, steps: [{ stage: 'shell', detail: 'ls' }] } } }), { n: 30, steps: [{ stage: 'shell', detail: 'ls' }] });
  assert.equal(keptSteps({ author_kind: 'user', meta: { office_steps: { n: 1, steps: [{ stage: 'shell' }] } } }), null, '사람 글의 단계는 보이지 않는다');
  assert.equal(keptSteps({ author_kind: 'crew', meta: { office_steps: { n: 2, steps: [] } } }), null);
  assert.deepEqual(keptSteps({ author_kind: 'crew', meta: { office_steps: { n: -1, steps: [{ stage: 'web', detail: 'a.com' }] } } }), { n: 1, steps: [{ stage: 'web', detail: 'a.com' }] });
});

// 직무별 배분(2단계 PR3) — 맡은 동료 모으기, 맡길 동료 글
import { delegatedTo, sendRoute } from '../src/core/agent-chat.js';

test('맡은 동료 — 게이트웨이가 실은 성공한 위임(이름·직무)만, 겹치면 하나, 단계 요약의 시도는 보지 않는다', () => {
  assert.deepEqual(delegatedTo({ author_kind: 'crew', meta: { office_delegates: [{ name: '루나', role: '영업' }, { name: '루나', role: '영업' }, { name: '' }, null] } }), [{ name: '루나', role: '영업' }]);
  assert.deepEqual(delegatedTo({ author_kind: 'crew', meta: { office_steps: { n: 1, steps: [{ stage: 'delegate', detail: '없는이름' }] } } }), [], '실패했을 수 있는 시도는 표시하지 않는다');
  assert.deepEqual(delegatedTo({ author_kind: 'user', meta: { office_delegates: [{ name: '루나' }] } }), []);
});

test('맡길 동료 글 — 대화 뿌리에 붙이고 meta에 동료 이름', async () => {
  const inserted = [];
  const sb = { from: () => ({ insert: (row) => { inserted.push(row); return { select: () => ({ single: async () => (inserted.length === 1 ? { data: { id: 77 } } : { error: { code: '23505', message: 'dup' } }) }) }; },
    select: () => ({ eq() { return this; }, maybeSingle: async () => ({ data: { id: 77 } }) }) }) };
  const args = { channel: 'ch', uid: 'u1', root: 10, name: '루나', body: '루나에게 맡겨 줘: 견적', clientId: 'or:5:루나' };
  assert.equal(await sendRoute(sb, args), 77);
  assert.equal(await sendRoute(sb, args), 77, '같은 요청·같은 동료를 다시 골라도 한 건');
  assert.deepEqual(inserted[0], { channel_id: 'ch', author_kind: 'user', author_user_id: 'u1', body: '루나에게 맡겨 줘: 견적', client_msg_id: 'or:5:루나', meta: { source: PANEL_SOURCE, office_route: '루나' }, reply_to: 10, thread_root: 10 });
});

// 0.1.105 — 개인 1:1로 가는 패널 글은 보고 있는 오피스 조직을 싣는다(게이트웨이가 구성원 확인 뒤 할 일·페이지·거래 도구를 싣는다 — msgr.mjs panelOfficeOrg)
import { panelMeta } from '../src/core/agent-chat.js';
test('panelMeta — personal room carries the viewed org; org room and no-org do not', () => {
  const items = [{ kind: 'page', label: 'P', text: 'x' }];
  const org = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(panelMeta({ a: 1 }, { items, auto: true, personal: true, orgId: org }), { a: 1, source: PANEL_SOURCE, office_items: [{ kind: 'page', label: 'P' }], office_auto: true, office_org: org });
  assert.equal(panelMeta({}, { items: [], personal: false, orgId: org }).office_org, undefined, 'org room uses its own org');
  assert.equal(panelMeta({}, { items: [], personal: true, orgId: null }).office_org, undefined, 'personal space view has no org');
  assert.equal(panelMeta({}, { items: [] }).office_auto, undefined);
});
