// 결재 쉬운 문장화 — 문자 전용 창구(텔레그램·슬랙) 행동 테스트(분리 검수 H-1·M-4).
// plain(목적·할 일·필요한 것)이 있어도, 접힘 UI가 없는 이 창구들은 실제로 실행될 문장(action)을
// "명령: <action>" 한 줄로 반드시 남겨야 한다 — 결재자가 무엇을 승인하는지 못 보면 안 된다.
// pushEvent를 실제로 태우고 fetch 호출 자체를 가로채 검증한다(소스 문자열 정규식이 아니다 — gateway.test.mjs
// 같은 파일의 기존 계열: "소스 문자열 단언은 이 배선을 못 지킨다" 교훈을 그대로 따른다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useFakeAccountKey } from './helpers/fake-account-key.mjs';
await useFakeAccountKey();

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-apv-notice-'));
const { _pushEventForTest } = await import('../src/gateway.mjs');
const { updateConnection, updateAgentBot } = await import('../src/connections.mjs');
const { createCompany } = await import('../src/workspace.mjs');
const { addApproval } = await import('../src/approvals.mjs');

let n = 0;
const newWs = async (name) => { const id = `apv-notice-${++n}`; await createCompany(id, name, 'pepper'); return id; };

async function withMockFetch(fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { 'content-type': 'application/json' } });
  };
  try { await fn(calls); } finally { globalThis.fetch = orig; }
  return calls;
}

test('텔레그램: plain 있으면 문장이 먼저 보이되, "명령: <action>" 한 줄이 항상 붙는다', async () => {
  const WS = await newWs('결재-텔레그램');
  await updateConnection(WS, 'telegram', { token: 'gw-tok' }); // enabled 기본 false → 직통 봇 폴백 경로
  await updateAgentBot(WS, 'pepper', { token: 'bot-tok' });
  await updateAgentBot(WS, 'pepper', { ownerId: 1, ownerChat: '200' });
  const item = await addApproval(WS, {
    slug: 'pepper', action: 'sendGmail(to=subs@list, subject="9월 뉴스레터")', reason: 'CEO 지시',
    plain: { purpose: '이번 달 뉴스레터 발송 완료', task: '구독자 1200명에게 메일 발송', need: 'Gmail 발송 권한' },
  });
  const calls = await withMockFetch(async () => { await _pushEventForTest({ type: 'approval', wsId: WS, item }); });
  const send = calls.find((c) => c.url.includes('/sendMessage'));
  assert.ok(send, '텔레그램 메시지가 나간다');
  assert.match(send.body.text, /할 일: 구독자 1200명에게 메일 발송/, 'plain 문장이 먼저 보인다');
  assert.match(send.body.text, /명령: sendGmail\(to=subs@list, subject="9월 뉴스레터"\)/, 'H-1: 실제 실행될 명령이 항상 보인다');
});

test('텔레그램: plain 없으면(폴백) 기존처럼 action/사유 그대로 — "명령:" 줄을 새로 붙이지 않는다', async () => {
  const WS = await newWs('결재-텔레그램-폴백');
  await updateConnection(WS, 'telegram', { token: 'gw-tok2' });
  await updateAgentBot(WS, 'pepper', { token: 'bot-tok2' });
  await updateAgentBot(WS, 'pepper', { ownerId: 1, ownerChat: '201' });
  const item = await addApproval(WS, { slug: 'pepper', action: '경쟁사 리포트 업로드', reason: '분기 보고' });
  const calls = await withMockFetch(async () => { await _pushEventForTest({ type: 'approval', wsId: WS, item }); });
  const send = calls.find((c) => c.url.includes('/sendMessage'));
  assert.match(send.body.text, /경쟁사 리포트 업로드/);
  assert.doesNotMatch(send.body.text, /명령:/, '폴백 카드는 기존 그대로 — 중복 명령 줄이 붙지 않는다');
});

test('슬랙: plain 있으면 문장 + "명령: <action>" 한 줄, 없으면(폴백) 기존 action/사유 그대로', async () => {
  const WS1 = await newWs('결재-슬랙');
  await updateConnection(WS1, 'slack', { token: 'xoxb-test', channel: 'C1', enabled: true });
  const item = await addApproval(WS1, {
    slug: 'pepper', action: 'sendGmail(to=subs@list)', reason: 'CEO 지시',
    plain: { purpose: '뉴스레터 발송 완료', task: '구독자 발송', need: 'Gmail 권한' },
  });
  const calls = await withMockFetch(async () => { await _pushEventForTest({ type: 'approval', wsId: WS1, item }); });
  const post = calls.find((c) => c.url.includes('/chat.postMessage'));
  assert.ok(post, '슬랙 메시지가 나간다');
  assert.match(post.body.text, /할 일: 구독자 발송/);
  assert.match(post.body.text, /명령: sendGmail\(to=subs@list\)/, 'H-1: 슬랙도 실제 실행될 명령이 항상 보인다');

  const WS2 = await newWs('결재-슬랙-폴백');
  await updateConnection(WS2, 'slack', { token: 'xoxb-test2', channel: 'C2', enabled: true });
  const item2 = await addApproval(WS2, { slug: 'pepper', action: '경쟁사 리포트 업로드', reason: '분기 보고' });
  const calls2 = await withMockFetch(async () => { await _pushEventForTest({ type: 'approval', wsId: WS2, item: item2 }); });
  const post2 = calls2.find((c) => c.url.includes('/chat.postMessage'));
  assert.match(post2.body.text, /경쟁사 리포트 업로드/);
  assert.doesNotMatch(post2.body.text, /명령:/, '폴백 카드는 기존 그대로');
});
