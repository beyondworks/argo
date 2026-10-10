// 하트비트(능동 비서) — 에이전트 카드 "하트비트" 탭(app/c/[ws]/crew/[slug]/assistant-section.jsx — 보기 전용, 유건 10/10)과 표시 판정(assistant-view.mjs).
// 켜기·끄기·값 바꾸기 테스트(U-a~U-f)는 관리 화면과 함께 test/heartbeat-card.test.mjs(루틴 → 내 하트비트)로 옮겼다.
// 경우 표: S2(상태 문구 — 로그인 필요·옛 버전·다른 회사·화면 밖 변경), U-a~U-e(켜기·바꾸기·끄기·값 저장·저장 실패). 화면 그림(S1)은 격리 dev 서버 스크린샷.
// 컴포넌트는 mini-react(test/helpers/mini-react.mjs) 위에서 실제 코드 그대로 돌린다 — fetch만 가짜(요청 기록·응답 주입).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const V = await import('../app/c/[ws]/crew/[slug]/assistant-view.mjs');
const { API_MSG } = await import('../app/apimsg.mjs');
const file = (p) => fileURLToPath(new URL(p, import.meta.url));

const WS = 'co'; const SLUG = 'pepper';
const baseView = (over = {}) => ({
  config: { enabled: false, agent: null, leadMinutes: 30, morningAt: '08:00', eveningAt: '21:00', quiet: { from: '23:00', to: '08:00', calendarAlerts: false }, tz: null },
  unsealed: false, current: null, choices: { lead: [10, 15, 30, 60] },
  status: { login: true, muted: false, runner: 'this_device', device: 'Geony-Mac-Pro', code: null, codeAt: 0, readAt: 0, instantToday: 0, dailyCap: 10 },
  ...over,
});
const mineView = (over = {}) => baseView({ config: { ...baseView().config, enabled: true, agent: SLUG }, current: { ws: WS, company: '비서 회사', agent: SLUG, name: '페퍼' }, ...over });

/* ── 표시 판정(순수) ── */

test('S2: 상태 문구 판정 — 로그인 필요·끈 목록·옛 버전·이 기기 엔진 오류는 비서인 에이전트 카드에, 화면 밖 변경·다른 회사는 해당 카드에', () => {
  const st = (s) => mineView({ status: { ...mineView().status, ...s } });
  assert.deepEqual(V.statusNotes(mineView(), WS, SLUG), [], '문제 없음');
  assert.deepEqual(V.statusNotes(st({ login: false }), WS, SLUG), ['login_required']);
  assert.deepEqual(V.statusNotes(st({ runner: 'runner_outdated' }), WS, SLUG), ['runner_outdated']);
  assert.deepEqual(V.statusNotes(st({ muted: true }), WS, SLUG), ['muted']);
  assert.deepEqual(V.statusNotes(st({ code: 'calendar_error' }), WS, SLUG), ['calendar_error']);
  assert.deepEqual(V.statusNotes(st({ code: 'calendar_error', runner: 'other_device' }), WS, SLUG), [], '상태 파일은 기기 로컬 — 실행 기기가 다른 기기면 이 기기의 옛 코드를 보이지 않는다');
  assert.deepEqual(V.statusNotes(st({ code: 'login_required', login: true }), WS, SLUG), [], '로그인은 지금 값으로 다시 판정(상태 파일의 옛 코드 무시)');
  // 로그인 판정은 이 기기의 기기 세션 — 다른 기기·옛 버전 기기가 실행 중이면 이 기기의 로그인 문구를 보이지 않는다
  assert.deepEqual(V.statusNotes(st({ login: false, runner: 'other_device' }), WS, SLUG), [], '실행 기기가 다른 기기');
  assert.deepEqual(V.statusNotes(st({ login: false, runner: 'runner_outdated' }), WS, SLUG), ['runner_outdated'], '실행 기기가 옛 버전 — 업데이트 안내만');
  assert.deepEqual(V.statusNotes(st({ login: false, runner: 'no_runner' }), WS, SLUG), ['login_required'], '실행 중인 기기가 없음 — 이 기기가 맡으려면 로그인이 필요하다');
  assert.deepEqual(V.statusNotes(mineView(), WS, 'wolff'), [], '비서가 아닌 에이전트 카드에는 비서 상태를 보이지 않는다');
  // 이 회사 설정은 이 에이전트로 켜져 있지만 다른 회사의 비서가 맡음(두 기기에서 거의 같은 때 켬)
  const waiting = baseView({ config: { ...baseView().config, enabled: true, agent: SLUG }, current: { ws: 'co-b', company: '회사 B', agent: 'wolff', name: '울프' } });
  assert.deepEqual(V.assistantRole(waiting, WS, SLUG), { mine: false, other: waiting.current, waiting: true });
  assert.deepEqual(V.statusNotes(waiting, WS, SLUG), ['other_company']);
  assert.deepEqual(V.statusNotes(baseView({ unsealed: true }), WS, SLUG), ['unsealed'], '설정 파일이 화면 밖에서 바뀜');
});

test('시각 선택지 — 30분 간격 48개, 칸 밖 저장값은 선택지에 더한다', () => {
  assert.equal(V.HALF_HOURS.length, 48);
  assert.deepEqual([V.HALF_HOURS[0], V.HALF_HOURS[17], V.HALF_HOURS[47]], ['00:00', '08:30', '23:30']);
  assert.equal(V.timeChoices('21:00'), V.HALF_HOURS);
  assert.ok(V.timeChoices('08:15').includes('08:15'));
});

/* ── 컴포넌트(보기 전용) ── */

const { loadComponent } = await import('./helpers/load-component.mjs');
const { mount } = await import('./helpers/mini-react.mjs');
const pushed = [];
const stubs = {
  '../../../../ui': 'export const Skeleton = () => null;',
  '../../../../i18n': "export const useLang = () => ({ lang: 'ko', t: (k, v) => (v ? k + '|' + JSON.stringify(v) : k) }); export const fmtMsgTime = (lang, ts) => 'T' + ts;",
  'next/navigation': 'export const useRouter = () => ({ push: (h) => globalThis.__hbPushed.push(h) });',
};
globalThis.__hbPushed = pushed;
const SEC = await loadComponent(file('../app/c/[ws]/crew/[slug]/assistant-section.jsx'), {
  stubs, real: [file('../app/apimsg.mjs'), file('../app/c/[ws]/crew/[slug]/assistant-view.mjs'), file('../app/c/[ws]/split.mjs')],
});
const { AssistantSection } = SEC;
const find = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.props) find(node.props.children, pred, out);
  return out;
};
const byTest = (out, id) => find(out, (n) => n.props['data-testid'] === id)[0];
const text = (node) => { const acc = []; const walk = (n) => { if (n == null || n === false) return; if (typeof n === 'string' || typeof n === 'number') { acc.push(String(n)); return; } if (Array.isArray(n)) { n.forEach(walk); return; } if (n.props) walk(n.props.children); }; walk(node); return acc.join(' '); };

function fakeFetch(view) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => { calls.push({ url, method: opts.method ?? 'GET' }); return { ok: true, status: 200, json: async () => view }; };
  return calls;
}
async function render(view, slug = SLUG) {
  const calls = fakeFetch(view);
  const m = mount(AssistantSection, { ws: WS, slug });
  await m.flush();
  return { m, calls, out: () => m.state.out };
}
const controls = (out) => find(out, (n) => ['select', 'input'].includes(n.type) || (n.type === 'button' && n.props['data-testid'] !== 'assistant-manage'));

test('V1: 이 에이전트가 하트비트 — 켜짐·확인 주기·알림 설정 요약·메일·실행 기기·마지막 확인·오늘 보낸 알림/한도. 고르는 칸·켜기/끄기 버튼은 없고 GET 1번뿐', async () => {
  const v = mineView({ config: { ...mineView().config, intervalMinutes: 30, mail: 'shadow', calendar: true, agentName: '페퍼' }, status: { ...mineView().status, readAt: 7, instantToday: 2, mail: { code: 'ok', checkedAt: 9, shadow: { days: 1, total: 3 } } } });
  const { calls, out } = await render(v);
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
  assert.equal(text(byTest(out(), 'assistant-state')), 'assistant.on');
  assert.equal(text(byTest(out(), 'assistant-line')), 'assistant.card.mine');
  assert.equal(text(byTest(out(), 'assistant-interval')), 'assistant.intervalOpt|{"n":30}');
  const all = text(out());
  for (const k of ['assistant.watchCalendar', 'assistant.mail (assistant.hb.previewShort)', 'assistant.leadOpt|{"n":30}', '21:00', '23:00 ~ 08:00', '페퍼', 'assistant.destPersonal', 'assistant.runnerHere|{"device":"Geony-Mac-Pro"}', 'T7', 'assistant.todayUnder|{"n":2,"cap":10}', 'T9 · assistant.mailShadow|{"days":1,"n":3}', 'assistant.card.viewOnly']) assert.ok(all.includes(k), k);
  assert.deepEqual(controls(out()), [], '보기 전용 — 고르는 칸·켜기/끄기 버튼 없음');
  assert.ok(byTest(out(), 'assistant-manage'), '루틴에서 관리');
});

test('V2: 다른 에이전트·다른 회사가 맡음 — "지금 하트비트: 회사 · 이름" + 루틴에서 관리, 요약·상태 칸 없음', async () => {
  const { out } = await render(baseView({ current: { ws: 'co-b', company: '회사 B', agent: 'wolff', name: '울프' } }));
  assert.equal(text(byTest(out(), 'assistant-line')), 'assistant.current|{"company":"회사 B","name":"울프"}');
  assert.equal(byTest(out(), 'assistant-summary'), undefined);
  assert.equal(byTest(out(), 'assistant-runner'), undefined);
  assert.ok(byTest(out(), 'assistant-manage'));
  const same = await render(mineView(), 'wolff');
  assert.equal(text(byTest(same.out(), 'assistant-line')), 'assistant.current|{"company":"비서 회사","name":"페퍼"}', '같은 회사의 다른 에이전트가 맡음');
});

test('V3·V4: 꺼 둠(설정 남음)·없음 — 꺼 둔 담당이면 설정 요약, 아니면 꺼짐 한 줄', async () => {
  const paused = baseView({ config: { ...baseView().config, enabled: false, agent: SLUG, agentName: '페퍼', intervalMinutes: 60 } });
  const p = await render(paused);
  assert.equal(text(byTest(p.out(), 'assistant-state')), 'assistant.off');
  assert.equal(text(byTest(p.out(), 'assistant-line')), 'assistant.card.paused|{"name":"페퍼"}');
  assert.equal(text(byTest(p.out(), 'assistant-interval')), 'assistant.intervalOpt|{"n":60}');
  assert.equal(byTest(p.out(), 'assistant-runner'), undefined, '꺼 둔 동안 상태 칸 없음');
  const other = await render(paused, 'wolff');
  assert.equal(byTest(other.out(), 'assistant-summary'), undefined, '다른 에이전트 카드에는 요약 없음');
  const n = await render(baseView());
  assert.equal(text(byTest(n.out(), 'assistant-line')), 'assistant.card.none');
  assert.equal(byTest(n.out(), 'assistant-summary'), undefined);
});

test('V5: 루틴에서 관리 — /c/[ws]/routines#heartbeat로, 열어 둔 보조 패널(?side=)은 그대로', async () => {
  assert.equal(SEC.manageHref('co', '?side=crew:pepper'), '/c/co/routines?side=crew%3Apepper#heartbeat');
  assert.equal(SEC.manageHref('co', ''), '/c/co/routines#heartbeat');
  const { out } = await render(mineView());
  pushed.length = 0;
  globalThis.window = { location: { search: '?side=crew:pepper' } };
  try { byTest(out(), 'assistant-manage').props.onClick(); } finally { delete globalThis.window; }
  assert.deepEqual(pushed, ['/c/co/routines?side=crew%3Apepper#heartbeat']);
});

test('K6·S2(카드): 오늘 보낸 알림 수·상태 문구 — 정확히 한도·넘음·확인 중·다른 기기, 로그인·옛 버전·화면 밖 변경', async () => {
  const today = async (st) => text(byTest((await render(mineView({ status: { ...mineView().status, ...st } }))).out(), 'assistant-today'));
  assert.equal(await today({ instantToday: 10, dailyCap: 10 }), 'assistant.todayUnder|{"n":10,"cap":10}');
  assert.equal(await today({ instantToday: 11, dailyCap: 10 }), 'assistant.todayOver|{"n":11,"cap":10}');
  assert.equal(await today({ instantToday: 3, instantSure: false }), 'assistant.todayUnsure|{"n":3}');
  assert.equal(await today({ runner: 'other_device' }), 'assistant.onRunner');
  const notes = async (v) => find((await render(v)).out(), (n) => n.props['data-note']).map((n) => text(n));
  assert.deepEqual(await notes(mineView({ status: { ...mineView().status, login: false } })), ['assistant.st.login_required']);
  assert.deepEqual(await notes(mineView({ status: { ...mineView().status, login: false, runner: 'runner_outdated' } })), ['assistant.st.runner_outdated']);
  assert.deepEqual(await notes(baseView({ unsealed: true })), ['assistant.st.unsealed']);
});

test('보기 전용 — 카드 탭 소스에 쓰기 요청(PUT·DELETE)이 없다', () => {
  const src = readFileSync(file('../app/c/[ws]/crew/[slug]/assistant-section.jsx'), 'utf8');
  assert.doesNotMatch(src, /method:\s*'(PUT|DELETE|POST)'/);
});

test('i18n — 비서 탭 문구는 ko/en 둘 다 있고 한국어는 한글(고유명사 Argo 제외)', () => {
  const src = readFileSync(file('../app/i18n.jsx'), 'utf8');
  const keys = [...src.matchAll(/^\s*'(assistant\.[^']+|chat\.card\.tab\.assistant)':\s*\[('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"),\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\]/gm)];
  assert.ok(keys.length >= 40, `키 ${keys.length}개`);
  const used = new Set(['../app/c/[ws]/crew/[slug]/assistant-section.jsx', '../app/c/[ws]/routines/heartbeat-card.jsx', '../app/c/[ws]/crew/[slug]/assistant-view.mjs'].flatMap((f) => [...readFileSync(file(f), 'utf8').matchAll(/\bt\('([^']+)'/g)].map((x) => x[1])));
  const have = new Set(keys.map((k) => k[1]));
  for (const k of used) assert.ok(have.has(k), `사전에 ${k}`);
  for (const [, k, ko, en] of keys) {
    assert.ok(ko.length > 2 && en.length > 2, k);
    if (!/^'\{n\}건'$/.test(ko)) assert.match(ko, /[가-힣]/, `${k} 한국어`);
    assert.doesNotMatch(ko.replace(/Argo/g, '').replace(/\{[a-z]+\}/g, ''), /[A-Za-z]{2,}/, `${k} 한국어 모드에 영어 낱말 없음`);
  }
});

