// K57(감사 2026-09-22): 턴 중 저장(saveNativeSession)이 전사 전체를 앞에서 절단해 sess.messages를 교체하던 결함.
// 현재 턴의 도구 결과가 크면 지시 하나만 남고 도구 기록이 전부 사라져 모델이 같은 작업(쓰기·쪽지·제출)을 처음부터 반복했다.
// 처방(R3 판정 c): 상한 초과 시 오래된 스크린샷 정리를 전체에 먼저 → 마지막 지시 앞(이전 턴들)만 예산까지 절단, 현재 턴은 불변.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-k57-')); // 실데이터 미접촉 — WS_ROOT는 로드 시 고정
const { saveNativeSession, sessionFile } = await import('../src/engine/session.mjs');

const prompt = (t) => ({ role: 'user', content: t });
const toolPair = (id, body) => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/f/${id}` } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
];
const shot = (id, data) => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'browser_screenshot', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }] }] },
];
const saved = async (ws, slug) => JSON.parse(await readFile(sessionFile(ws, slug), 'utf8')).messages;

test('K57 현재 턴의 큰 도구 결과(6만 자×10)는 턴 중 저장에서 지워지지 않는다', async () => {
  const cur = [prompt('현재 지시')];
  for (let i = 0; i < 10; i++) cur.push(...toolPair(`t${i}`, `${i}`.repeat(60_000)));
  const sess = { id: 'native-k57a', messages: [prompt('이전 지시'), { role: 'assistant', content: [{ type: 'text', text: '이전 답' }] }, ...cur] };
  await saveNativeSession('k57-a', 'crew', sess);
  const results = (m) => m.flatMap((x) => (Array.isArray(x.content) ? x.content : [])).filter((b) => b?.type === 'tool_result');
  assert.equal(results(sess.messages).length, 10, `메모리 전사에 현재 턴 도구 결과가 전부 남아야 한다(${sess.messages.length}msgs)`);
  assert.deepEqual(sess.messages, cur, '이전 턴은 걷히고 현재 턴은 그대로');
  assert.deepEqual(await saved('k57-a', 'crew'), cur, '저장본도 같다');
});

test('K57 인접 핀: 현재 턴 스크린샷이 여러 장이면 저장본·메모리 모두 최신 1장만 남는다', async () => {
  const cur = [prompt('화면 보고 해줘')];
  for (let i = 0; i < 3; i++) cur.push(...shot(`s${i}`, `${'ABC'[i]}`.repeat(200_000)));
  const sess = { id: 'native-k57b', messages: [prompt('이전'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ...cur] };
  await saveNativeSession('k57-b', 'crew', sess);
  for (const m of [sess.messages, await saved('k57-b', 'crew')]) {
    const imgs = m.flatMap((x) => (Array.isArray(x.content) ? x.content : [])).flatMap((b) => (b?.type === 'tool_result' && Array.isArray(b.content) ? b.content : [b])).filter((b) => b?.type === 'image');
    assert.equal(imgs.length, 1, '이미지는 최신 1장만');
    assert.equal(imgs[0].source.data[0], 'C', '남는 것은 최신 스크린샷');
    assert.equal(m.filter((x) => x.content?.[0]?.type === 'tool_result').length, 3, '도구 결과 자리(짝)는 보존');
    assert.ok(JSON.stringify(m).length <= 400_000, '상한 안으로 들어온다');
  }
});

test('K57 인접 핀: 이전 턴이 크고 현재 턴이 작으면 예전처럼 앞에서 절단하고 머리는 지시다', async () => {
  const sess = { id: 'native-k57c', messages: [] };
  for (let i = 0; i < 100; i++) sess.messages.push(prompt(`u${i}`), ...toolPair(`p${i}`, 'x'.repeat(5000)), { role: 'assistant', content: [{ type: 'text', text: 'done' }] });
  const cur = [prompt('지금'), ...toolPair('now', 'small')];
  sess.messages.push(...cur);
  await saveNativeSession('k57-c', 'crew', sess);
  const m = sess.messages;
  assert.ok(JSON.stringify(m).length <= 300_000 + 1000, `예산까지 절단(${JSON.stringify(m).length})`);
  assert.ok(m.length > cur.length, '예산 안의 이전 턴은 남는다');
  assert.equal(m[0].role, 'user'); assert.equal(typeof m[0].content, 'string', '머리는 tool_result가 아닌 지시');
  assert.deepEqual(m.slice(-cur.length), cur, '현재 턴 불변');
  assert.deepEqual(await saved('k57-c', 'crew'), m);
});
