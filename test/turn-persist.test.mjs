// 사장의 지시가 답변을 기다리는 동안에도 남아 있는가 — 2단계 저장 회귀 테스트.
//
// 실사용 신고 2026-08-02: "채팅할 때 내가 올린 내용이 페이지를 벗어나거나 새로고침하면 사라진다.
// 답변은 잘 준비되고, 그 답변이 완료되어야 내 질문이 다시 나타난다."
// 원인은 저장 시점이었다 — appendTurn이 턴이 **끝난 뒤** 지시와 답변을 한꺼번에 썼다. 그동안
// 사장의 글은 브라우저 메모리에만 있었고, 새로고침하면 서버 스레드에 없으니 사라졌다.
// 오래 걸리는 턴일수록 오래 사라져 있다.
//
// 계약:
//  ① beginTurn이 답변 전에 지시를 저장한다 → 이 순간 스레드를 읽으면 글이 보인다.
//  ② 완료는 **같은 줄을 마무리**한다 — 새 줄을 밀어 넣으면 같은 지시가 두 번 보인다.
//  ③ 답변은 그 지시 **바로 뒤**에 온다(턴 도중 공유 노트가 끼어도 질문과 답이 떨어지지 않는다).
//  ④ 실패·중단도 같은 줄에 사유를 붙인다.
//  ⑤ 대기 중인 줄은 프롬프트 맥락에서 뺀다 — 지금 보내는 그 글이라, 안 빼면 같은 말이 두 번 들어간다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-turn-'));
const { beginTurn, appendTurn, loadThread, appendSharedNote } = await import('../src/thread.mjs');

const WS = 'co', SLUG = 'pepper';

test('① 답변 전에 이미 저장돼 있다 — 새로고침해도 내 글이 남는다', async () => {
  const turnId = await beginTurn(WS, SLUG, { userMsg: '분기 보고서 정리해줘' });
  const t = await loadThread(WS, SLUG);   // 턴이 끝나기 전에 읽는다 = 새로고침한 것과 같다
  assert.equal(t.messages.length, 1, '지시 한 줄이 즉시 보여야 한다');
  assert.equal(t.messages[0].text, '분기 보고서 정리해줘');
  assert.equal(t.messages[0].who, 'user');
  assert.equal(t.messages[0].awaiting, true, '답변 대기 표시');
  assert.ok(turnId, '완료 때 같은 줄을 찾을 손잡이');
});

test('② 완료는 같은 줄을 마무리한다 — 지시가 두 번 보이면 안 된다', async () => {
  const turnId = await beginTurn(WS, 'a', { userMsg: '안녕' });
  await appendTurn(WS, 'a', { turnId, userMsg: '안녕', reply: '네, 사장님' });
  const { messages } = await loadThread(WS, 'a');
  assert.equal(messages.filter((m) => m.who === 'user').length, 1, '같은 지시가 두 줄이 되면 안 된다');
  assert.equal(messages.length, 2, '지시 + 답변');
  assert.equal(messages[0].awaiting, undefined, '완료되면 대기 표시가 사라진다');
  assert.equal(messages[1].text, '네, 사장님');
});

test('③ 답변은 그 지시 바로 뒤 — 턴 도중 들어온 공유 노트가 사이를 벌리지 않는다', async () => {
  const turnId = await beginTurn(WS, 'b', { userMsg: '질문' });
  await appendSharedNote(WS, 'b', '다른 크루가 남긴 맥락');   // 턴이 도는 중에 도착
  await appendTurn(WS, 'b', { turnId, userMsg: '질문', reply: '답변' });
  const { messages } = await loadThread(WS, 'b');
  const q = messages.findIndex((m) => m.text === '질문');
  assert.equal(messages[q + 1].text, '답변', '질문 바로 다음 줄이 답변이어야 한다');
});

test('④ 실패·중단도 같은 줄에 사유를 붙인다 — 지시문은 보존', async () => {
  const turnId = await beginTurn(WS, 'c', { userMsg: '실패할 지시' });
  await appendTurn(WS, 'c', { turnId, userMsg: '실패할 지시', failed: '러너 연결 실패', aborted: false });
  const { messages } = await loadThread(WS, 'c');
  assert.equal(messages.length, 1, '실패 턴엔 답변 줄이 없다');
  assert.equal(messages[0].failed, '러너 연결 실패');
  assert.equal(messages[0].awaiting, undefined);
  assert.equal(messages[0].text, '실패할 지시', '지시문은 그대로 남는다');
});

test('turnId 없이 부르던 기존 경로(루틴·위임)는 그대로 동작한다', async () => {
  await appendTurn(WS, 'd', { userMsg: '루틴 지시', reply: '결과', via: 'routine' });
  const { messages } = await loadThread(WS, 'd');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].via, 'routine');
});

test('⑤ 대기 중인 줄은 프롬프트 맥락에서 제외된다 — 같은 말이 두 번 들어가면 안 된다', () => {
  const src = readFileSync(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const filters = src.match(/\(m\) => !m\.shared && !m\.failed[^)]*\)\.slice\(-6\)/g) ?? [];
  assert.equal(filters.length, 2, '맥락을 만드는 곳은 CLI·SDK 두 갈래다');
  for (const f of filters) {
    assert.match(f, /!m\.awaiting/,
      '대기 줄을 안 빼면 지금 보내는 지시가 "최근 대화"에도 실려 크루가 같은 말을 두 번 받는다');
  }
});
