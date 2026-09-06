// 회의실 동시 발언 + 반응 라운드 (유건 결정 2026-09-06: 12명 순차 15~30분 → 릴레이가 아니면 동시, 잃어버리는 "듣고 말하기"는
// 반응 라운드로). 러너는 chat 스텁(helpers/room-chat-stub.mjs — 지연·동시 진행 수 기록)으로 격리.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-room-par-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
register(new URL('./helpers/room-chat-stub.mjs', import.meta.url));
const stub = await import('./helpers/room-chat-stub.mjs');
const { runRoomTurn, loadRoom, getRoomTurn, runLimited, ROOM_CONCURRENCY } = await import('../src/room.mjs');
const { paths } = await import('../src/workspace.mjs');

const CREW = [['beast', '비스트'], ['wolf', '울프'], ['shuri', '슈리'], ['edna', '에드나']];
async function seed(ws, { lang = 'ko' } = {}) {
  const p = paths(ws);
  await mkdir(p.chats, { recursive: true }); await mkdir(join(p.root, 'agents'), { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ name: ws, lang }));
  await writeFile(join(p.chats, 'room-main.json'), JSON.stringify({ messages: [], sid: 1 }));
  for (const [slug, name] of CREW) await writeFile(join(p.root, 'agents', `${slug}.md`), `---\nname: ${name}\nrole: 검증\nrunner: claude\n---\n검증용.\n`);
  stub.state.calls.length = 0; stub.state.delayMs = 0; stub.state.inflight = 0; stub.state.maxInflight = 0; stub.state.reply = (slug) => `${slug} 답변`;
}
const kinds = async (ws) => (await loadRoom(ws)).messages.map((m) => m.kind ?? m.who);

test('이름 멘션 4명은 동시에 시작한다 — 총 소요가 발언 1건 수준(순차면 4배), 동시 진행 ≥2', async () => {
  await seed('rp-par'); stub.state.delayMs = 300; // 부하 아래에서도 4명이 겹치도록 넉넉히 — 판정은 동시 진행 수(벽시계 아님)
  await runRoomTurn('rp-par', '@비스트 @울프 @슈리 @에드나 각자 의견', [], { rounds: 1 });
  assert.ok(stub.state.maxInflight >= 2, `동시 진행 최대 ${stub.state.maxInflight} — 순차면 1`);
  assert.deepEqual(new Set(stub.state.calls.map((c) => c.slug)), new Set(['beast', 'wolf', 'shuri', 'edna']), '전원 발언');
  assert.equal((await loadRoom('rp-par')).messages.filter((m) => !m.kind).length - 1, 4, '답변 4건(안건 제외)');
});

test('동시 상한 — concurrency 2면 동시 진행이 2를 넘지 않고, 4명은 두 묶음으로 돈다', async () => {
  await seed('rp-cap'); stub.state.delayMs = 150;
  await runRoomTurn('rp-cap', '@전체 의견', [], { rounds: 1, concurrency: 2 });
  assert.equal(stub.state.maxInflight, 2, '상한 초과 = Claude 러너 CLI 프로세스 폭주 / 1이면 동시가 아니다');
  assert.ok(ROOM_CONCURRENCY >= 1);
});

test('릴레이(@A > @B)는 그대로 순차 — 동시 진행 1, 앞사람 답이 뒷사람 프롬프트에 있다', async () => {
  await seed('rp-relay'); stub.state.delayMs = 20;
  await runRoomTurn('rp-relay', '@비스트 > @울프 이어서');
  assert.equal(stub.state.maxInflight, 1, '릴레이는 이어받기 계약 — 동시면 앞사람 답을 못 본다');
  assert.match(stub.state.calls[1].prompt, /비스트: beast 답변/, '뒷사람 프롬프트에 앞사람 답');
  assert.match(stub.state.calls[1].prompt, /이어받기\(릴레이\)/);
  assert.deepEqual(await kinds('rp-relay'), ['user', 'speakers', 'beast', 'wolf'], '릴레이엔 반응 라운드 없음');
});

test('반응 라운드(기본) — 1라운드 뒤 라운드 안내 줄, 전원이 1라운드 발언을 읽고 다시 답한다(round:2 표시)', async () => {
  await seed('rp-r2');
  await runRoomTurn('rp-r2', '@비스트 @울프 @슈리 검토');
  const msgs = (await loadRoom('rp-r2')).messages;
  assert.deepEqual(msgs.map((m) => m.kind ?? m.who).slice(0, 2), ['user', 'speakers']);
  assert.equal(msgs[1].text, '3명 동시 발언 — 비스트, 울프, 슈리 · 이어서 반응 라운드');
  const roundIdx = msgs.findIndex((m) => m.kind === 'round');
  assert.ok(roundIdx > 0, '반응 라운드 안내 줄');
  assert.equal(msgs[roundIdx].text, '반응 라운드 — 1라운드 발언에 서로 답합니다.');
  const r1 = msgs.slice(2, roundIdx), r2 = msgs.slice(roundIdx + 1);
  assert.equal(r1.length, 3); assert.equal(r2.length, 3);
  assert.ok(r1.every((m) => !m.round) && r2.every((m) => m.round === 2), '2라운드 발언만 round:2 — 화면이 "반응"으로 구분');
  assert.equal(stub.state.calls.length, 6, '발언 3 + 반응 3');
  const second = stub.state.calls.slice(3);
  for (const c of second) {
    assert.match(c.prompt, /## 지시 — 반응 라운드/);
    assert.match(c.prompt, /비스트: beast 답변[\s\S]*울프: wolf 답변[\s\S]*슈리: shuri 답변/, '2라운드 프롬프트에 1라운드 발언 전부');
  }
  assert.match(stub.state.calls[0].prompt, /동료 2명이 \*\*같은 안건에 동시에\*\* 답하고 있다/, '1라운드 프롬프트가 동시 발언임을 알린다');
});

test('rounds:1이면 반응 라운드 없이 끝난다(입력창 "1라운드만")', async () => {
  await seed('rp-r1');
  await runRoomTurn('rp-r1', '@비스트 @울프 검토', [], { rounds: 1 });
  assert.deepEqual(await kinds('rp-r1'), ['user', 'speakers', 'beast', 'wolf']);
  assert.equal((await loadRoom('rp-r1')).messages[1].text, '2명 동시 발언 — 비스트, 울프');
});

test('일부 실패 — 나머지는 계속 답하고 실패는 줄로 남으며 던지지 않는다; 전원 실패만 던진다', async () => {
  await seed('rp-fail');
  stub.state.reply = (slug) => { if (slug === 'wolf') throw new Error('runner boom'); return `${slug} 답변`; };
  const r = await runRoomTurn('rp-fail', '@비스트 @울프 @슈리 검토', [], { rounds: 1 });
  assert.deepEqual(new Set(r.replies.map((x) => x.slug)), new Set(['beast', 'shuri']), '실패자 빼고 답변');
  const msgs = (await loadRoom('rp-fail')).messages;
  const err = msgs.find((m) => m.kind === 'error');
  assert.ok(err && /울프 발언 실패: runner boom/.test(err.text), '실패 줄');
  assert.ok(!msgs.some((m) => m.kind === 'skipped'), '동시 발언엔 "차례가 오지 않은 크루"가 없다');
  await seed('rp-fail-all');
  stub.state.reply = () => { throw new Error('all down'); };
  await assert.rejects(runRoomTurn('rp-fail-all', '@비스트 @울프 검토', [], { rounds: 1 }), /all down/, '전원 실패는 호출 탭 오류 계약');
});

test('마커 v2 — 진행 중 getRoomTurn이 발언자별 상태(speaking/queued/done)·라운드·인원을 싣고, 끝나면 null', async () => {
  await seed('rp-marker'); stub.state.delayMs = 600;
  const p = runRoomTurn('rp-marker', '@비스트 @울프 @슈리 @에드나 검토', [], { rounds: 1, concurrency: 2 });
  // 폴링형 — 부하 아래 고정 지연 샘플은 흔들린다. 두 명이 발언 중이 될 때까지 기다린다(상한 600ms 안).
  let mid = null;
  for (let i = 0; i < 60 && !(mid?.speakers?.filter((s) => s.state === 'speaking').length === 2); i++) { await new Promise((r) => setTimeout(r, 10)); mid = await getRoomTurn('rp-marker'); }
  assert.equal(mid?.v, 2); assert.equal(mid.total, 4); assert.equal(mid.round, 1); assert.equal(mid.rounds, 1);
  const states = Object.fromEntries(mid.speakers.map((s) => [s.slug, s.state]));
  assert.deepEqual(states, { beast: 'speaking', wolf: 'speaking', shuri: 'queued', edna: 'queued' }, '상한 2 — 둘은 발언 중, 둘은 대기');
  assert.equal(mid.done, 0); assert.equal(mid.slug, 'beast', '구형 소비자용 slug = 첫 발언 중');
  await p;
  assert.equal(await getRoomTurn('rp-marker'), null, '종료 후 마커 소멸');
});

test('runLimited — 순서대로 착수, 실패는 {ok:false}로 정착(나머지 계속), 상한 1이면 순차', async () => {
  const seen = [];
  const out = await runLimited([1, 2, 3], 1, async (x) => { seen.push(x); if (x === 2) throw new Error('two'); return x * 10; });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(out.map((r) => (r.ok ? r.v : String(r.e.message))), [10, 'two', 30]);
});

test('배선: 라우트가 body.rounds(1)를 runRoomTurn 옵션으로 넘기고 그 외는 2', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../app/api/companies/[ws]/room/route.js', import.meta.url), 'utf8');
  assert.match(src, /const rounds = rawRounds === 1 \|\| rawRounds === '1' \? 1 : 2;/, '기본 2(반응 라운드 켜짐) — 유건 결정');
  assert.match(src, /runRoomTurn\(ws, message\.trim\(\), attachments, \{ rounds \}\)/);
});
