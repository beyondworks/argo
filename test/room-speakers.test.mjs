// 회의실 발언자 상한 해제 — 이름 멘션 3명 상한(.slice(0, 3)) 폐지(유건 지시 2026-09-02, 회의실 개선 2/6).
// 이름으로 부른 크루는 **전원** 멘션 순서대로 답하고, 2명 이상이면 인원·순서 안내 줄이 방에 남는다(턴 비용 정직 표기).
// 이미지 임베드 캡(IMG_EMBED_MAX=3)은 상한 해제 뒤 이름 멘션 경로에도 실제로 걸린다 — 여기서 함께 잠근다.
// 러너는 chat 스텁(helpers/room-chat-stub.mjs — 리졸브 훅)으로 격리: 파일 배치·크루 목록·방 저장·턴 마커는 실물.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-room-speakers-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // AUTH off(apimsg 관례)
register(new URL('./helpers/room-chat-stub.mjs', import.meta.url));
const stub = await import('./helpers/room-chat-stub.mjs');
const { runRoomTurn, loadRoom, endMeeting, HOP_MAX } = await import('../src/room.mjs');
const { paths } = await import('../src/workspace.mjs');
const { listAgents } = await import('../src/hub.mjs');

const CREW = [['beast', '비스트'], ['wolf', '울프'], ['shuri', '슈리'], ['edna', '에드나'], ['pepper', '페퍼']];
async function seed(ws, { lang = 'ko' } = {}) {
  const p = paths(ws);
  await mkdir(p.chats, { recursive: true }); await mkdir(join(p.root, 'agents'), { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ name: ws, lang }));
  await writeFile(join(p.chats, 'room-main.json'), JSON.stringify({ messages: [], sid: 1 }));
  for (const [slug, name] of CREW) await writeFile(join(p.root, 'agents', `${slug}.md`), `---\nname: ${name}\nrole: 검증\nrunner: claude\n---\n검증용.\n`);
  stub.state.calls.length = 0;
}
const whos = async (ws) => (await loadRoom(ws)).messages.map((m) => m.who);

test('이름 멘션 4명 → 4명 전원이 멘션 순서대로 발언한다(옛 3명 상한 폐지) + 인원·순서 안내 줄', async () => {
  await seed('rs-four');
  const r = await runRoomTurn('rs-four', '@비스트 @울프 @슈리 @에드나 각자 한 줄씩 의견');
  assert.deepEqual(stub.state.calls.map((c) => c.slug), ['beast', 'wolf', 'shuri', 'edna'], '4명 모두 chat() 호출 — 상한이 살아 있으면 3명에서 끊긴다');
  assert.deepEqual(r.replies.map((x) => x.slug), ['beast', 'wolf', 'shuri', 'edna']);
  assert.deepEqual(await whos('rs-four'), ['user', 'system', 'beast', 'wolf', 'shuri', 'edna'], '안건 → 안내 줄 → 발언 4건');
  const note = (await loadRoom('rs-four')).messages[1];
  assert.equal(note.kind, 'speakers');
  assert.equal(note.text, '4명 발언 — 비스트, 울프, 슈리, 에드나 순', '인원과 순서를 사장이 보내는 즉시 본다(턴 비용 정직 표기)');
});

test('@전체는 크루 수만큼(5명) 발언 — 안내 줄도 실제 인원·순서(listAgents 순 = 슬러그순)', async () => {
  await seed('rs-all');
  await runRoomTurn('rs-all', '@전체 각자 한 줄');
  const all = await listAgents('rs-all'); // 전원 호출 순서의 원천(종전과 동일) — 시드 배열 순서가 아니다
  assert.equal(all.length, 5);
  assert.deepEqual(stub.state.calls.map((c) => c.slug), all.map((a) => a.slug));
  assert.equal((await loadRoom('rs-all')).messages[1].text, `5명 발언 — ${all.map((a) => a.name).join(', ')} 순`);
});

test('1명이면 안내 줄이 없다 — 지목 1명·멘션 없음(첫 크루) 모두', async () => {
  await seed('rs-one');
  await runRoomTurn('rs-one', '@울프 확인해줘');
  assert.deepEqual(await whos('rs-one'), ['user', 'wolf']);
  await seed('rs-none');
  await runRoomTurn('rs-none', '다들 어때?');
  assert.deepEqual(await whos('rs-none'), ['user', 'beast'], '멘션 없으면 첫 크루 한 명(종전 규칙)');
});

test('영어 회사는 영어 안내 줄', async () => {
  await seed('rs-en', { lang: 'en' });
  await runRoomTurn('rs-en', '@beast @wolf go');
  assert.equal((await loadRoom('rs-en')).messages[1].text, '2 speak in turn — 비스트, 울프');
});

test('이미지 임베드 캡 — 이름 멘션 4명째부터는 경로 노트(isImage:false)로 받는다(IMG_EMBED_MAX=3)', async () => {
  await seed('rs-img');
  const att = [{ rel: 'files/x.png', name: 'x.png', mime: 'image/png', isImage: true }];
  await runRoomTurn('rs-img', '@비스트 @울프 @슈리 @에드나 이 그림 봐줘', att);
  const flags = stub.state.calls.map((c) => c.opts.attachments.map((a) => a.isImage));
  assert.deepEqual(flags, [[true], [true], [true], [false]], '앞 3명 임베드, 4명째는 경로만 — 상한 해제 전엔 도달 불가였던 갈래');
  assert.equal(stub.state.calls[3].opts.attachments[0].rel, 'files/x.png', '경로 노트는 남는다(Read로 열람)');
});

/* ── 분리 검수 반영(2026-09-02) — 안내 줄이 만든 새 약속·상시화의 뒷면 ── */

test('회의록 참석자에 system이 섞이지 않는다 — 안내 줄이 2명 이상 회의마다 붙어 상시화됐다(검수 MEDIUM-1)', async () => {
  await seed('rs-minutes');
  await runRoomTurn('rs-minutes', '@비스트 @울프 @슈리 @에드나 출시 점검');
  const r = await endMeeting('rs-minutes');
  assert.equal(r.archived, true);
  const md = await readFile(join(paths('rs-minutes').journal, r.journal.replace(/^journal\//, '')), 'utf8');
  assert.match(md, /^참석: 사장, 비스트, 울프, 슈리, 에드나$/m, "참석자는 사람·크루만 — 'system'은 참석자가 아니다");
  assert.match(md, /\*\*system\*\*: 4명 발언 — /, '본문에는 종전 규약대로 남는다(무엇이 지시됐는지의 기록)');
});

test('발언자 실패로 루프가 끊기면 차례가 오지 않은 크루를 밝힌다 — "N명 발언" 약속의 회수(검수 MEDIUM-2)', async () => {
  const ok = stub.state.reply;
  stub.state.reply = (slug) => { if (slug === 'shuri') throw new Error('runner boom'); return `${slug} 답변`; };
  try {
    await seed('rs-fail');
    await assert.rejects(runRoomTurn('rs-fail', '@비스트 @울프 @슈리 @에드나 해줘'), /runner boom/, '호출 탭의 오류 계약은 그대로');
    const msgs = (await loadRoom('rs-fail')).messages;
    assert.deepEqual(msgs.map((m) => m.who), ['user', 'system', 'beast', 'wolf', 'system', 'system']);
    assert.deepEqual(msgs.slice(-2).map((m) => m.kind), ['error', 'skipped'], '실패 안내 다음에 남은 발언자 안내');
    assert.equal(msgs.at(-1).text, '차례가 오지 않은 크루: 에드나 — 다시 부르면 이어갑니다.', '뒷사람만(실패자·이미 말한 사람 제외)');
    await seed('rs-fail-en', { lang: 'en' });
    await assert.rejects(runRoomTurn('rs-fail-en', '@beast @shuri @edna go'));
    assert.equal((await loadRoom('rs-fail-en')).messages.at(-1).text, 'Did not get to: 에드나 — mention them again to continue.');
    await seed('rs-fail-last');
    await assert.rejects(runRoomTurn('rs-fail-last', '@비스트 @슈리 해줘'));
    assert.deepEqual((await loadRoom('rs-fail-last')).messages.map((m) => m.kind ?? m.who), ['user', 'speakers', 'beast', 'error'], '마지막 발언자 실패면 남은 사람 안내 없음');
  } finally { stub.state.reply = ok; }
});

test('릴레이 4단은 연쇄 상한(3명)으로 잘리고 제외자를 밝힌다 + 릴레이에도 인원 안내가 붙는다(검수 LOW-1·LOW-2)', async () => {
  await seed('rs-relay');
  await runRoomTurn('rs-relay', '@비스트 > @울프 > @슈리 > @에드나 이어서 완성');
  assert.deepEqual(stub.state.calls.map((c) => c.slug), ['beast', 'wolf', 'shuri'], `릴레이 상한 HOP_MAX+1=${HOP_MAX + 1}`);
  const msgs = (await loadRoom('rs-relay')).messages;
  assert.deepEqual(msgs.map((m) => m.kind ?? m.who), ['user', 'relay', 'speakers', 'beast', 'wolf', 'shuri']);
  assert.equal(msgs[1].text, `이어받기는 ${HOP_MAX + 1}명까지 — 제외: 에드나`, '잘린 사람을 이름으로 — cc의 제외 안내와 같은 규칙');
  assert.equal(msgs[2].text, '3명 발언 — 비스트, 울프, 슈리 순', '릴레이 경로에도 인원 안내(!isRelay 변이가 초록이던 구멍)');
});

test('cc가 함께 있으면 참조 안내가 먼저, 인원 안내가 그다음 — 발언 시작 전 순서 고정(검수 LOW-3)', async () => {
  await seed('rs-cc');
  await runRoomTurn('rs-cc', '@비스트 @울프 정리해줘 cc @슈리');
  const msgs = (await loadRoom('rs-cc')).messages;
  assert.deepEqual(msgs.map((m) => m.kind ?? m.who), ['user', 'cc', 'speakers', 'beast', 'wolf']);
  assert.match(msgs[2].text, /^2명 발언 — 비스트, 울프 순$/, '참조받은 슈리는 발언 인원에 들지 않는다');
});

test('재등장 금지 — 발언자 결정에 상한 slice가 없고, 입력창 안내에 "최대 N명" 문구가 없다', async () => {
  const room = await readFile(new URL('../src/room.mjs', import.meta.url), 'utf8');
  const i = room.indexOf('const speakers = dir.relay.length');
  assert.ok(i > 0, '발언자 결정 앵커');
  assert.doesNotMatch(room.slice(i, room.indexOf(';', i)), /slice\(/, '발언자 결정에 상한 재등장 금지(HOP_MAX 릴레이 상한은 파서 몫)');
  const line = (await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8')).split('\n').find((l) => l.includes("'room.placeholder'"));
  assert.ok(line, 'room.placeholder 사전 줄');
  assert.doesNotMatch(line, /최대|up to \d/, '입력창 안내가 사라진 상한을 말하면 안 된다');
});
