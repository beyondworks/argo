// H33 MEDIUM-1 — 조직 목록(loadOrg)이 에이전트 전원의 '/' 명령 목록(msgr_crews.commands, 행당 최대 64KB)을 같이 받던 것.
// 이제 loadOrg는 commands 열을 읽지 않고, '/' 팝업을 연 순간 그 방 에이전트만 따로 읽는다(readSlashCommands).
// 재조회가 오기 전에는 '명령 없음'(cmd.empty)이 아니라 '불러오는 중'(cmd.loading)이 보여야 하고, 그동안 Enter는 '/보고' 같은 글을 그대로 보내지 않는다.
// 재조회가 실패하거나 시간이 지나도 오지 않으면 '불러오지 못했습니다'(cmd.loadFailed)를 보이고 불러오는 중을 푼다(실패와 '명령 없음'을 구분).
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
import { createClient } from '@supabase/supabase-js'; // 설치된 실제 클라이언트로 abortSignal·실패 모양을 본다
import { guardAnonFetch } from '../src/anon-guard.mjs';

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
  assert.equal(fresh.ok, true);
  const done = slash.slashView('/', crews, fresh, OPT);
  assert.equal(done.loading, false); assert.equal(done.failed, false);
  assert.deepEqual(done.cands.map((c) => [c.kind, c.cmd, c.crews.map((x) => x.name)]), [['builtin', 'to', []], ['builtin', 'cc', []], ['alias', '보고', ['페퍼', '알프레드']], ['skill', 'daily-report', ['페퍼', '알프레드']]]);
});

test('③ 재조회 실패는 예전처럼 조용히 끝난다 — 던지지 않고, 불러오는 중에서 벗어나 아는 것(없으면 빈 목록)만 보인다', async () => {
  const crews = [orgCrew('p', '페퍼')];
  for (const [name, handler] of [['오류 응답', () => ({ data: null, error: { message: 'timeout' } })], ['네트워크 예외', () => { throw new Error('network'); }], ['402 차단', () => ({ data: null, error: { message: 'Payment required', code: '402' } })], ['데이터 없음', () => ({ data: null, error: null })]]) {
    const fresh = await slash.readSlashCommands(fakeDb(handler), ['p']); // 거부되지 않는다
    assert.deepEqual(fresh, { ok: false }, `${name}: 실패로 알린다`);
    const v = slash.slashView('/', crews, fresh, OPT);
    assert.equal(v.loading, false, `${name}: 불러오는 중에 영원히 머물지 않는다`); assert.equal(v.failed, true, `${name}: 실패 안내를 보인다`);
    assert.deepEqual(v.cands.map((c) => c.cmd), ['to', 'cc'], `${name}: 아는 것(내장 명령)만 보인다`);
  }
  const hit = await slash.readSlashCommands(fakeDb(() => ({ data: [{ id: 'p', commands: LIST }], error: null })), ['p']);
  assert.deepEqual(hit, { ok: true, cmds: { p: LIST } });
});

test('개인 공간 행(RPC가 commands를 이미 줌: 내 것은 배열, 남의 것은 null)은 기다리지 않는다 — 재조회 전에도 바로 보이고 불러오는 중이 없다', () => {
  const mine = { id: 'm', display_name: '내 에이전트', commands: LIST }; const friends = { id: 'f', display_name: '친구 에이전트', commands: null };
  const v = slash.slashView('/', [mine, friends], null, OPT);
  assert.equal(v.loading, false); assert.equal(v.failed, false);
  assert.deepEqual(v.cands.map((c) => c.cmd), ['to', 'cc', '보고', 'daily-report']);
  assert.equal(slash.slashView('/', [mine, friends], { ok: false }, OPT).failed, false, '행에 이미 있는 목록으로 보이니 재조회 실패를 알릴 것이 없다');
  assert.equal(slash.slashView('/', [], null, OPT).loading, false, '에이전트가 없으면 읽을 것도 없다');
});

test('재조회 값이 행 값보다 앞선다 — 본체에서 막 바뀐 목록, 재조회에 없는 에이전트는 행 값으로', () => {
  const stale = [{ kind: 'alias', cmd: '옛', text: 'old' }];
  const v = slash.slashView('/', [{ id: 'a', display_name: 'A', commands: stale }, { id: 'b', display_name: 'B', commands: stale }], { ok: true, cmds: { a: LIST } }, OPT);
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
  const loading = popupHtml({ slashCands: [], slashLoading: true, slashFailed: false });
  assert.match(loading, /«cmd\.loading»/); assert.doesNotMatch(loading, /«cmd\.empty»/, '재조회 전에 명령 없음이 잠깐 보이면 안 된다');
  const empty = popupHtml({ slashCands: [], slashLoading: false });
  assert.match(empty, /«cmd\.empty»/); assert.doesNotMatch(empty, /«cmd\.loading»/);
  const some = popupHtml({ slashCands: [cand('to'), cand('cc')], slashLoading: true });
  assert.match(some, /\/to/); assert.match(some, /\/cc/); assert.match(some, /«cmd\.loading»/); assert.doesNotMatch(some, /«cmd\.empty»/);
  const full = popupHtml({ slashCands: [cand('보고')], slashLoading: false });
  assert.match(full, /\/보고/); assert.doesNotMatch(full, /«cmd\.(loading|empty)»/);
  assert.equal(popupHtml({ slashCands: null, slashLoading: false }), '', '슬래시 토큰이 아니면 팝업이 없다');
  // 실패(LOW-1) — '명령 없음'이 아니라 불러오지 못했다고 알린다. 내장 명령이 있으면 그대로 두고 아래에 안내
  const failedEmpty = popupHtml({ slashCands: [], slashLoading: false, slashFailed: true });
  assert.match(failedEmpty, /«cmd\.loadFailed»/); assert.doesNotMatch(failedEmpty, /«cmd\.(empty|loading)»/, '실패를 명령 없음으로 말하지 않는다');
  const failedSome = popupHtml({ slashCands: [cand('to')], slashLoading: false, slashFailed: true });
  assert.match(failedSome, /\/to/); assert.match(failedSome, /«cmd\.loadFailed»/);
  assert.match(failedEmpty, /role="alert"/, '실패 안내는 알림으로');
});

// 입력창이 쓰는 파생값(slash·slashCands·slashLoading) — App.jsx의 실제 줄을 잘라 돌려서, slashView → 팝업 배선이 끊기면(예: slashLoading을 안 넘김) 여기서 빨개진다
function composerGlue({ text = '/', slashOff = null, rolePick = null, slashCrews, freshCmds }) {
  const from = app.indexOf('  const slash = useMemo(');
  const to = app.indexOf('\n', app.indexOf('const slashCands = slash?.cands', from));
  assert.ok(from > 0 && to > from, '입력창의 slash 파생 줄을 찾지 못함');
  const deps = { useMemo: (f) => f(), rolePick, text, slashOff, slashCrews, freshCmds, t: (k) => `«${k}»`, slashView: slash.slashView };
  return new Function(...Object.keys(deps), `${app.slice(from, to)}\n return { slashCands, slashLoading, slashFailed };`)(...Object.values(deps));
}
test('입력창 배선 — 에이전트 행에 commands가 없고 재조회 전이면 팝업에 불러오는 중, 재조회 값이 들어오면 목록, 문장 속 /·/to 질의 중이면 팝업 없음', () => {
  const crews = [orgCrew('p', '페퍼')];
  const before = composerGlue({ slashCrews: crews, freshCmds: null });
  assert.equal(before.slashLoading, true);
  assert.match(popupHtml(before), /«cmd\.loading»/); assert.doesNotMatch(popupHtml(before), /«cmd\.empty»/);
  const after = composerGlue({ slashCrews: crews, freshCmds: { ok: true, cmds: { p: LIST } } });
  assert.equal(after.slashLoading, false);
  assert.match(popupHtml(after), /\/보고/); assert.match(popupHtml(after), /\/daily-report/); assert.doesNotMatch(popupHtml(after), /«cmd\.(loading|empty)»/);
  const failed = composerGlue({ slashCrews: crews, freshCmds: { ok: false } }); // 재조회 실패
  assert.equal(failed.slashLoading, false); assert.equal(failed.slashFailed, true);
  assert.match(popupHtml(failed), /\/to/); assert.match(popupHtml(failed), /«cmd\.loadFailed»/); assert.doesNotMatch(popupHtml(failed), /«cmd\.(loading|empty)»/);
  const off = { slashCands: null, slashLoading: false, slashFailed: false };
  assert.deepEqual(composerGlue({ text: '안녕 /보고', slashCrews: crews, freshCmds: null }), off);
  assert.deepEqual(composerGlue({ slashOff: '/', slashCrews: crews, freshCmds: null }), off, 'Esc로 닫은 글자에서는 다시 띄우지 않는다');
  assert.deepEqual(composerGlue({ rolePick: { role: 'to', list: [] }, slashCrews: crews, freshCmds: null }), off, '/to·/cc 목록과 겹치지 않는다');
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
  assert.deepEqual(sets, [{ ok: true, cmds: { p: LIST } }]);
  assert.deepEqual(eff.deps.length, 3, '열림·방·에이전트 집합이 바뀌면 다시 읽는다');

  const late = deferred(); const sets2 = []; const db2 = fakeDb(() => late.p);
  const eff2 = slashEffect({ slashOpen: true, slashIds: 'p', db: db2, setFreshCmds: (v) => sets2.push(v) });
  eff2.cleanup(); late.resolve({ data: [{ id: 'p', commands: LIST }], error: null }); await tick();
  assert.deepEqual(sets2, [], '팝업이 닫히거나 방이 바뀐 뒤 늦게 온 답은 넣지 않는다');

  const sets3 = []; const db3 = fakeDb(() => ({ data: null, error: { message: 'x' } }));
  slashEffect({ slashOpen: true, slashIds: 'p', db: db3, setFreshCmds: (v) => sets3.push(v) }); await tick();
  assert.deepEqual(sets3, [{ ok: false }], '실패하면 실패로 끝나 불러오는 중에서 벗어난다');

  const sets4 = []; const db4 = fakeDb(() => ({ data: [], error: null }));
  slashEffect({ slashOpen: false, slashIds: 'p', db: db4, setFreshCmds: (v) => sets4.push(v) });
  assert.deepEqual(sets4, [null], '팝업이 닫히면 비운다 — 다음에 열 때 다시 불러오는 중부터'); assert.equal(db4.calls.length, 0);
  const db5 = fakeDb(() => ({ data: [], error: null })); const sets5 = [];
  slashEffect({ slashOpen: true, slashIds: '', db: db5, setFreshCmds: (v) => sets5.push(v) }); await tick();
  assert.equal(db5.calls.length, 0, '읽을 에이전트가 없으면 요청하지 않는다'); assert.deepEqual(sets5, []);
});


// ── 검수 #892 MEDIUM-1: 불러오는 중 Enter ──
// App.jsx 입력창의 실제 onKey를 잘라 돌린다. 데스크톱은 Enter가 전송이라, 후보가 아직 비어 있는 '불러오는 중'에 /보고 + Enter가 그대로 전송됐다
// (main은 조직 행의 commands로 바로 pickSlash). send·pickSlash 호출과 기본 동작 막기를 본다.
function pressEnter({ text, slashCands, slashLoading = false, isMobilePlatform = false, shiftKey = false }) {
  const start = app.lastIndexOf('  const onKey = (e) => {', app.indexOf('if (slashCands?.length) {'));
  const end = app.indexOf('\n  };\n', start) + 5;
  assert.ok(start > 0 && end > start, '입력창 onKey를 찾지 못함');
  const calls = []; let prevented = false;
  const deps = { rolePick: null, slashCands, slashLoading, setSlashSel: () => {}, slashSel: 0, pickSlash: (c) => calls.push(['pickSlash', c.cmd]), setSlashOff: () => {}, text, pop: null, candidates: [], setSel: () => {}, sel: 0, pick: () => {}, setPop: () => {}, replyTo: null, delivery: {}, isMobilePlatform, send: () => calls.push(['send', text]), rsel: -1, pickRole: () => {}, setText: () => {} };
  const onKey = new Function(...Object.keys(deps), `${app.slice(start, end)}\n return onKey;`)(...Object.values(deps));
  onKey({ key: 'Enter', shiftKey, preventDefault: () => { prevented = true; } });
  return { calls, prevented };
}
const glueEnter = (text, freshCmds, extra = {}) => { const g = composerGlue({ text, slashCrews: [orgCrew('p', '페퍼')], freshCmds }); return pressEnter({ text, slashCands: g.slashCands, slashLoading: g.slashLoading, ...extra }); };

test('불러오는 중 Enter(데스크톱)는 보내지 않는다 — /보고 + Enter가 그대로 전송되던 회귀(검수 MEDIUM-1)', () => {
  for (const text of ['/보고', '/보', '/zzz']) {
    const r = glueEnter(text, null); // 재조회 응답 전
    assert.deepEqual(r.calls, [], `${text}: 불러오는 중에는 send도 pickSlash도 없다`);
    assert.equal(r.prevented, true, `${text}: Enter 기본 동작(전송)을 막는다`);
  }
  assert.deepEqual(glueEnter('/보고', null, { shiftKey: true }), { calls: [], prevented: false }, 'Shift+Enter는 줄바꿈 그대로(막지 않는다)');
});
test('다 읽은 뒤 Enter는 지금처럼 — 후보가 있으면 고르기, 없으면 보내기', () => {
  assert.deepEqual(glueEnter('/보고', { ok: true, cmds: { p: LIST } }).calls, [['pickSlash', '보고']], '읽은 뒤 /보고 + Enter = 선택');
  assert.deepEqual(glueEnter('/zzz', { ok: true, cmds: { p: LIST } }).calls, [['send', '/zzz']], '후보 없음 = 보내기(예전 그대로)');
  assert.deepEqual(glueEnter('/보고', { ok: true, cmds: {} }).calls, [['send', '/보고']], '읽었는데 명령이 없으면 보내기(예전 그대로)');
  assert.deepEqual(glueEnter('/보고', { ok: false }).calls, [['send', '/보고']], '실패 뒤 Enter는 다 읽은 뒤 후보 없음과 같다');
  assert.deepEqual(glueEnter('안녕', null).calls, [['send', '안녕']], '슬래시 글이 아니면 평소처럼 보낸다');
  assert.deepEqual(glueEnter('/t', null).calls, [['pickSlash', 'to']], '불러오는 중이어도 이미 있는 내장 명령은 고른다(후보가 있으면 예전 분기)');
});
test('폰(모바일 플랫폼)은 해당 없음 — Enter는 원래 보내지 않고, 불러오는 중에도 그 동작을 바꾸지 않는다', () => {
  assert.deepEqual(glueEnter('/보고', null, { isMobilePlatform: true }), { calls: [], prevented: false }, '폰: 전송도 없고 막지도 않는다(줄바꿈 입력 그대로)');
  assert.deepEqual(glueEnter('/보고', { ok: true, cmds: { p: LIST } }, { isMobilePlatform: true }).calls, [['pickSlash', '보고']], '폰: 하드웨어 키보드 Enter로 고르는 예전 분기는 그대로');
});

// ── 검수 #892 LOW-2: 응답이 오지 않을 때 시간 제한 ──
const hang = () => { const rec = { signal: null }; return { rec, from() { const api = { select: () => api, in: () => api, abortSignal(s) { rec.signal = s; return api; }, then() { /* 응답이 영영 안 온다 */ } }; return api; } }; };
test('LOW-2 응답이 오지 않으면 시간 제한 뒤 실패로 끝나 불러오는 중이 풀리고, 요청은 취소한다', async () => {
  assert.equal(slash.SLASH_READ_TIMEOUT_MS, 8000, '8초 — 같은 앱의 설정 조회(PROVIDER_SETTINGS_TIMEOUT_MS)·서버 statement_timeout(8초)과 같다');
  const h = hang(); const t0 = Date.now();
  const r = await slash.readSlashCommands(h, ['p'], { timeoutMs: 30 });
  assert.deepEqual(r, { ok: false }); assert.ok(Date.now() - t0 >= 25, '제한 시간까지는 기다린다');
  assert.equal(h.rec.signal.aborted, true, '시간이 지나면 요청을 취소한다(내려받던 것을 멈춘다)');
  // 신호를 무시하는 클라이언트(abortSignal 없음)여도 끝난다
  const ignoring = { from() { const api = { select: () => api, in: () => api, then() {} }; return api; } };
  assert.deepEqual(await slash.readSlashCommands(ignoring, ['p'], { timeoutMs: 30 }), { ok: false });
  const plain = { from() { const api = { select: () => api, in: () => api, then(res) { res({ data: [{ id: 'p', commands: LIST }], error: null }); } }; return api; } }; // abortSignal 없는 클라이언트(브라우저 픽스처의 가짜)도 정상 응답은 읽는다
  assert.deepEqual(await slash.readSlashCommands(plain, ['p'], { timeoutMs: 30 }), { ok: true, cmds: { p: LIST } });
  // 제때 온 응답은 취소하지 않고 타이머를 남기지 않는다
  let sig; const fast = { from() { const api = { select: () => api, in: () => api, abortSignal(s) { sig = s; return api; }, then(res) { res({ data: [{ id: 'p', commands: LIST }], error: null }); } }; return api; } };
  assert.deepEqual(await slash.readSlashCommands(fast, ['p'], { timeoutMs: 40 }), { ok: true, cmds: { p: LIST } });
  await new Promise((r2) => setTimeout(r2, 80)); assert.equal(sig.aborted, false, '응답이 온 뒤에는 취소 타이머가 남지 않는다');
});
test('LOW-2 실제 supabase-js 클라이언트에서도 — 멈춘 요청은 abortSignal로 끊기고 오류로 돌아온다(설치된 버전이 지원)', async () => {
  let sawSignal = false;
  const stuckFetch = (_url, init) => new Promise((_, reject) => { sawSignal = !!init?.signal; init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))); });
  const db = createClient('http://127.0.0.1:9', 'anon-key-test', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: stuckFetch } });
  assert.equal(typeof db.from('msgr_crews').select('id').abortSignal, 'function', '설치된 postgrest 빌더에 abortSignal이 있다');
  assert.deepEqual(await slash.readSlashCommands(db, ['p'], { timeoutMs: 40 }), { ok: false });
  assert.equal(sawSignal, true, '요청에 취소 신호가 실려 나간다');
});

// ── 검수 #892 LOW-1: 실패와 '명령 없음' 구분 ──
test('LOW-1 실패와 빈 결과를 구분한다 — 실제 supabase-js로 402·500·네트워크 예외·로그아웃 차단은 실패, 200 빈 목록은 명령 없음', async () => {
  const mk = (fetchImpl) => createClient('http://127.0.0.1:9', 'anon-key-test', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchImpl } });
  const json = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const failing = {
    '402 차단(JSON)': json(402, { message: 'Payment Required' }),
    '402 차단(텍스트)': async () => new Response('Payment Required', { status: 402 }),
    '500 statement timeout': json(500, { code: '57014', message: 'canceling statement due to statement timeout' }),
    '네트워크 예외': async () => { throw new TypeError('Failed to fetch'); },
    '로그아웃 차단(anon-guard)': guardAnonFetch({ anonKey: 'anon-key-test', hasStoredSession: () => true, fetchImpl: async () => new Response('[]', { status: 200 }) }),
  };
  for (const [name, f] of Object.entries(failing)) {
    const r = await slash.readSlashCommands(mk(f), ['p']);
    assert.deepEqual(r, { ok: false }, name);
    const v = slash.slashView('/', [orgCrew('p', '페퍼')], r, OPT);
    assert.deepEqual([v.loading, v.failed], [false, true], `${name}: 실패 안내`);
  }
  const empty = await slash.readSlashCommands(mk(json(200, [])), ['p']); // 권한이 없어 행이 안 보이는 경우 포함 — 오류가 아니다
  assert.deepEqual(empty, { ok: true, cmds: {} });
  const vEmpty = slash.slashView('/', [orgCrew('p', '페퍼')], empty, OPT);
  assert.deepEqual([vEmpty.loading, vEmpty.failed], [false, false], '읽었는데 비면 실패가 아니라 명령 없음');
  assert.deepEqual(await slash.readSlashCommands(mk(json(200, [{ id: 'p', commands: LIST }])), ['p']), { ok: true, cmds: { p: LIST } });
});

test('시간 초과까지 한 줄로 — 멈춘 재조회: 처음엔 불러오는 중(Enter 막힘) → 제한 시간 뒤 loading 풀림 + 실패 안내(Enter는 보내기)', async () => {
  const sets = []; const h = hang();
  const wrapped = (db, ids) => slash.readSlashCommands(db, ids, { timeoutMs: 40 }); // 실제 8초 대신 짧게 — effect 본문은 App.jsx 그대로
  const startMark = '  useEffect(() => {\n    if (!slashOpen)'; const endMark = '}, [slashOpen, chId, slashIds]);';
  const start = app.indexOf(startMark); const end = app.indexOf(endMark, start) + endMark.length;
  new Function('useEffect', 'slashOpen', 'slashIds', 'chId', 'supabase', 'readSlashCommands', 'setFreshCmds', app.slice(start, end))((f) => f(), true, 'p', 'ch', h, wrapped, (v) => sets.push(v));
  const during = composerGlue({ slashCrews: [orgCrew('p', '페퍼')], freshCmds: sets[0] ?? null });
  assert.deepEqual([during.slashLoading, during.slashFailed], [true, false]); assert.match(popupHtml(during), /«cmd\.loading»/);
  assert.deepEqual(glueEnter('/보고', null).calls, []);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(sets, [{ ok: false }], '제한 시간 뒤 실패로 정리');
  const after = composerGlue({ slashCrews: [orgCrew('p', '페퍼')], freshCmds: sets[0] });
  assert.deepEqual([after.slashLoading, after.slashFailed], [false, true]);
  assert.match(popupHtml(after), /«cmd\.loadFailed»/); assert.doesNotMatch(popupHtml(after), /«cmd\.(loading|empty)»/);
  assert.deepEqual(glueEnter('/보고', sets[0]).calls, [['send', '/보고']], '실패 뒤 Enter는 다 읽은 뒤 후보 없음과 같다');
});

test('새 문구 cmd.loading·cmd.loadFailed — 한국어·영어 모두 있고, 금지어(크루·사장)가 없다', () => {
  for (const key of ['cmd.loading', 'cmd.loadFailed']) {
    const pair = DICT[key]; assert.ok(Array.isArray(pair) && pair[0] && pair[1], `${key}: ko·en 둘 다 등록`);
    assert.doesNotMatch(pair.join(' '), /크루|사장|crew|boss/i, key);
    assert.match(pair[0], /[가-힣]/, key); assert.doesNotMatch(pair[1], /[가-힣]/, key);
  }
  assert.notEqual(DICT['cmd.loadFailed'][0], DICT['cmd.empty'][0], '실패 안내는 명령 없음 문구와 다르다');
});
