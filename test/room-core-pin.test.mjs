// 데스크톱 회의실 핀 — 회의 실행기를 저장소·참여자 주입으로 나누기(메신저 v2 회의방, A+ P3) **전에** 지금 동작을 고정한다.
// 나누는 동안 바뀌면 안 되는 것만 본다: chat() 호출 옵션의 모양(위임 단계·중단 표지가 새로 끼지 않는다), 방 기록의 순서·모양,
// 개인 스레드 기록, 회의방 상한이 데스크톱에 번지지 않는 것(5명 넘는 @전체·풀린 방 4라운드).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-room-pin-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
register(new URL('./helpers/room-chat-stub.mjs', import.meta.url));
const stub = await import('./helpers/room-chat-stub.mjs');
const { runRoomTurn, loadRoom, setRoomDelegationLimit } = await import('../src/room.mjs');
const { loadThread } = await import('../src/thread.mjs');
const { paths } = await import('../src/workspace.mjs');

const CREW = [['a1', '에이'], ['b2', '비'], ['c3', '씨'], ['d4', '디'], ['e5', '이'], ['f6', '에프'], ['g7', '지']];
async function seed(ws) {
  const p = paths(ws);
  await mkdir(p.chats, { recursive: true }); await mkdir(join(p.root, 'agents'), { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ name: ws, lang: 'ko' }));
  await writeFile(join(p.chats, 'room-main.json'), JSON.stringify({ messages: [], sid: 3 }));
  for (const [slug, name] of CREW) await writeFile(join(p.root, 'agents', `${slug}.md`), `---\nname: ${name}\nrole: 검증\nrunner: claude\n---\n검증용.\n`);
  stub.state.calls.length = 0; stub.state.delayMs = 0; stub.state.holdUntil = 0; stub.state.gate = null; stub.state.inflight = 0; stub.state.maxInflight = 0; stub.state.reply = (slug) => `${slug} 답변`;
}

test('핀: 데스크톱 발언의 chat() 옵션 모양 — source room, 위임 단계(hop)·중단 표지(abortTag) 없음, mirrorCtx.room = 턴:발언자:순번:라운드', async () => {
  await seed('pin-opts');
  await runRoomTurn('pin-opts', '@에이 @비 검토', [], { rounds: 1 });
  assert.equal(stub.state.calls.length, 2);
  for (const c of stub.state.calls) {
    assert.deepEqual(Object.keys(c.opts).sort(), ['attachments', 'delegationRelaxed', 'delegationTree', 'mirrorCtx', 'source', 'workFolder'], '옵션 키가 늘거나 줄면 데스크톱 회의실 동작이 바뀐다');
    assert.equal(c.opts.source, 'room');
    assert.equal(c.opts.delegationRelaxed, false);
    assert.equal(c.opts.delegationTree, null);
    assert.match(c.opts.mirrorCtx.room, new RegExp(`^3-[a-z0-9]+:${c.slug}:\\d:1$`), 'sid-턴id:발언자:순번:라운드');
  }
});

test('핀: 동시 2라운드 방 기록 순서·모양 + 개인 스레드 기록(via room)', async () => {
  await seed('pin-r2');
  const r = await runRoomTurn('pin-r2', '@에이 @비 @씨 검토');
  const msgs = (await loadRoom('pin-r2')).messages;
  assert.equal(msgs.length, 9, '안건·안내·답 3·라운드 안내·답 3');
  assert.deepEqual(msgs.slice(0, 2).map((m) => m.kind ?? m.who), ['user', 'speakers']);
  assert.deepEqual(new Set(msgs.slice(2, 5).map((m) => m.who)), new Set(['a1', 'b2', 'c3']));
  assert.equal(msgs[5].kind, 'round');
  assert.deepEqual(new Set(msgs.slice(6).map((m) => m.who)), new Set(['a1', 'b2', 'c3']));
  assert.ok(msgs.slice(6).every((m) => m.round === 2), '반응 라운드 표지');
  assert.ok(msgs.slice(2, 5).every((m) => !('round' in m)), '1라운드는 필드 없음');
  assert.equal(r.replies.length, 6, '답 6건(3명 × 2라운드)');
  const th = await loadThread('pin-r2', 'a1');
  assert.equal(th.messages.filter((m) => m.who === 'crew').length, 2, '개인 스레드에 두 라운드 모두 기록');
});

test('핀: 데스크톱 @전체는 인원 상한이 없다(7명 전원) — 회의방 상한 S≤5가 데스크톱에 번지지 않는다', async () => {
  await seed('pin-all');
  await runRoomTurn('pin-all', '@전체 의견', [], { rounds: 1 });
  assert.equal(new Set(stub.state.calls.map((c) => c.slug)).size, 7);
});

test('핀: 데스크톱 풀린 방은 보탤 말이 있는 한 4라운드까지 — 회의방의 라운드 2 고정이 데스크톱에 번지지 않는다', async () => {
  await seed('pin-relaxed');
  await setRoomDelegationLimit('pin-relaxed', false);
  await runRoomTurn('pin-relaxed', '@에이 @비 토론');
  const rounds = new Set(stub.state.calls.map((c) => Number(c.opts.mirrorCtx.room.split(':').at(-1))));
  assert.deepEqual([...rounds].sort(), [1, 2, 3, 4]);
  assert.ok(stub.state.calls.every((c) => c.opts.delegationRelaxed === true && c.opts.delegationTree), '풀린 방은 합계 예산을 같이 넘긴다');
});

test('핀: 릴레이·cc·loop 지시는 종전대로 방에서 처리된다', async () => {
  await seed('pin-relay');
  await runRoomTurn('pin-relay', '@에이 > @비 이어서');
  assert.deepEqual((await loadRoom('pin-relay')).messages.map((m) => m.kind ?? m.who), ['user', 'speakers', 'a1', 'b2']);
  await seed('pin-cc');
  await runRoomTurn('pin-cc', 'cc @씨 공유만');
  assert.deepEqual((await loadRoom('pin-cc')).messages.map((m) => m.kind ?? m.who), ['user', 'cc']);
  assert.equal(stub.state.calls.length, 0, '참조만이면 발언 없음');
});
