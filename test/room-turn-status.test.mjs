// 회의실 진행 마커 — 유건 실사용 제보(2026-09-02): 안건을 올리고 다른 페이지에 갔다 오면 '회의 중' 표시가
// 사라져 멈춘 것처럼 보였다. 원인 = 표시가 자기 탭의 POST 대기(busy)뿐, 서버 진행 상태를 읽어 복원하는
// 경로 부재. 처방 = 크루 채팅의 상태 파일 계약(turn-status.mjs)을 슬러그 'room-main'으로 재사용 +
// GET /room이 turn을 동봉 + 페이지가 serverBusy로 복원(busy와 분리 — 폴링이 멈추지 않게).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-roomstatus-')); // 워크스페이스 임포트보다 먼저
delete process.env.NEXT_PUBLIC_SUPABASE_URL; // AUTH off — 라우트 실호출이 guardCompany를 지나게(apimsg 테스트 관례)
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));

const { paths } = await import('../src/workspace.mjs');
const { setTurnStatus, clearTurnStatus, getTurnStatus } = await import('../src/turn-status.mjs');
const { withRoomTurnStatus, getRoomTurn, ROOM_TURN_SLUG } = await import('../src/room.mjs');

async function seed(ws) {
  const p = paths(ws);
  await mkdir(p.chats, { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ name: ws, lang: 'ko' }));
  await writeFile(join(p.chats, 'room-main.json'), JSON.stringify({ messages: [{ who: 'user', text: '안건', ts: 1 }], sid: 1 }));
  return p;
}
const statusPath = (ws, slug) => join(paths(ws).chats, `${slug}.status.json`);
const backdate = async (ws, slug, ageMs) => {
  const f = statusPath(ws, slug); const s = JSON.parse(await readFile(f, 'utf8'));
  await writeFile(f, JSON.stringify({ ...s, ts: Date.now() - ageMs }));
};

test('withRoomTurnStatus: 턴 동안 마커가 살아 있고, 끝나면(성공·예외 모두) 해제된다', async () => {
  const ws = 'rs-life'; await seed(ws);
  let during = null;
  const out = await withRoomTurnStatus(ws, async () => { during = await getRoomTurn(ws); return 'ok'; });
  assert.equal(out, 'ok', '반환값 투과');
  assert.deepEqual(during && { active: during.active }, { active: true }, '턴 중에는 진행 중');
  assert.equal(await getRoomTurn(ws), null, '정상 종료 후 해제');
  await assert.rejects(withRoomTurnStatus(ws, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await getRoomTurn(ws), null, '예외로 끝나도 해제 — 남으면 화면이 영구히 회의 중');
});

test('withRoomTurnStatus: 하트비트가 마커를 주기 갱신하고 발언자를 보존한다 — 이벤트 없는 긴 단계에서도 표시 유지', async () => {
  const ws = 'rs-hb'; await seed(ws);
  let inside = null;
  await withRoomTurnStatus(ws, async () => {
    await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper'); // 발언자 갱신(루프가 하는 일)
    await backdate(ws, ROOM_TURN_SLUG, 5 * 60_000);            // 마커를 5분 전으로 — 하트비트가 없으면 낡은 채
    await new Promise((r) => setTimeout(r, 180));               // 하트비트 40ms × 여러 회
    inside = await getTurnStatus(ws, ROOM_TURN_SLUG);           // 기본 2분 창 — 신선해야 통과
  }, { heartbeatMs: 40 });
  assert.ok(inside, '하트비트가 낡은 마커를 되살렸다');
  assert.equal(inside.detail, 'pepper', '하트비트가 발언자(detail)를 지우면 긴 발언 판정의 앵커가 사라진다');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(await getRoomTurn(ws), null, '종료 후 하트비트도 멈춰야 한다(남으면 마커가 되살아나 영구 회의 중)');
});

test('getRoomTurn: 신선한 마커=진행 중, 낡은 마커+신선한 발언자=진행 중(긴 발언), 둘 다 낡음=null, 없음=null', async () => {
  const ws = 'rs-fresh'; await seed(ws);
  assert.equal(await getRoomTurn(ws), null, '마커 없음');
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper');
  assert.deepEqual((({ active, slug }) => ({ active, slug }))(await getRoomTurn(ws)), { active: true, slug: 'pepper' }, '신선한 마커');
  await backdate(ws, ROOM_TURN_SLUG, 5 * 60_000); // 마커만 5분 전
  assert.equal(await getRoomTurn(ws), null, '발언자 상태도 없으면 낡은 마커는 무시(고아 방어)');
  await setTurnStatus(ws, 'pepper', 'runner', 'Claude'); // 발언 크루의 상태 파일은 신선(스트리밍·도구 이벤트마다 갱신)
  assert.equal((await getRoomTurn(ws))?.active, true, '낡은 마커라도 발언자가 살아 있으면 진행 중 — 2분 넘는 발언');
  await backdate(ws, 'pepper', 5 * 60_000);
  assert.equal(await getRoomTurn(ws), null, '둘 다 낡음 = 죽은 턴');
  await backdate(ws, ROOM_TURN_SLUG, 31 * 60_000); await setTurnStatus(ws, 'pepper', 'runner', 'Claude');
  assert.equal(await getRoomTurn(ws), null, '30분 넘은 마커는 발언자가 살아 있어도 무시 — 마커 자체의 상한');
  await clearTurnStatus(ws, 'pepper'); await clearTurnStatus(ws, ROOM_TURN_SLUG);
});

test('GET /api/companies/[ws]/room 은 turn을 동봉한다(실호출) — 없으면 null, 진행 중이면 active', async () => {
  const ws = 'rs-route'; await seed(ws);
  const route = await import('../app/api/companies/[ws]/room/route.js');
  const call = async () => (await route.GET(new Request(`http://127.0.0.1/api/companies/${ws}/room`), { params: Promise.resolve({ ws }) })).json();
  const idle = await call();
  assert.equal(idle.turn, null, '유휴');
  assert.equal(idle.messages?.length, 1, '방 내용은 종전대로');
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper');
  const busy = await call();
  assert.equal(busy.turn?.active, true, '진행 중이면 active — 페이지 복귀 복원의 유일한 원천');
  assert.equal(busy.turn?.slug, 'pepper');
  await clearTurnStatus(ws, ROOM_TURN_SLUG);
});

test('배선: runRoomTurn이 마커 래퍼를 타고, 발언마다 chat() 직전에 발언자를 갱신한다(소스 구간 불변식)', async () => {
  const src = await readFile(new URL('../src/room.mjs', import.meta.url), 'utf8');
  assert.match(src, /export async function runRoomTurn\(wsId, text, attachments = \[\]\) \{\s*\n\s*return withRoomTurnStatus\(wsId, \(\) => runRoomTurnInner\(wsId, text, attachments\)\);/,
    '래퍼를 우회하면 마커가 안 생겨 복원이 죽는다');
  const i0 = src.indexOf('for (const [i, a] of speakers.entries())');
  const loop = src.slice(i0, src.indexOf('r = await chat(wsId, a.slug, prompt', i0));
  assert.match(loop, /setTurnStatus\(wsId, ROOM_TURN_SLUG, 'room', a\.slug\)/, '발언자 갱신이 chat() 앞에 있어야 긴 발언의 신선도 앵커가 된다');
  // 발언 실패가 방에 남는가 — 오류는 POST 탭으로만 가므로 자리를 비운 사장에게 방은 그냥 조용하다(격리 실측: 401 뒤 흔적 0)
  const after = src.slice(src.indexOf('r = await chat(wsId, a.slug, prompt', i0));
  const catchBlk = after.slice(after.indexOf('} catch (e) {'), after.indexOf('} finally {'));
  assert.match(catchBlk, /await sys\('error', en \? `\$\{a\.name\} could not respond: \$\{msg\}` : `\$\{a\.name\} 발언 실패: \$\{msg\}`\)/, '실패 시스템 줄(ko/en)');
  assert.match(catchBlk, /throw e; \/\/ 호출 탭의 오류 표시 계약은 그대로/, '되던 오류 전파를 삼키면 안 된다');
});

test('배선: 회의실 페이지가 turn.active를 serverBusy로 복원하고, 폴링·표시가 busy와 분리돼 있다', async () => {
  const page = await readFile(new URL('../app/c/[ws]/room/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /const \[serverBusy, setServerBusy\] = useState\(false\)/, '서버 진행 상태는 별도 상태');
  // 마운트 로드와 8초 폴링 둘 다 복원 — 한쪽만 있으면 복귀 직후(로드) 또는 이후(폴링) 중 하나가 빠진다
  assert.match(page, /setMessages\(d\.messages \?\? \[\]\); setServerBusy\(!!d\.turn\?\.active\); setError\(''\);/, '마운트 로드에서 복원');
  assert.match(page, /if \(!busy\) api\(`\/api\/companies\/\$\{ws\}\/room`\)\.then\(\(d\) => \{ setMessages\(d\.messages \?\? \[\]\); setServerBusy\(!!d\.turn\?\.active\); \}\)/, '폴링에서 복원(조건은 !busy — serverBusy로 폴링을 멈추면 영구 회의 중)');
  assert.match(page, /\{!viewing && \(busy \|\| serverBusy\) && \(/, '표시는 둘 중 하나면 켜진다');
  assert.doesNotMatch(page, /if \(!busy && !serverBusy\)/, 'serverBusy가 폴링 조건에 들어가면 안 된다');
});
