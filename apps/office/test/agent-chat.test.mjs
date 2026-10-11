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

