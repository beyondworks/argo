// 에이전트 기억 회수(유건 결정 2026-10-03 — "에이전트는 한 사람, 채널·조직에서 빠지면 그 기억은 회수").
// 서버가 "이 에이전트는 이 채널에 없다"고 명시한 채널만 지운다 — 조회 실패에 기억을 잃는 쪽이 더 큰 사고다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-recall-'));
const { paths } = await import('../src/workspace.mjs');
const { forgetChannels, applyDeparted } = await import('../src/departed.mjs');
const { mergeThread } = await import('../src/sync.mjs');
const { recallDeparted } = await import('../src/gateway/msgr-recall.mjs');

const OUT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // 빠진 채널
const IN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';  // 남아 있는 채널
const SESS_OUT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SESS_IN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ch = (id, kind = 'msgr') => ({ kind, channelId: id });
const thread = () => ({
  sessionId: 'global-1',
  messages: [
    { who: 'user', text: '데스크톱 지시', ts: 1 },
    { who: 'user', text: '조직 채널 질문', ts: 2, contextScope: ch(OUT) },
    { who: 'crew', text: '조직 채널 답(기밀)', ts: 3, contextScope: ch(OUT) },
    { who: 'user', text: '조직 DM', ts: 4, contextScope: ch(OUT, 'msgr-dm') },
    { who: 'user', text: '남은 채널', ts: 5, contextScope: ch(IN) },
    { who: 'user', text: '텔레그램 그룹', ts: 6, contextScope: { kind: 'tg-group', chatId: '-100' } },
  ],
  scopedSessions: { [OUT]: { sessionId: SESS_OUT, sessionDevice: 'd1' }, [IN]: { sessionId: SESS_IN, sessionDevice: 'd1', at: 5 }, 'tg:-100': { sessionId: 'tg-s' } },
});

test('빠진 채널의 줄·세션만 지우고 나머지(데스크톱·남은 채널·텔레그램)는 그대로 둔다', () => {
  const t = thread();
  const r = forgetChannels(t, [OUT]);
  assert.equal(r.removed, 3);
  assert.deepEqual(r.sessionIds, [SESS_OUT]);
  assert.deepEqual(t.messages.map((m) => m.text), ['데스크톱 지시', '남은 채널', '텔레그램 그룹']);
  assert.deepEqual(Object.keys(t.scopedSessions).sort(), [IN, 'tg:-100'].sort());
  assert.deepEqual(t.departed[OUT], { ts: 4, sids: [SESS_OUT] }, '각인 시각 = 지운 줄 가운데 가장 늦은 ts(벽시계 아님)');
});

test('다시 들어온 뒤의 새 줄·새 세션(각인보다 늦음)은 남는다', () => {
  const t = thread(); forgetChannels(t, [OUT]);
  t.messages.push({ who: 'user', text: '재입장 뒤', ts: 200, contextScope: ch(OUT) });
  t.scopedSessions[OUT] = { sessionId: 'new-s' };
  assert.equal(applyDeparted(t), 0);
  assert.ok(t.messages.some((m) => m.text === '재입장 뒤'));
  assert.equal(t.scopedSessions[OUT].sessionId, 'new-s');
});

test('동기화 병합: 다른 기기가 아직 든 옛 채널 줄·세션이 되살아나지 않는다(양방향), 재입장 뒤 줄은 산다', () => {
  const a = thread(); forgetChannels(a, [OUT]);
  const b = thread(); b.messages.push({ who: 'user', text: '재입장 뒤(B)', ts: 300, contextScope: ch(OUT) });
  for (const prefer of ['local', 'remote']) {
    for (const [L, R] of [[a, b], [b, a]]) {
      const m = JSON.parse(mergeThread(Buffer.from(JSON.stringify(L)), Buffer.from(JSON.stringify(R)), prefer).toString());
      assert.ok(!m.messages.some((x) => /기밀|조직 채널 질문|조직 DM/.test(x.text)), `되살아남(${prefer})`);
      assert.ok(m.messages.some((x) => x.text === '재입장 뒤(B)'));
      assert.ok(!m.scopedSessions?.[OUT], '옛 채널 세션이 되살아남');
      assert.equal(m.departed[OUT].ts, 4);
    }
  }
});

const WS = 'co-recall';
async function seed(ws = WS) {
  const p = paths(ws);
  await mkdir(join(p.chats, '.archive'), { recursive: true });
  await mkdir(join(p.chats, '.trash'), { recursive: true });
  await writeFile(join(p.chats, 'pepper.json'), JSON.stringify(thread()));
  await writeFile(join(p.chats, '.archive', 'pepper-111.json'), JSON.stringify({ messages: [{ who: 'crew', text: '보관 기밀', ts: 1, contextScope: ch(OUT) }, { who: 'user', text: '보관 개인', ts: 2 }] }));
  await writeFile(join(p.chats, '.trash', 'pepper-222.json'), JSON.stringify({ messages: [{ who: 'crew', text: '보관함 기밀', ts: 1, contextScope: ch(OUT) }] }));
  await writeFile(join(p.chats, 'room-x.json'), JSON.stringify({ messages: [{ who: 'crew', text: '회의실', ts: 1, contextScope: ch(OUT) }] })); // 에이전트가 아닌 파일
  await mkdir(join(p.root, '.msgr-journal'), { recursive: true });
  await writeFile(join(p.root, '.msgr-journal', `2026-09-20-pepper.org-${IN}-ch-${OUT}.md`), '옛 일지');
  await writeFile(join(p.root, '.msgr-journal', `2026-09-20-other.org-${IN}-ch-${OUT}.md`), '다른 에이전트 일지');
  const cfg = await mkdtemp(join(tmpdir(), 'argo-recall-cfg-'));
  await mkdir(join(cfg, 'projects', '-ws-pepper'), { recursive: true });
  await writeFile(join(cfg, 'projects', '-ws-pepper', `${SESS_OUT}.jsonl`), '{}');
  await writeFile(join(cfg, 'projects', '-ws-pepper', `${SESS_IN}.jsonl`), '{}');
  return { p, cfg };
}
const read = async (f) => JSON.parse(await readFile(f, 'utf8'));

test('회수 한 바퀴: 서버가 false라고 한 채널만 활성·보관·보관함·전사·옛 일지에서 지운다', async () => {
  const { p, cfg } = await seed();
  const asked = [];
  const r = await recallDeparted(WS, ['pepper'], async (pairs) => { asked.push(pairs.map((x) => `${x.slug}:${x.id}`).sort()); return new Map([[`pepper:${OUT}`, false], [`pepper:${IN}`, true]]); }, { configDirs: [cfg] });
  assert.deepEqual(asked, [[`pepper:${OUT}`, `pepper:${IN}`].sort()], '회사당 한 번');
  assert.equal(r.channels, 1);
  const act = await read(join(p.chats, 'pepper.json'));
  assert.deepEqual(act.messages.map((m) => m.text), ['데스크톱 지시', '남은 채널', '텔레그램 그룹']);
  assert.deepEqual((await read(join(p.chats, '.archive', 'pepper-111.json'))).messages.map((m) => m.text), ['보관 개인']);
  assert.deepEqual((await read(join(p.chats, '.trash', 'pepper-222.json'))).messages, []);
  assert.ok(!existsSync(join(cfg, 'projects', '-ws-pepper', `${SESS_OUT}.jsonl`)), '빠진 채널 세션 전사 삭제');
  assert.ok(existsSync(join(cfg, 'projects', '-ws-pepper', `${SESS_IN}.jsonl`)), '남은 채널 세션 전사는 그대로');
  assert.deepEqual(await readdir(join(p.root, '.msgr-journal')), [`2026-09-20-other.org-${IN}-ch-${OUT}.md`], '그 에이전트의 옛 일지만');
  assert.equal((await read(join(p.chats, 'room-x.json'))).messages.length, 1, '에이전트가 아닌 대화 파일은 건드리지 않는다');
  const again = []; await recallDeparted(WS, ['pepper'], async (pairs) => { again.push(pairs.map((x) => x.id)); return new Map(); }, { configDirs: [cfg] });
  assert.deepEqual(again, [[IN]], '지운 채널은 다시 묻지 않는다(각인 키는 질의 대상 아님)');
});

test('조회 실패·옛 서버(null)·답에 없는 채널은 아무것도 지우지 않는다', async () => {
  let i = 0;
  for (const presence of [async () => { throw new Error('402'); }, async () => null, async () => new Map([[`pepper:${IN}`, true]])]) {
    const ws = `co-safe-${i++}`;
    const { p, cfg } = await seed(ws);
    const before = await readFile(join(p.chats, 'pepper.json'), 'utf8');
    const r = await recallDeparted(ws, ['pepper'], presence, { configDirs: [cfg] });
    assert.equal(r.channels, 0);
    assert.equal(await readFile(join(p.chats, 'pepper.json'), 'utf8'), before);
    assert.ok(existsSync(join(cfg, 'projects', '-ws-pepper', `${SESS_OUT}.jsonl`)));
    assert.equal((await readdir(join(p.root, '.msgr-journal'))).length, 2);
  }
});

test('다른 크루가 쪽지로 전해 준 줄(via)과 그 답은 회수하지 않는다', () => {
  const t = { messages: [
    { who: 'user', text: '쪽지 지시', ts: 1, via: 'crewmail', contextScope: ch(OUT) },
    { who: 'crew', text: '쪽지 답', ts: 2, contextScope: ch(OUT) },
    { who: 'user', text: '직접 받은 채널 글', ts: 3, contextScope: ch(OUT) },
    { who: 'crew', text: '직접 답', ts: 4, contextScope: ch(OUT) },
  ] };
  forgetChannels(t, [OUT]);
  assert.deepEqual(t.messages.map((m) => m.text), ['쪽지 지시', '쪽지 답']);
});

test('읽는 자리(loadThread)와 이어가기(resumeSession)에서도 각인을 적용한다 — 예전 버전 기기가 되살린 줄·보관본', async () => {
  const { loadThread, resumeSession } = await import('../src/thread.mjs');
  const ws = 'co-read'; const p = paths(ws);
  await mkdir(join(p.chats, '.archive'), { recursive: true });
  const t = thread(); forgetChannels(t, [OUT]);
  t.messages.push({ who: 'crew', text: '예전 기기가 되살린 기밀', ts: 3, contextScope: ch(OUT) }); // 각인보다 이른 ts
  await writeFile(join(p.chats, 'pepper.json'), JSON.stringify(t));
  assert.ok(!(await loadThread(ws, 'pepper')).messages.some((m) => /기밀/.test(m.text)));
  await writeFile(join(p.chats, '.archive', 'pepper-5.json'), JSON.stringify({ messages: [{ who: 'crew', text: '보관본 기밀', ts: 2, contextScope: ch(OUT) }], scopedSessions: { [OUT]: { sessionId: SESS_OUT } } })); // 각인 전 다른 기기에서 온 보관본
  const back = await resumeSession(ws, 'pepper', 'pepper-5.json');
  assert.deepEqual(back.messages, []);
  assert.ok(!back.scopedSessions[OUT], '되살린 대화에 지운 채널 세션이 돌아오지 않는다');
});

test('채널 세션 장부: 이 기기에서 그 채널에 쓴 세션 전부를 회수 때 지운다(마지막 하나만이 아니라)', async () => {
  const { appendTurn } = await import('../src/thread.mjs');
  const ws = 'co-ledger'; const p = paths(ws);
  await mkdir(p.chats, { recursive: true });
  const cfg = await mkdtemp(join(tmpdir(), 'argo-recall-ledger-'));
  await mkdir(join(cfg, 'projects', 'x'), { recursive: true });
  const old1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; const old2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  for (const sid of [old1, old2]) {
    await writeFile(join(cfg, 'projects', 'x', `${sid}.jsonl`), '{}');
    await appendTurn(ws, 'pepper', { userMsg: 'q', reply: 'a', sessionId: sid, contextScope: ch(OUT) });
  }
  await appendTurn(ws, 'pepper', { userMsg: 'dm', reply: 'a', sessionId: SESS_IN, contextScope: ch(IN, 'msgr-dm') });
  const r = await recallDeparted(ws, ['pepper'], async () => new Map([[`pepper:${OUT}`, false], [`pepper:${IN}`, true]]), { configDirs: [cfg] });
  assert.equal(r.transcripts, 2);
  assert.ok(!existsSync(join(cfg, 'projects', 'x', `${old1}.jsonl`)) && !existsSync(join(cfg, 'projects', 'x', `${old2}.jsonl`)));
  const ledger = JSON.parse(await readFile(join(p.root, '.msgr-sessions.json'), 'utf8'));
  assert.deepEqual(Object.keys(ledger), [`pepper:${IN}`], '남은 채널 장부는 그대로');
});

test('실제 저장 모양(msgr.mjs appendTurn 인자 그대로): 메신저 채널·DM·루틴 줄은 회수, 쪽지 줄은 보존', async () => {
  const { appendTurn, loadThread } = await import('../src/thread.mjs');
  const ws = 'co-shape';
  await mkdir(paths(ws).chats, { recursive: true });
  const actor = { uid: 'u1', name: '유건' };
  // msgr.mjs:1294 — 채널 턴과 DM 턴(같은 인자 모양)
  await appendTurn(ws, 'pepper', { userMsg: '채널 지시', reply: '채널 답', sessionId: SESS_OUT, contextScope: { kind: 'msgr', channelId: OUT, threadRoot: null }, via: 'msgr', actor });
  await appendTurn(ws, 'pepper', { userMsg: 'DM 지시', reply: 'DM 답', sessionId: null, contextScope: { kind: 'msgr-dm', channelId: OUT, threadRoot: 'r1' }, via: 'msgr', actor });
  await appendTurn(ws, 'pepper', { userMsg: '루틴 지시', reply: '루틴 답', contextScope: { kind: 'msgr', channelId: OUT }, via: 'routine' });
  await appendTurn(ws, 'pepper', { userMsg: '쪽지 지시', reply: '쪽지 답', contextScope: { kind: 'msgr', channelId: OUT }, via: 'crewmail' });
  await appendTurn(ws, 'pepper', { userMsg: '남은 채널', reply: '남은 답', contextScope: { kind: 'msgr', channelId: IN }, via: 'msgr', actor });
  const r = await recallDeparted(ws, ['pepper'], async () => new Map([[`pepper:${OUT}`, false], [`pepper:${IN}`, true]]), { configDirs: [] });
  assert.equal(r.removed, 6);
  assert.deepEqual((await loadThread(ws, 'pepper')).messages.map((m) => m.text), ['쪽지 지시', '쪽지 답', '남은 채널', '남은 답']);
});

test('500쌍이 넘으면 나눠 묻는다 — 꼬리도 답을 받는다', async () => {
  const ws = 'co-chunk'; const p = paths(ws);
  await mkdir(p.chats, { recursive: true });
  const hex = (n) => n.toString(16).padStart(12, '0');
  const msgs = Array.from({ length: 620 }, (_, i) => ({ who: 'user', text: `m${i}`, ts: i + 1, via: 'msgr', contextScope: ch(`aaaaaaaa-aaaa-4aaa-8aaa-${hex(i)}`) }));
  await writeFile(join(p.chats, 'pepper.json'), JSON.stringify({ messages: msgs }));
  const sizes = [];
  const r = await recallDeparted(ws, ['pepper'], async (pairs) => { sizes.push(pairs.length); return new Map(pairs.map((x) => [`${x.slug}:${x.id}`, false])); }, { configDirs: [] });
  assert.deepEqual(sizes, [500, 120]);
  assert.equal(r.removed, 620);
});

test('한 조각이라도 조회에 실패하면 아무것도 지우지 않는다', async () => {
  const ws = 'co-chunk-fail'; const p = paths(ws);
  await mkdir(p.chats, { recursive: true });
  const hex = (n) => n.toString(16).padStart(12, '0');
  const msgs = Array.from({ length: 520 }, (_, i) => ({ who: 'user', text: `m${i}`, ts: i + 1, via: 'msgr', contextScope: ch(`aaaaaaaa-aaaa-4aaa-8aaa-${hex(i)}`) }));
  await writeFile(join(p.chats, 'pepper.json'), JSON.stringify({ messages: msgs }));
  let n = 0;
  const r = await recallDeparted(ws, ['pepper'], async (pairs) => { if (n++) throw new Error('timeout'); return new Map(pairs.map((x) => [`${x.slug}:${x.id}`, false])); }, { configDirs: [] });
  assert.equal(r.removed, 0);
  assert.equal(JSON.parse(await readFile(join(p.chats, 'pepper.json'), 'utf8')).messages.length, 520);
});

test('새 대화(reset)와 보관 보기에도 각인이 이어진다', async () => {
  const { resetThread, readArchivedSession, listArchivedSessions } = await import('../src/thread.mjs');
  const ws = 'co-reset'; const p = paths(ws);
  await mkdir(join(p.chats, '.archive'), { recursive: true });
  const t = thread(); forgetChannels(t, [OUT]);
  await writeFile(join(p.chats, 'pepper.json'), JSON.stringify(t));
  await resetThread(ws, 'pepper');
  assert.equal(JSON.parse(await readFile(join(p.chats, 'pepper.json'), 'utf8')).departed[OUT].ts, 4);
  await writeFile(join(p.chats, '.archive', 'pepper-7.json'), JSON.stringify({ messages: [{ who: 'crew', text: '각인 없는 보관본 기밀', ts: 2, via: 'msgr', contextScope: ch(OUT) }] }));
  assert.deepEqual((await readArchivedSession(ws, 'pepper', 'pepper-7.json')).messages, []);
  assert.ok((await listArchivedSessions(ws, 'pepper')).length >= 1);
});

test('본체 판정 읽기: 서버의 present=null(판정 없음)은 Map에 넣지 않는다 — 넣으면 false로 읽혀 전부 지운다(분리 검수 M-1)', async () => {
  const { makeDb } = await import('../src/gateway/msgr.mjs');
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push([name, args]); return { data: [{ slug: 'pepper', id: OUT, present: false }, { slug: 'pepper', id: IN, present: null }, { slug: 'kim', id: IN, present: true }], error: null }; } };
  const m = await makeDb(client).crewPresence('co-a', [{ slug: 'pepper', id: OUT }, { slug: 'pepper', id: IN }, { slug: 'kim', id: IN }]);
  assert.deepEqual(calls, [['msgr_crew_presence', { p_ws: 'co-a', p_slugs: ['pepper', 'pepper', 'kim'], p_ids: [OUT, IN, IN] }]]);
  assert.deepEqual([...m].sort(), [[`kim:${IN}`, true], [`pepper:${OUT}`, false]].sort());
  const old = { rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'no fn' } }) };
  assert.equal(await makeDb(old).crewPresence('co-a', [{ slug: 'pepper', id: OUT }]), null, '옛 서버 = 판정 없음');
});

test('채널 줄이 보관본에만 있어도 활성 대화에 각인을 남긴다 — 각인 없는 옛 보관본이 돌아와도 거른다(재검수 L-a)', async () => {
  const { readArchivedSession } = await import('../src/thread.mjs');
  const ws = 'co-arch-only'; const p = paths(ws);
  await mkdir(join(p.chats, '.archive'), { recursive: true });
  await writeFile(join(p.chats, 'pepper.json'), JSON.stringify({ messages: [{ who: 'user', text: '새 대화', ts: 50 }] }));
  const arch = { messages: [{ who: 'user', text: '보관 채널 글', ts: 9, via: 'msgr', contextScope: ch(OUT) }] };
  await writeFile(join(p.chats, '.archive', 'pepper-1.json'), JSON.stringify(arch));
  await recallDeparted(ws, ['pepper'], async () => new Map([[`pepper:${OUT}`, false]]), { configDirs: [] });
  assert.equal(JSON.parse(await readFile(join(p.chats, 'pepper.json'), 'utf8')).departed[OUT].ts, 9);
  await writeFile(join(p.chats, '.archive', 'pepper-1.json'), JSON.stringify(arch)); // 다른 기기에서 각인 없는 보관본이 돌아옴
  assert.deepEqual((await readArchivedSession(ws, 'pepper', 'pepper-1.json')).messages, []);
});
