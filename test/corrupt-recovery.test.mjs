// 손상 대화 복구 회귀 가드 — "크루/회의실 대화가 사라진다"(실사용 신고 2026-07-25)의 근본 경로.
// 유실 사슬: 파일 손상 → readJson이 .corrupt-<ts>로 격리 → 다음 로드는 ENOENT → **영구히 빈 방**.
// 이 테스트는 격리본에서 살릴 수 있는 메시지를 되돌리는지(부분 복구 포함) 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { salvageJsonArray, recoverFromCorrupt, readJson } from '../src/jsonstore.mjs';

test('salvage: 꼬리가 잘린 손상본에서 완결 항목만 건진다', () => {
  const raw = '{ "messages": [ {"who":"user","text":"첫 발언","ts":1}, {"who":"pepper","text":"답변","ts":2}, {"who":"user","te';
  const out = salvageJsonArray(raw, 'messages');
  assert.equal(out.length, 2);
  assert.equal(out[0].text, '첫 발언');
  assert.equal(out[1].who, 'pepper');
});

test('salvage: 중첩 객체·이스케이프된 따옴표를 포함한 메시지도 온전히 건진다', () => {
  const raw = '{"messages":[{"who":"user","text":"그가 \\"인용\\"했다","meta":{"a":{"b":1}},"ts":3},{"who":"x","text":"잘림';
  const out = salvageJsonArray(raw, 'messages');
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '그가 "인용"했다');
  assert.deepEqual(out[0].meta, { a: { b: 1 } });
});

test('salvage: 건질 게 없으면 빈 배열(거짓 복구 금지)', () => {
  assert.deepEqual(salvageJsonArray('완전히 깨진 내용', 'messages'), []);
  assert.deepEqual(salvageJsonArray('{"other":[{"a":1}]}', 'messages'), []);
});

test('recover: 격리본에서 원본을 되살린다 — 유실 사슬 차단', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-recover-'));
  const file = join(dir, 'room-main.json');
  // readJson이 손상을 격리한 상태를 재현(원본 없음 + .corrupt-<ts> 존재)
  await writeFile(`${file}.corrupt-1700000000000`,
    '{ "messages": [ {"who":"user","text":"살아있어야 할 발언","ts":1}, {"who":"crew","text":"두 번째","ts":2}, {"who":"user"');
  const r = await recoverFromCorrupt(file, 'messages');
  assert.equal(r.recovered, 2);
  const back = await readJson(file, { messages: [] });
  assert.equal(back.messages.length, 2);
  assert.equal(back.messages[0].text, '살아있어야 할 발언');
});

test('recover: 격리본이 없으면 null(부작용 없음)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-recover-none-'));
  assert.equal(await recoverFromCorrupt(join(dir, 'room-main.json'), 'messages'), null);
  assert.deepEqual(await readdir(dir), []);
});

test('recover: 격리본이 여러 개면 가장 최근 것을 쓴다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-recover-multi-'));
  const file = join(dir, 'room-main.json');
  await writeFile(`${file}.corrupt-1700000000000`, '{"messages":[{"who":"user","text":"옛날","ts":1}');
  await writeFile(`${file}.corrupt-1800000000000`, '{"messages":[{"who":"user","text":"최근","ts":9}');
  await recoverFromCorrupt(file, 'messages');
  const back = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(back.messages[0].text, '최근');
});
