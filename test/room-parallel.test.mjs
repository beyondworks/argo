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
const { runRoomTurn, loadRoom, getRoomTurn, runLimited, ROOM_CONCURRENCY, NO_ADD_RE } = await import('../src/room.mjs');
const { setTurnStatus, clearTurnStatus } = await import('../src/turn-status.mjs');
const { appendUsage } = await import('../src/usage.mjs');
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

// ── 분리 검수 반영(2026-09-07) — 실측으로 잡힌 결함들의 회귀 핀 ──

test('HIGH-2: 반응 라운드 프롬프트는 인원에서 창을 넓히고 안건을 선두에 고정한다 — 22명 회의에서 안건·1라운드 발언 전부', async () => {
  // 실측(검수 HIGH-2): 트랜스크립트 창이 20 고정이면 22명 회의의 2라운드 프롬프트에 **안건이 없고** 1라운드 발언도 20/22만 실렸다.
  // 위임 미러(방 메시지)까지 쌓이면 12명대에서도 같은 일이 난다. 창은 인원에서 파생하고 안건은 선두 고정.
  const ws = 'rp-window';
  const { paths } = await import('../src/workspace.mjs');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const p2 = paths(ws);
  await mkdir(p2.chats, { recursive: true }); await mkdir(join(p2.root, 'agents'), { recursive: true });
  await writeFile(join(p2.root, 'company.json'), JSON.stringify({ name: ws, lang: 'ko' }));
  await writeFile(join(p2.chats, 'room-main.json'), JSON.stringify({ messages: [], sid: 1 }));
  for (let i = 0; i < 22; i++) await writeFile(join(p2.root, 'agents', `c${String(i).padStart(2, '0')}.md`), `---\nname: 크루${i}\nrole: 검증\nrunner: claude\n---\n검증용.\n`);
  stub.state.calls.length = 0; stub.state.delayMs = 0; stub.state.reply = (slug) => `${slug} 답변`;
  await runRoomTurn(ws, '@전체 이번 분기 목표를 정하자');
  const second = stub.state.calls.filter((c) => /## 지시 — 반응 라운드/.test(c.prompt));
  assert.equal(second.length, 22, '반응 라운드 22명');
  for (const c of second) {
    assert.match(c.prompt, /사장: @전체 이번 분기 목표를 정하자/, '안건이 반응 라운드 프롬프트에 있다 — 없으면 무엇에 반응하는지 모른다');
    for (const n of ['c00', 'c10', 'c21']) assert.ok(c.prompt.includes(`${n} 답변`), `1라운드 발언 전부(누락: ${n})`);
  }
});

test('MEDIUM-2: 반응 라운드는 첨부를 다시 보내지 않는다 — 이미지 토큰이 인원×2로 곱해지던 것', async () => {
  await seed('rp-att2');
  const att = [{ rel: 'files/x.png', name: 'x.png', mime: 'image/png', isImage: true }];
  await runRoomTurn('rp-att2', '@비스트 @울프 이 그림 봐줘', att);
  const [r1a, r1b, r2a, r2b] = stub.state.calls.map((c) => c.opts.attachments);
  assert.equal(r1a.length, 1); assert.equal(r1b.length, 1);
  assert.deepEqual(r2a, []); assert.deepEqual(r2b, [], '2라운드 첨부 없음 — 경로는 1라운드 트랜스크립트에 실려 있다');
});

test('MEDIUM-1: 월 지출 한도를 넘었으면 반응 라운드를 접고 방에 남긴다(동시 발언은 한도를 초과 집행할 수 있다)', async () => {
  await seed('rp-budget');
  const { paths } = await import('../src/workspace.mjs');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(paths('rp-budget').root, 'company.json'), JSON.stringify({ name: 'rp-budget', lang: 'ko', budgetUsd: 1 }));
  await appendUsage('rp-budget', { kind: 'chat', slug: 'beast', runner: 'claude', model: 'm', usage: {}, costUsd: 5, ms: 10, billed: true });
  await runRoomTurn('rp-budget', '@비스트 @울프 검토');
  const msgs = (await loadRoom('rp-budget')).messages;
  assert.equal(msgs.filter((m) => m.round === 2).length, 0, '반응 라운드 미실행');
  assert.equal(msgs.at(-1).text, '반응 라운드 생략 — 월 지출 한도에 도달했습니다.');
});

test('LOW: 반응 라운드의 "추가 의견 없음"은 noAdd 표식으로 접힌다(ko·en 동의어), 판정은 정확 일치', async () => {
  await seed('rp-noadd');
  stub.state.reply = (slug) => (slug === 'wolf' ? '추가 의견 없음' : `${slug} 답변`);
  await runRoomTurn('rp-noadd', '@비스트 @울프 검토');
  const r2 = (await loadRoom('rp-noadd')).messages.filter((m) => m.round === 2);
  assert.equal(r2.find((m) => m.who === 'wolf')?.noAdd, true);
  assert.equal(r2.find((m) => m.who === 'beast')?.noAdd, undefined, '실제 의견은 접지 않는다');
  assert.ok(NO_ADD_RE.test('Nothing to add.') && NO_ADD_RE.test('no further comment'), '영어 회사');
  assert.ok(!NO_ADD_RE.test('추가 의견 없음이라고 보기는 어렵고, 한 가지 보탠다'), '문장 속 인용은 접지 않는다');
});

test('R1(검수 미탐): v2 출처 게이트 — 발언 크루의 상태가 source!==room이면 채택하지 않는다(개인 채팅·위임 문장이 발언 카드에 뜨지 않게)', async () => {
  await seed('rp-gate'); stub.state.delayMs = 400;
  const p = runRoomTurn('rp-gate', '@비스트 @울프 검토', [], { rounds: 1 });
  let mid = null;
  for (let i = 0; i < 80 && !(mid?.speakers?.some((s) => s.state === 'speaking')); i++) { await new Promise((r) => setTimeout(r, 10)); mid = await getRoomTurn('rp-gate'); }
  await setTurnStatus('rp-gate', 'beast', 'write', 'other.md', '남의 개인 채팅 문장', 'chat'); // 같은 크루의 다른 턴
  const t = await getRoomTurn('rp-gate');
  const beast = t.speakers.find((s) => s.slug === 'beast');
  assert.equal(beast.partial, '', `출처 미상·타 출처는 비채택 — 실제로 실린 값: ${beast.partial}`);
  assert.equal(beast.stage, null);
  await p;
});

test('R3(검수 미탐): 마커 done이 완료 수를 싣는다 — 헤더 "n/N명 발언 완료"의 유일한 근거', async () => {
  await seed('rp-done'); stub.state.delayMs = 250;
  const p = runRoomTurn('rp-done', '@비스트 @울프 @슈리 @에드나 검토', [], { rounds: 1, concurrency: 1 });
  let seen = -1;
  for (let i = 0; i < 200; i++) {
    const t = await getRoomTurn('rp-done');
    if (t?.done > 0) { seen = t.done; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(seen >= 1, `진행 중 done이 올라가야 한다(관측: ${seen}) — 안 올라가면 헤더가 영원히 0/N`);
  await p;
});

test('R4(검수 미탐): 위임 미러 컨텍스트가 라운드별로 갈린다 — 1라운드 위임이 2라운드 발언에 다시 붙지 않는다', async () => {
  await seed('rp-mirror');
  await runRoomTurn('rp-mirror', '@비스트 @울프 검토');
  const ctxs = stub.state.calls.map((c) => c.opts.mirrorCtx.room);
  assert.equal(new Set(ctxs).size, ctxs.length, `발언마다 유일해야 한다: ${ctxs.join(' / ')}`);
  const [a1, , a2] = ctxs; // 같은 크루(비스트)의 1·2라운드
  assert.notEqual(a1, a2, '같은 크루의 라운드 간 컨텍스트가 같으면 1라운드 위임이 2라운드에 다시 미러된다');
});

test('상한 클램프 — ARGO_ROOM_CONCURRENCY는 1~16(=0이면 기본 8, =100이면 16)', async () => {
  assert.ok(ROOM_CONCURRENCY >= 1 && ROOM_CONCURRENCY <= 16);
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/room.mjs', import.meta.url), 'utf8');
  assert.match(src, /Math\.min\(16, Math\.max\(1, Number\(process\.env\.ARGO_ROOM_CONCURRENCY\) \|\| 8\)\)/, '클램프 — 100이면 프로세스 100개');
});
