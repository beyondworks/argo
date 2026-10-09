// H33 MEDIUM-1 — 조직 목록(loadOrg)이 에이전트 전원의 '/' 명령 목록(msgr_crews.commands, 행당 최대 64KB)을 같이 받던 것.
// 이제 loadOrg는 commands 열을 읽지 않고, '/' 팝업을 연 순간 그 방 에이전트만 따로 읽는다(readSlashCommands).
// 재조회가 오기 전에는 '명령 없음'(cmd.empty)이 아니라 '불러오는 중'(cmd.loading)이 보여야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import { createRequestGate } from '../src/rail-state.mjs';
import { stampFetched } from '../src/presence-clock.mjs';
import { crewOrder, withoutCopies } from '../src/mention-candidates.mjs';
import * as slash from '../src/slash-commands.mjs';
import { crewCommands, fitCommands } from '../../../src/gateway/msgr.mjs'; // 본체 게이트웨이가 msgr_crews.commands에 올리는 모양 그대로
import { DICT } from '../src/i18n.js';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

// 게이트웨이가 실제로 올릴 수 있는 가장 큰 목록(별칭 지시문 15개 × 2,000자 + 스킬 수백 개 → fitCommands가 60,000 예산으로 자른다)
const ko = (n) => '가나다라마바사아자차'.repeat(Math.ceil(n / 10)).slice(0, n);
const BIG = fitCommands(crewCommands({
  aliases: Array.from({ length: 15 }, (_, i) => ({ cmd: `별칭${i}`, text: `${i}번 ` + ko(1990) })),
  skills: Array.from({ length: 400 }, (_, i) => ({ id: `skill-${i}`, title: ko(80) })),
})).commands;

// ── loadOrg 하네스: App.jsx의 loadOrg 본문을 잘라 가짜 클라이언트로 돌린다(rail-state.test.mjs와 같은 방식) ──
// 가짜 클라이언트는 select 인자대로 열을 걸러서 답하므로, 응답에 실제로 실린 바이트가 select에 달렸다(= 전송량).
function orgHarness({ rows, faceInDb = true }) {
  const start = app.indexOf('const loadOrg = useCallback(') + 'const loadOrg = useCallback('.length;
  const end = app.indexOf('\n  }, [orgs, uid]);', start) + 4;
  const crewSelects = []; let crewBytes = 0; const state = {};
  const project = (row, cols) => Object.fromEntries(cols.split(',').map((c) => c.trim()).filter((c) => c in row).map((c) => [c, row[c]]));
  const supabase = { from(table) { let cols = '';
    return { select(c) { cols = c; if (table === 'msgr_crews') crewSelects.push(c); return this; }, eq() { return this; }, is() { return this; }, order() { return this; }, in() { return this; }, maybeSingle() { return this; },
      then(res, rej) {
        if (table === 'msgr_crews') {
          if (/face/.test(cols) && !faceInDb) return Promise.reject(new Error('column msgr_crews.face does not exist')).then(res, rej);
          const out = rows.map((r) => project(r, cols)); crewBytes += bytes(out); return Promise.resolve(out).then(res, rej);
        }
        if (table === 'msgr_channels') return Promise.resolve([{ id: 'ch', kind: 'public' }]).then(res, rej);
        if (table === 'msgr_org_members' || table === 'msgr_channel_members') return Promise.resolve([]).then(res, rej);
        return Promise.resolve({ data: null }).then(res, rej); } }; } };
  const setters = Object.fromEntries(['Channels', 'PreviewChannels', 'Members', 'Crews', 'MyAvailable', 'Ent', 'Policy', 'DmMembers'].map((k) => [`set${k}`, (v) => { state[k] = v; }]));
  const activeOrg = { current: 'A' };
  const deps = { stampFetched, crewOrder, withoutCopies, joinedRef: { current: new Set() }, supabase, q: async (x) => await x, uid: 'me', activeOrg, loadedOrg: { current: null }, orgRequests: { current: createRequestGate(() => activeOrg.current) }, orgs: [{ id: 'A' }], crewTier: () => '', readLastCh: () => null, faceCol: { missingAt: 0 }, ...setters, setChId: () => {} };
  const loadOrg = new Function(...Object.keys(deps), `return (${app.slice(start, end)});`)(...Object.values(deps));
  return { loadOrg, state, crewSelects, crewBytes: () => crewBytes };
}
// 30명 조직 — 같은 회사 에이전트라 전원이 같은 큰 목록을 가진다(DB에 올라가는 모양: commands 열이 행마다 최대 크기)
const org30 = () => Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, owner_user_id: 'me', slug: `agent-${i}`, display_name: `에이전트 ${i}`, role_text: '비서', hosting: 'local', status: 'active', allow: 'all', allow_users: [], last_seen_at: new Date().toISOString(), folder: null, created_at: new Date().toISOString(), avatar_url: null, bio: null, face: null, commands: BIG }));

test('① loadOrg는 msgr_crews에서 commands 열을 읽지 않는다 — face 열이 있는 서버도, 옛 서버(face 없음) 재시도도', async () => {
  for (const faceInDb of [true, false]) {
    const h = orgHarness({ rows: org30(), faceInDb });
    await h.loadOrg('A');
    assert.ok(h.crewSelects.length >= 1, '에이전트 목록을 읽었다');
    for (const cols of h.crewSelects) {
      assert.doesNotMatch(cols, /\bcommands\b/, `commands 열이 조회에 없다 (faceInDb=${faceInDb}): ${cols}`);
      assert.match(cols, /\bid\b.*\bdisplay_name\b/, '나머지 열은 그대로 읽는다');
    }
    assert.equal(h.state.Crews.length, 30, '목록은 그대로 채워진다');
    assert.ok(h.state.Crews.every((c) => !('commands' in c) || c.commands === undefined), '상태의 에이전트 행에 commands가 없다');
  }
});

test('① 전송량 — 30명 조직 한 번 열 때 에이전트 응답이 commands 때문에 커지지 않는다(가짜 응답의 JSON 바이트)', async (t) => {
  const h = orgHarness({ rows: org30() });
  await h.loadOrg('A');
  const perRowCmds = bytes(BIG);
  const before = bytes(org30()); // 예전 select(commands 포함)가 받던 응답과 같은 크기
  t.diagnostic(`commands 1행 ${perRowCmds}B, 30행 응답: 예전 ${before}B → 지금 ${h.crewBytes()}B`);
  assert.ok(perRowCmds > 50_000 && perRowCmds <= 65_536, `테스트 재료가 실제 상한 근처다(${perRowCmds}B)`);
  assert.ok(h.crewBytes() < before / 20, `응답이 20분의 1 아래로 줄었다 (${h.crewBytes()}B)`);
  assert.ok(h.crewBytes() < perRowCmds, `에이전트 30명 응답 전체가 commands 한 행보다 작다 (${h.crewBytes()}B)`);
});

// ── 팝업을 열 때 따로 읽기 ──
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
function fakeDb(handler) {
  const calls = [];
  return { calls, from(table) { const call = { table }; calls.push(call);
    const api = { select(c) { call.cols = c; return api; }, in(k, v) { call.inKey = k; call.inVals = v; return api; }, then(res, rej) { return Promise.resolve().then(() => handler(call)).then(res, rej); } };
    return api; } };
}
const orgCrew = (id, name) => ({ id, display_name: name, status: 'active' }); // loadOrg 행 — commands 열이 없다
const OPT = { skillPrefix: (title) => `"${title}" 스킬을 사용해서 `, builtins: [{ cmd: 'to', desc: '수신' }, { cmd: 'cc', desc: '참조' }] };
const LIST = [{ kind: 'alias', cmd: '보고', text: '오늘 업무 보고서를 써' }, { kind: 'skill', id: 'daily-report', title: '일일 보고' }];

test('② 팝업을 연 직후 재조회 전에는 불러오는 중, 재조회가 오면 명령 목록', async () => {
  const gate = deferred();
  const db = fakeDb(() => gate.p);
  const crews = [orgCrew('p', '페퍼'), orgCrew('a', '알프레드')];
  const first = slash.slashView('/', crews, null, OPT); // 팝업이 막 열린 렌더 — 재조회 결과가 아직 없다
  assert.equal(first.loading, true, '재조회 전에는 불러오는 중');
  assert.deepEqual(first.cands.map((c) => c.cmd), ['to', 'cc'], '내장 명령은 바로 보인다');
  assert.equal(slash.slashView('/보고', crews, null, OPT).cands.length, 0);
  assert.equal(slash.slashView('/보고', crews, null, OPT).loading, true, '찾는 말이 아직 없는 목록이어도 명령 없음이 아니라 불러오는 중');
  assert.equal(slash.slashView('안녕', crews, null, OPT).cands, null, '슬래시 토큰이 아니면 팝업 자체가 없다');
  assert.equal(slash.slashView('안녕', crews, null, OPT).loading, false);

  const pending = slash.readSlashCommands(db, ['p', 'a']);
  assert.deepEqual(db.calls.map((c) => [c.table, c.cols, c.inKey, c.inVals]), [['msgr_crews', 'id, commands', 'id', ['p', 'a']]], '그 방 에이전트의 id·commands만 읽는다');
  gate.resolve({ data: [{ id: 'p', commands: LIST }, { id: 'a', commands: LIST }], error: null });
  const fresh = await pending;
  const done = slash.slashView('/', crews, fresh, OPT);
  assert.equal(done.loading, false);
  assert.deepEqual(done.cands.map((c) => [c.kind, c.cmd, c.crews.map((x) => x.name)]), [['builtin', 'to', []], ['builtin', 'cc', []], ['alias', '보고', ['페퍼', '알프레드']], ['skill', 'daily-report', ['페퍼', '알프레드']]]);
});

test('③ 재조회 실패는 예전처럼 조용히 끝난다 — 던지지 않고, 불러오는 중에서 벗어나 아는 것(없으면 빈 목록)만 보인다', async () => {
  const crews = [orgCrew('p', '페퍼')];
  for (const [name, handler] of [['오류 응답', () => ({ data: null, error: { message: 'timeout' } })], ['네트워크 예외', () => { throw new Error('network'); }], ['402 차단', () => ({ data: null, error: { message: 'Payment required', code: '402' } })], ['데이터 없음', () => ({ data: null, error: null })]]) {
    const fresh = await slash.readSlashCommands(fakeDb(handler), ['p']); // 거부되지 않는다
    const v = slash.slashView('/', crews, fresh, OPT);
    assert.equal(v.loading, false, `${name}: 불러오는 중에 영원히 머물지 않는다`);
    assert.deepEqual(v.cands.map((c) => c.cmd), ['to', 'cc'], `${name}: 아는 것(내장 명령)만 보인다`);
  }
  const hit = await slash.readSlashCommands(fakeDb(() => ({ data: [{ id: 'p', commands: LIST }], error: null })), ['p']);
  assert.deepEqual(hit, { p: LIST });
});

test('개인 공간 행(RPC가 commands를 이미 줌: 내 것은 배열, 남의 것은 null)은 기다리지 않는다 — 재조회 전에도 바로 보이고 불러오는 중이 없다', () => {
  const mine = { id: 'm', display_name: '내 에이전트', commands: LIST }; const friends = { id: 'f', display_name: '친구 에이전트', commands: null };
  const v = slash.slashView('/', [mine, friends], null, OPT);
  assert.equal(v.loading, false);
  assert.deepEqual(v.cands.map((c) => c.cmd), ['to', 'cc', '보고', 'daily-report']);
  assert.equal(slash.slashView('/', [], null, OPT).loading, false, '에이전트가 없으면 읽을 것도 없다');
});

test('재조회 값이 행 값보다 앞선다 — 본체에서 막 바뀐 목록, 재조회에 없는 에이전트는 행 값으로', () => {
  const stale = [{ kind: 'alias', cmd: '옛', text: 'old' }];
  const v = slash.slashView('/', [{ id: 'a', display_name: 'A', commands: stale }, { id: 'b', display_name: 'B', commands: stale }], { a: LIST }, OPT);
  assert.deepEqual(v.cands.filter((c) => c.kind !== 'builtin').map((c) => [c.cmd, c.crews.map((x) => x.id)]), [['보고', ['a']], ['daily-report', ['a']], ['옛', ['b']]]);
});

// ── 화면 배선: App.jsx의 실제 팝업 JSX를 esbuild로 컴파일해 그린다(open-room-sync.test.mjs와 같은 방식) ──
function popupHtml(vars) {
  const lines = app.split('\n');
  const from = lines.findIndex((l) => l.trim() === '{slashCands && (');
  assert.ok(from > 0, "'/' 팝업 JSX를 찾지 못함");
  const to = lines.findIndex((l, i) => i > from && l.trim() === ')}');
  const block = lines.slice(from, to + 1).join('\n').trim();
  const code = transformSync(`(<>${block}</>)`, { loader: 'jsx', jsxFactory: '__h', jsxFragment: '__F' }).code.trim().replace(/;$/, '');
  const run = new Function('__s', `with (__s) { return ${code}; }`);
  const globals = new Set(['undefined', 'Math', 'JSON', 'Date', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Set', 'Map', 'Promise']);
  const scope = { __h: React.createElement, __F: React.Fragment, t: (k) => `«${k}»`, slashSel: 0, pickSlash: () => {}, ...vars };
  return renderToStaticMarkup(run(new Proxy({}, { has: (_, k) => typeof k === 'string' && !globals.has(k), get: (_, k) => (k === Symbol.unscopables ? undefined : k in scope ? scope[k] : undefined) })));
}
const cand = (cmd) => ({ key: `a:${cmd}`, kind: 'alias', cmd, desc: '본문', insert: '본문', crews: [] });

test('팝업 화면 — 불러오는 중이면 명령 없음 문구 대신 불러오는 중, 끝났는데 비면 명령 없음, 있으면 목록(불러오는 중이어도 이미 아는 명령은 먼저)', () => {
  const loading = popupHtml({ slashCands: [], slashLoading: true });
  assert.match(loading, /«cmd\.loading»/); assert.doesNotMatch(loading, /«cmd\.empty»/, '재조회 전에 명령 없음이 잠깐 보이면 안 된다');
  const empty = popupHtml({ slashCands: [], slashLoading: false });
  assert.match(empty, /«cmd\.empty»/); assert.doesNotMatch(empty, /«cmd\.loading»/);
  const some = popupHtml({ slashCands: [cand('to'), cand('cc')], slashLoading: true });
  assert.match(some, /\/to/); assert.match(some, /\/cc/); assert.match(some, /«cmd\.loading»/); assert.doesNotMatch(some, /«cmd\.empty»/);
  const full = popupHtml({ slashCands: [cand('보고')], slashLoading: false });
  assert.match(full, /\/보고/); assert.doesNotMatch(full, /«cmd\.(loading|empty)»/);
  assert.equal(popupHtml({ slashCands: null, slashLoading: false }), '', '슬래시 토큰이 아니면 팝업이 없다');
});

// 입력창이 쓰는 파생값(slash·slashCands·slashLoading) — App.jsx의 실제 줄을 잘라 돌려서, slashView → 팝업 배선이 끊기면(예: slashLoading을 안 넘김) 여기서 빨개진다
function composerGlue({ text = '/', slashOff = null, rolePick = null, slashCrews, freshCmds }) {
  const from = app.indexOf('  const slash = useMemo(');
  const to = app.indexOf('\n', app.indexOf('const slashCands = slash?.cands', from));
  assert.ok(from > 0 && to > from, '입력창의 slash 파생 줄을 찾지 못함');
  const deps = { useMemo: (f) => f(), rolePick, text, slashOff, slashCrews, freshCmds, t: (k) => `«${k}»`, slashView: slash.slashView };
  return new Function(...Object.keys(deps), `${app.slice(from, to)}\n return { slashCands, slashLoading };`)(...Object.values(deps));
}
test('입력창 배선 — 에이전트 행에 commands가 없고 재조회 전이면 팝업에 불러오는 중, 재조회 값이 들어오면 목록, 문장 속 /·/to 질의 중이면 팝업 없음', () => {
  const crews = [orgCrew('p', '페퍼')];
  const before = composerGlue({ slashCrews: crews, freshCmds: null });
  assert.equal(before.slashLoading, true);
  assert.match(popupHtml(before), /«cmd\.loading»/); assert.doesNotMatch(popupHtml(before), /«cmd\.empty»/);
  const after = composerGlue({ slashCrews: crews, freshCmds: { p: LIST } });
  assert.equal(after.slashLoading, false);
  assert.match(popupHtml(after), /\/보고/); assert.match(popupHtml(after), /\/daily-report/); assert.doesNotMatch(popupHtml(after), /«cmd\.(loading|empty)»/);
  const failed = composerGlue({ slashCrews: crews, freshCmds: {} }); // 재조회 실패 → {}
  assert.equal(failed.slashLoading, false); assert.match(popupHtml(failed), /\/to/); assert.doesNotMatch(popupHtml(failed), /«cmd\.loading»/);
  assert.deepEqual(composerGlue({ text: '안녕 /보고', slashCrews: crews, freshCmds: null }), { slashCands: null, slashLoading: false });
  assert.deepEqual(composerGlue({ slashOff: '/', slashCrews: crews, freshCmds: null }), { slashCands: null, slashLoading: false }, 'Esc로 닫은 글자에서는 다시 띄우지 않는다');
  assert.deepEqual(composerGlue({ rolePick: { role: 'to', list: [] }, slashCrews: crews, freshCmds: null }), { slashCands: null, slashLoading: false }, '/to·/cc 목록과 겹치지 않는다');
});

// 팝업을 여닫을 때의 재조회 효과 — App.jsx의 실제 useEffect 본문을 잘라 가짜 훅으로 돌린다
function slashEffect({ slashOpen, slashIds, chId = 'ch', db, setFreshCmds }) {
  const startMark = '  useEffect(() => {\n    if (!slashOpen)'; const endMark = '}, [slashOpen, chId, slashIds]);';
  const start = app.indexOf(startMark); const end = app.indexOf(endMark, start) + endMark.length;
  assert.ok(start > 0 && end > start, '팝업 재조회 효과를 찾지 못함');
  let run; let depKeys;
  const useEffect = (f, d) => { run = f; depKeys = d; };
  new Function('useEffect', 'slashOpen', 'slashIds', 'chId', 'supabase', 'readSlashCommands', 'setFreshCmds', app.slice(start, end))(useEffect, slashOpen, slashIds, chId, db, slash.readSlashCommands, setFreshCmds);
  return { cleanup: run(), deps: depKeys };
}
const tick = () => new Promise((r) => setImmediate(r));
test('② 재조회 효과 — 열릴 때 그 방 에이전트만 한 번 읽어 넣고, 닫히면 비우고, 닫힌 뒤 늦게 온 답은 버린다, 에이전트가 없으면 읽지 않는다', async () => {
  const sets = []; const gate = deferred();
  const db = fakeDb(() => gate.p);
  const eff = slashEffect({ slashOpen: true, slashIds: 'p,a', db, setFreshCmds: (v) => sets.push(v) });
  assert.deepEqual(db.calls.map((c) => [c.cols, c.inVals]), [['id, commands', ['p', 'a']]]);
  assert.deepEqual(sets, [], '답이 오기 전에는 아직 아무것도 넣지 않는다(= 불러오는 중)');
  gate.resolve({ data: [{ id: 'p', commands: LIST }], error: null }); await tick();
  assert.deepEqual(sets, [{ p: LIST }]);
  assert.deepEqual(eff.deps.length, 3, '열림·방·에이전트 집합이 바뀌면 다시 읽는다');

  const late = deferred(); const sets2 = []; const db2 = fakeDb(() => late.p);
  const eff2 = slashEffect({ slashOpen: true, slashIds: 'p', db: db2, setFreshCmds: (v) => sets2.push(v) });
  eff2.cleanup(); late.resolve({ data: [{ id: 'p', commands: LIST }], error: null }); await tick();
  assert.deepEqual(sets2, [], '팝업이 닫히거나 방이 바뀐 뒤 늦게 온 답은 넣지 않는다');

  const sets3 = []; const db3 = fakeDb(() => ({ data: null, error: { message: 'x' } }));
  slashEffect({ slashOpen: true, slashIds: 'p', db: db3, setFreshCmds: (v) => sets3.push(v) }); await tick();
  assert.deepEqual(sets3, [{}], '실패하면 {}로 끝나 불러오는 중에서 벗어난다');

  const sets4 = []; const db4 = fakeDb(() => ({ data: [], error: null }));
  slashEffect({ slashOpen: false, slashIds: 'p', db: db4, setFreshCmds: (v) => sets4.push(v) });
  assert.deepEqual(sets4, [null], '팝업이 닫히면 비운다 — 다음에 열 때 다시 불러오는 중부터'); assert.equal(db4.calls.length, 0);
  const db5 = fakeDb(() => ({ data: [], error: null })); const sets5 = [];
  slashEffect({ slashOpen: true, slashIds: '', db: db5, setFreshCmds: (v) => sets5.push(v) }); await tick();
  assert.equal(db5.calls.length, 0, '읽을 에이전트가 없으면 요청하지 않는다'); assert.deepEqual(sets5, []);
});

test('새 문구 cmd.loading — 한국어·영어 모두 있고, 금지어(크루·사장)가 없다', () => {
  const pair = DICT['cmd.loading']; assert.ok(Array.isArray(pair) && pair[0] && pair[1], 'ko·en 둘 다 등록');
  assert.doesNotMatch(pair.join(' '), /크루|사장|crew|boss/i);
  assert.match(pair[0], /[가-힣]/); assert.doesNotMatch(pair[1], /[가-힣]/);
});
