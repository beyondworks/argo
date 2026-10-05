// M1(2026-10-05 분리 검수): 크루 예약 도구로 만든 데스크톱 루틴(routines.mjs source:'routine', notOwnerDirect: r0.from)의 턴 이벤트에 출처가 안 남았다.
// chat.mjs evFrom이 from·crewmail만 적고 notOwnerDirect는 적지 않아, 활동 화면 rerunMode가 'rerun'을 돌려 '다시 실행'이 옛 문장을
// 사장 직접 턴으로 보냈다(풀 오토 조건 chat.mjs `!from && !notOwnerDirect` 통과 — 다른 크루가 건 예약이 사장 권한으로 승격).
// 잠그는 행동: 실제 루틴 실행(runRoutine → 실제 chat() → 가짜 모델 엔드포인트) 뒤 실제 이벤트 기록(events.jsonl)을 읽어
//   ① notOwnerDirect가 별도 키로 기록된다(from과 섞지 않는다 — from은 활동 행 표시·rerunMode의 '다른 크루가 건 턴' 판정에 따로 쓰인다)
//   ② 그 이벤트를 rerunMode에 넣으면 'none' ③ 대조군: 사장이 만든 루틴은 표지 없이 'rerun' 그대로.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-rtn-origin-'));
const home = await mkdtemp(join(tmpdir(), 'argo-rtn-origin-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const textReply = (res, text) => sse(res, [
  ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => (req.method === 'POST' && req.url.startsWith('/v1/messages') ? textReply(res, 'done') : (res.writeHead(200, { 'content-type': 'application/json' }), res.end('{}')))); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { addRoutine, runRoutine } = await import('../src/routines.mjs');
const { readEvents } = await import('../src/events.mjs');
const { rerunMode } = await import('../app/c/[ws]/activity/rerun.mjs');

const ws = 'rtn-origin';
await createCompany(ws, '루틴 출처 검수', 'owner', null, 'ko');
await mkdir(paths(ws).agents, { recursive: true });
for (const [slug, name] of [['a', '알파'], ['b', '브라보']]) await writeFile(join(paths(ws).agents, `${slug}.md`), `---\nname: ${name}\nrole: 검증\nrunner: claude\n---\n페르소나.\n`);
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다

const turnEvent = async (marker) => (await readEvents(ws)).find((e) => e.type === 'turn' && e.source === 'routine' && String(e.msg ?? '').includes(marker));

test('다른 크루(b)가 예약 도구로 건 루틴의 턴 이벤트는 notOwnerDirect를 기록하고, 활동 화면은 다시 실행을 숨긴다', async () => {
  const r = await addRoutine(ws, { agentSlug: 'a', title: '크루가 건 예약', prompt: 'MARK-FROM-CREW 점검하라', schedule: { type: 'daily', time: '09:00' }, from: 'b' });
  await runRoutine(ws, r.id, { chatFn: chat });
  const ev = await turnEvent('MARK-FROM-CREW');
  assert.ok(ev, '턴 이벤트가 기록됐다');
  assert.ok(ev.msg, '재실행 원천(msg)이 있는 이벤트여야 이 테스트가 의미 있다 — msg가 없으면 rerunMode는 원래 none');
  assert.equal(ev.notOwnerDirect, 'b', '누가 걸었는지가 별도 키로 남는다');
  assert.equal(ev.from, undefined, 'from과 섞지 않는다 — 활동 행의 "A → B" 표시와 위임 판정이 그대로다');
  assert.equal('ownerDirect' in ev, false, '크루가 건 턴에는 사장 직접 턴 표지가 없다(2차 검수 LOW-2)');
  assert.equal(rerunMode(ev), 'none', '사장 직접 턴이 아니므로 다시 실행 버튼을 숨긴다');
});

test('대조군 — 사장이 만든 루틴(출처 없음)은 표지 없이 기록되고 다시 실행이 보인다', async () => {
  const r = await addRoutine(ws, { agentSlug: 'a', title: '사장이 건 예약', prompt: 'MARK-FROM-OWNER 점검하라', schedule: { type: 'daily', time: '09:00' } });
  await runRoutine(ws, r.id, { chatFn: chat });
  const ev = await turnEvent('MARK-FROM-OWNER');
  assert.ok(ev?.msg);
  assert.equal('notOwnerDirect' in ev, false);
  assert.equal(ev.ownerDirect, true, '사장이 건 턴은 사장 직접 턴 표지를 적극 기록한다 — rerunMode가 이 표지로만 다시 실행을 보인다(2차 검수 LOW-2)');
  assert.equal(rerunMode(ev), 'rerun');
  const { ownerDirect: _drop, ...legacy } = ev; // 표지가 생기기 전에 기록된 옛 이벤트
  assert.equal(rerunMode(legacy), 'none', '옛 이벤트는 사장 직접 턴임을 증명할 수 없어 숨긴다');
});

test('결재 후속 턴(source 기본 deck + notOwnerDirect)은 표지가 없고, 사장 1:1 턴은 표지가 있다 — 실제 chat() 이벤트(2차 검수 LOW-2)', async () => {
  await chat(ws, 'a', 'MARK-DECK-OWNER 안녕', null, {}); // 데크 1:1 — 사장 직접 턴
  await chat(ws, 'a', 'MARK-DECK-APPROVAL 후속', null, { notOwnerDirect: 'b' }); // approval-actions.mjs:130이 크루가 올린 결재의 후속으로 부르는 모양
  const find = async (m) => (await readEvents(ws)).find((e) => e.type === 'turn' && String(e.msg ?? '').includes(m));
  const owner = await find('MARK-DECK-OWNER'); const approval = await find('MARK-DECK-APPROVAL');
  assert.ok(owner?.msg && approval?.msg, '두 이벤트가 재실행 원천(msg)을 가진다');
  assert.equal(owner.source, 'deck'); assert.equal(approval.source, 'deck');
  assert.equal(owner.ownerDirect, true); assert.equal(rerunMode(owner), 'rerun');
  assert.equal('ownerDirect' in approval, false); assert.equal(approval.notOwnerDirect, 'b');
  assert.equal(rerunMode(approval), 'none');
});

test('rerunMode — notOwnerDirect가 있으면 어떤 출처든 none(메신저는 그대로 안내)', () => {
  const t = (extra) => ({ type: 'turn', slug: 'a', msg: '문장', ...extra });
  for (const source of ['deck', 'routine', 'trial', 'room']) assert.equal(rerunMode(t({ source, notOwnerDirect: 'b' })), 'none', source);
  assert.equal(rerunMode(t({ source: 'crewmail', fromRole: 'captain', notOwnerDirect: 'b' })), 'none');
  assert.equal(rerunMode(t({ source: 'messenger', notOwnerDirect: 'b' })), 'messenger', '메신저 턴은 메신저에서 다시 보내라는 안내가 먼저다');
  assert.equal(rerunMode(t({ source: 'routine', ownerDirect: true })), 'rerun');
});

// 3차 검수 F2(2026-10-05): ownerDirect 표지 조건이 `!from && !notOwnerDirect`뿐이라 풀 오토를 거르는 손님·오피스·크루 넘김 메신저 턴에도 '사장 직접 턴'이 기록됐다.
// 풀 오토 판정과 표지는 msgr-handoff ownerDirectTurn 한 함수만 본다 — 실제 chat() 이벤트로 잠근다.
test('메신저 손님·오피스·크루 넘김 턴에는 사장 직접 턴 표지가 없고, 주인 본인의 메신저 턴·메신저 밖 턴에는 있다 — 실제 chat() 이벤트(3차 F2)', async () => {
  const msgr = (extra) => ({ source: 'messenger', journal: { off: true }, mirrorCtx: { kind: 'msgr', channelKind: 'dm', channelId: 'ch-f2', threadRoot: 't-f2', uid: 'owner', origin: 'owner', peers: [], ...extra } });
  await chat(ws, 'a', 'MARK-F2-GUEST 안녕', null, msgr({ origin: 'guest-b' })); // 크루 주인이 아닌 사람이 시킴 = 손님
  await chat(ws, 'a', 'MARK-F2-OFFICE 안녕', null, msgr({ office: true })); // 오피스에서 맡긴 턴
  await chat(ws, 'a', 'MARK-F2-HANDOFF 안녕', null, msgr({ handoffFrom: 'b' })); // 크루가 스스로 넘긴 턴
  await chat(ws, 'a', 'MARK-F2-OWNER 안녕', null, msgr({})); // 주인 본인
  const find = async (m) => (await readEvents(ws)).find((e) => e.type === 'turn' && String(e.msg ?? '').includes(m));
  for (const m of ['MARK-F2-GUEST', 'MARK-F2-OFFICE', 'MARK-F2-HANDOFF']) {
    const ev = await find(m);
    assert.ok(ev, `${m} 턴 이벤트가 기록됐다`);
    assert.equal('ownerDirect' in ev, false, `${m}: 풀 오토를 거르는 턴은 사장 직접 턴 표지가 없다`);
  }
  const owner = await find('MARK-F2-OWNER');
  assert.equal(owner?.ownerDirect, true, '주인 본인의 메신저 턴은 표지가 있다(풀 오토 판정과 같은 조건)');
  assert.equal(rerunMode(owner), 'messenger', '메신저 출처는 rerunMode가 먼저 걸러 다시 실행 버튼이 안 생긴다(기존 동작 그대로)');
});
