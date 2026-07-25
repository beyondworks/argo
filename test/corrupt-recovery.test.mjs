// 손상 대화 복구 회귀 가드 — "크루/회의실 대화가 사라진다"(실사용 신고 2026-07-25)의 근본 경로.
// 유실 사슬: 파일 손상 → readJson이 .corrupt-<ts>로 격리 → 다음 로드는 ENOENT → **영구히 빈 방**.
//
// 계약(분리 검수 CRITICAL 2건 반영, 2026-07-26):
//  ① **파일이 존재하면 복구하지 않는다** — 회의 마치기·새 대화·신규 크루의 "정상적으로 빈 상태"를
//     옛 손상본으로 덮으면 유령 대화가 부활하고, 마치기→부활이 무한 반복된다.
//  ② **파일을 쓰지 않는다(읽기 전용)** — 잘린 salvage로 로컬을 되살리면 sync의 self-heal(원격 완전본
//     pull)이 성립하지 않고 잘린 본이 클라우드로 push돼 로컬 손상이 전 기기 유실로 확대된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { salvageJsonArray, salvageFromCorrupt, readJson, writeJsonAtomic } from '../src/jsonstore.mjs';

/* ── salvage(순수) ── */

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

test('salvage: 메시지 본문에 들어간 JSON의 "messages"를 배열로 오인하지 않는다', () => {
  // 개발자향 제품이라 대화에 JSON을 붙여넣는 일이 흔하다 — 앵커는 최상위 키만(검수 MEDIUM-5)
  const raw = '{"sessionId":"s1","messages":[{"who":"user","text":"이 응답 봐: {\\"messages\\":[{\\"who\\":\\"가짜\\",\\"text\\":\\"유령\\"}]}","ts":1}]}';
  const out = salvageJsonArray(raw, 'messages');
  assert.equal(out.length, 1);
  assert.equal(out[0].who, 'user', '최상위 messages의 항목이어야 한다');
  assert.ok(!out.some((m) => m.who === '가짜'), '본문 안 JSON을 건져오면 안 된다');
});

/* ── salvageFromCorrupt(파일 계약) ── */

test('복구: 파일 부재 + 격리본 → 건져서 반환하되 파일은 쓰지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-salvage-'));
  const file = join(dir, 'room-main.json');
  await writeFile(`${file}.corrupt-1700000000000`,
    '{ "messages": [ {"who":"user","text":"살아있어야 할 발언","ts":1}, {"who":"crew","text":"두 번째","ts":2}, {"who":"user"');
  const s = await salvageFromCorrupt(file, 'messages');
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].text, '살아있어야 할 발언');
  // 읽기 전용 계약 — 원본 파일을 만들지 않는다(sync self-heal이 원격 완전본으로 되살릴 여지 보존)
  const names = await readdir(dir);
  assert.deepEqual(names, ['room-main.json.corrupt-1700000000000'], '복구가 파일을 써서는 안 된다');
});

test('복구: 파일이 존재하면(정상적으로 빈 상태) 복구하지 않는다 — 유령 부활 차단', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-ghost-'));
  const file = join(dir, 'room-main.json');
  // 회의 마치기 직후 상태: 방은 비었지만 파일은 존재(sid 증가) + 과거 손상본 잔재
  await writeJsonAtomic(file, { messages: [], sid: 3 });
  await writeFile(`${file}.corrupt-1700000000000`, '{"messages":[{"who":"user","text":"3주 전 옛날 회의","ts":1}]}');
  assert.equal(await salvageFromCorrupt(file, 'messages'), null, '정상 빈 방을 옛 대화로 덮으면 안 된다');
  const still = await readJson(file, { messages: [] });
  assert.deepEqual(still.messages, []);
  assert.equal(still.sid, 3, 'sid가 보존돼야 잔여 발언 게이트가 유효하다');
});

test('복구: 격리본이 없으면 null(부작용 없음)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-recover-none-'));
  assert.equal(await salvageFromCorrupt(join(dir, 'room-main.json'), 'messages'), null);
  assert.deepEqual(await readdir(dir), []);
});

test('복구: 격리본이 여러 개면 가장 최근 것을 쓴다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-recover-multi-'));
  const file = join(dir, 'room-main.json');
  await writeFile(`${file}.corrupt-1700000000000`, '{"messages":[{"who":"user","text":"옛날","ts":1}');
  await writeFile(`${file}.corrupt-1800000000000`, '{"messages":[{"who":"user","text":"최근","ts":9}');
  const s = await salvageFromCorrupt(file, 'messages');
  assert.equal(s.items[0].text, '최근');
});

/* ── 소비처 배선(room/thread) ── */

test('배선: loadRoom·loadThread가 파일 부재일 때만 복구하고, 빈 파일은 그대로 둔다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-wire-'));
  process.env.ARGO_ROOT = root;
  const { paths } = await import('../src/workspace.mjs');
  const { loadRoom } = await import('../src/room.mjs');
  const { loadThread } = await import('../src/thread.mjs');
  const ws = 'wire-1';
  const chats = paths(ws).chats;
  await writeJsonAtomic(join(chats, 'keep.json'), {}); // 디렉터리 생성용
  // ① 파일 부재 + 격리본 → 화면 복구
  await writeFile(join(chats, 'room-main.json.corrupt-1700000000000'), '{"messages":[{"who":"user","text":"복구될 발언","ts":1}]}');
  const room = await loadRoom(ws);
  assert.equal(room.messages.length, 1);
  assert.equal(room.messages[0].text, '복구될 발언');
  assert.equal(room.salvagedFrom, 'room-main.json.corrupt-1700000000000');
  // ② 정상적으로 빈 크루 대화(파일 존재) + 격리본 → 부활 없음
  await writeJsonAtomic(join(chats, 'ghost.json'), { sessionId: null, messages: [] });
  await writeFile(join(chats, 'ghost.json.corrupt-1700000000000'), '{"messages":[{"who":"user","text":"옛 대화","ts":1}]}');
  const t = await loadThread(ws, 'ghost');
  assert.deepEqual(t.messages, [], '새 대화가 옛 손상본으로 되살아나면 안 된다');
});
