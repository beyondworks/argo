// 크루 턴 상태 파일 심박 — 유건 제보(2026-09-06): 회의실 발언이 길어지면 회의실·1:1 대화 양쪽에서 사고 과정 표시가
// 사라져 회의가 누락된 것처럼 보였다(답변은 결국 도착). 원인 = 상태 파일은 스트림·도구 이벤트 때만 갱신되는데
// getTurnStatus가 120초 무갱신을 '죽음'으로 본다 → 이벤트 없는 긴 단계(도구 실행·응답 대기)에서 턴이 살아 있는데
// 표시가 꺼짐(격리 재현: 150초 지연 스텁, memory 단계 2분 뒤 stage null). 처방 = 회의실 마커와 같은 심박을
// setTurnStatus/clearTurnStatus 안에 — 호출부 무변경, 키별 한 체인 직렬화, 종료 뒤 부활 금지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-tsheartbeat-'));
const { paths } = await import('../src/workspace.mjs');
const { setTurnStatus, clearTurnStatus, getTurnStatus, _setHeartbeatMsForTest } = await import('../src/turn-status.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusPath = (ws, slug) => join(paths(ws).chats, `${slug}.status.json`);
async function seed(ws) { await mkdir(paths(ws).chats, { recursive: true }); }
/** 파일 ts를 과거로 — 심박이 실제로 ts를 앞당기는지 보는 유일한 방법(120초 창은 실시간으로 기다릴 수 없다) */
async function backdate(ws, slug, ms) {
  const f = statusPath(ws, slug);
  const j = JSON.parse(await readFile(f, 'utf8'));
  await writeFile(f, JSON.stringify({ ...j, ts: Date.now() - ms }));
}

test('심박: 이벤트 없이도 ts가 갱신돼 2분 창을 넘긴 긴 단계에서 표시가 살아 있다 — 단계·문장·출처 보존', async () => {
  _setHeartbeatMsForTest(20);
  const ws = 'hb-alive'; await seed(ws);
  await setTurnStatus(ws, 'mina', 'shell', 'sleep 300', '지금까지 쓴 문장', 'room');
  await backdate(ws, 'mina', 110_000); // 110초 전 — 곧 만료될 참
  await sleep(120);                    // 심박 20ms × 여러 회
  const s = await getTurnStatus(ws, 'mina');
  assert.ok(s, '심박이 ts를 앞당겨 만료를 막는다');
  assert.equal(s.stage, 'shell'); assert.equal(s.detail, 'sleep 300'); assert.equal(s.partial, '지금까지 쓴 문장'); assert.equal(s.source, 'room');
  await clearTurnStatus(ws, 'mina');
});

test('심박 없이 120초를 넘긴 파일은 종전대로 null(고아 판정 유지) — 심박이 판정 규칙을 느슨하게 만들지 않는다', async () => {
  const ws = 'hb-orphan'; await seed(ws);
  await writeFile(statusPath(ws, 'ghost'), JSON.stringify({ stage: 'think', detail: '', partial: '', source: 'chat', startedAt: Date.now() - 200_000, ts: Date.now() - 130_000 }));
  assert.equal(await getTurnStatus(ws, 'ghost'), null, '다른 프로세스가 죽인 파일은 심박이 없으니 만료');
});

test('종료: clearTurnStatus 뒤에는 심박이 파일을 되살리지 않는다(해제 경합 ×40, 심박 1ms)', async () => {
  _setHeartbeatMsForTest(1);
  const ws = 'hb-clear'; await seed(ws);
  for (let i = 0; i < 40; i++) {
    await setTurnStatus(ws, 'pepper', 'think', '', '', 'chat');
    await sleep(3);
    await clearTurnStatus(ws, 'pepper');
    await sleep(6); // 해제 직후 착지할 수 있는 심박에게 시간을 준다
    assert.equal(existsSync(statusPath(ws, 'pepper')), false, `${i}회차: 종료 뒤 부활 = 거짓 '작성 중'`);
  }
});

test('다른 프로세스가 지운 파일 — 이 프로세스의 턴이 살아 있는 동안만 심박이 되돌리고, 종료(clear)와 함께 확실히 사라진다', async () => {
  // 크루 상태 파일은 크루당 하나라 두 프로세스(상주·사이드카)의 턴이 겹치면 한쪽의 종료가 다른 쪽 파일을 지운다(기존 제약).
  // 심박의 읽고-쓰기 창에서 되살아난 파일은 "이 프로세스의 턴이 진행 중"이라는 사실과 일치하므로 해롭지 않고,
  // 이 턴의 clearTurnStatus가 끝내 지운다 — 영구 유령은 없다.
  _setHeartbeatMsForTest(5);
  const ws = 'hb-gone'; await seed(ws);
  await setTurnStatus(ws, 'jun', 'memory', '', '', 'chat');
  await rm(statusPath(ws, 'jun'), { force: true }); // 다른 프로세스의 종료
  await sleep(40);
  await clearTurnStatus(ws, 'jun');
  await sleep(30);
  assert.equal(existsSync(statusPath(ws, 'jun')), false, '이 턴이 끝난 뒤에는 어떤 심박도 파일을 남기지 않는다');
});

test('직렬화: 심박(읽고 ts 갱신)이 단계 갱신과 엇갈려 옛 단계를 되살리지 않는다(심박 1ms × 60회 교차)', async () => {
  _setHeartbeatMsForTest(1);
  const ws = 'hb-order'; await seed(ws);
  let stale = 0;
  for (let i = 0; i < 60; i++) {
    await setTurnStatus(ws, 'sun', 'memory', 'a', undefined, 'room');
    await setTurnStatus(ws, 'sun', 'write', 'b', `p${i}`, 'room');
    await sleep(2);
    const s = await getTurnStatus(ws, 'sun');
    if (s?.stage !== 'write' || s?.detail !== 'b' || s?.partial !== `p${i}`) stale += 1;
  }
  assert.equal(stale, 0, `옛 스냅샷 부활 ${stale}/60 — 심박과 갱신이 한 체인이 아니면 생긴다`);
  await clearTurnStatus(ws, 'sun');
});

test('회의실 마커(room-main)와의 공존 — 래퍼 하트비트와 상태 파일 심박이 겹쳐도 발언자(detail)가 보존되고 종료 시 함께 꺼진다', async () => {
  _setHeartbeatMsForTest(3);
  const { withRoomTurnStatus, ROOM_TURN_SLUG } = await import('../src/room.mjs');
  const ws = 'hb-room'; await seed(ws);
  let inside;
  await withRoomTurnStatus(ws, async (mark) => {
    await mark('mina|pepper');
    await sleep(40);
    inside = await getTurnStatus(ws, ROOM_TURN_SLUG);
  }, { heartbeatMs: 5 });
  assert.equal(inside?.detail, 'mina|pepper', '두 심박이 서로의 값을 지우지 않는다');
  await sleep(20);
  assert.equal(existsSync(statusPath(ws, ROOM_TURN_SLUG)), false, '종료 뒤 어느 심박도 마커를 되살리지 않는다');
});

test('심박은 내용을 지어내지 않는다 — 파일이 없으면 아무것도 쓰지 않는다(읽고 ts만 앞당기는 계약)', async () => {
  _setHeartbeatMsForTest(50); // 타이머 첫 발화(50ms) 전에 지운다 — 읽고-쓰기 창과 겹치지 않게 결정적으로
  const ws = 'hb-nofab'; await seed(ws);
  await setTurnStatus(ws, 'yun', 'shell', 'ls', '부분', 'chat');
  await rm(statusPath(ws, 'yun'), { force: true });
  await sleep(140); // 심박 2회 이상
  assert.equal(existsSync(statusPath(ws, 'yun')), false, '없는 파일에서 심박이 상태를 창조하면 단계·문장·출처가 조작된 유령 턴이 뜬다');
  await clearTurnStatus(ws, 'yun');
});
