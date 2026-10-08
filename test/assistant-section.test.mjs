// 능동 비서 2단계 — 에이전트 카드 "비서" 탭(app/c/[ws]/crew/[slug]/assistant-section.jsx)과 표시 판정(assistant-view.mjs).
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
  status: { login: true, muted: false, runner: 'this_device', device: 'Geony-Mac-Pro', code: null, codeAt: 0, readAt: 0, instantToday: 0 },
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

/* ── 컴포넌트 ── */

const { loadComponent } = await import('./helpers/load-component.mjs');
const { mount } = await import('./helpers/mini-react.mjs');
const stubs = {
  '../../../../ui': 'export const Skeleton = () => null; export const Spinner = () => null;',
  '../../../../i18n': "export const useLang = () => ({ lang: 'ko', t: (k, v) => (v ? k + '|' + JSON.stringify(v) : k) }); export const fmtMsgTime = (lang, ts) => 'T' + ts;",
};
const { AssistantSection } = await loadComponent(file('../app/c/[ws]/crew/[slug]/assistant-section.jsx'), {
  stubs, real: [file('../app/apimsg.mjs'), file('../app/c/[ws]/crew/[slug]/assistant-view.mjs')],
});
const find = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.props) find(node.props.children, pred, out);
  return out;
};
const byTest = (out, id) => find(out, (n) => n.props['data-testid'] === id)[0];
const text = (node) => { const acc = []; const walk = (n) => { if (n == null || n === false) return; if (typeof n === 'string' || typeof n === 'number') { acc.push(String(n)); return; } if (Array.isArray(n)) { n.forEach(walk); return; } if (n.props) walk(n.props.children); }; walk(node); return acc.join(' '); };

/** fetch 가짜 — GET은 view, PUT은 reply(body) 결과. 요청을 기록한다. */
function fakeFetch(view, reply) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method, body });
    const r = method === 'GET' ? { status: 200, data: view } : reply(body);
    return { ok: r.status < 400, status: r.status, json: async () => r.data };
  };
  return calls;
}
async function render(view, reply = () => ({ status: 200, data: view })) {
  const calls = fakeFetch(view, reply);
  const m = mount(AssistantSection, { ws: WS, slug: SLUG });
  await m.flush();
  return { m, calls, out: () => m.state.out };
}

test('U-a: 꺼짐 — 켜기 버튼 → PUT {enabled:true, agent, tz}, 응답(보기)으로 켜짐·설정 칸·상태가 그려진다. 탭을 열 때 GET 1번, 주기 호출 없음', async () => {
  const { m, calls, out } = await render(baseView(), () => ({ status: 200, data: mineView() }));
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', '/api/companies/co/assistant']]);
  assert.equal(text(byTest(out(), 'assistant-state')), 'assistant.off');
  assert.equal(byTest(out(), 'assistant-lead'), undefined, '꺼진 동안은 설정 칸을 보이지 않는다(가장 단순하게)');
  byTest(out(), 'assistant-on').props.onClick();
  await m.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].body.enabled, true);
  assert.equal(calls[1].body.agent, SLUG);
  assert.ok('tz' in calls[1].body, '처음 켤 때 화면 시간대를 보낸다');
  assert.equal(text(byTest(out(), 'assistant-state')), 'assistant.on');
  assert.ok(byTest(out(), 'assistant-lead'), '켜지면 설정 칸');
  assert.ok(byTest(out(), 'assistant-off'));
  const all = text(out());
  for (const k of ['assistant.watchCalendar', 'assistant.destPersonal', 'assistant.permNotify', 'assistant.runnerHere|{"device":"Geony-Mac-Pro"}', 'assistant.lastCheckNone', 'assistant.todayN|{"n":0}']) assert.ok(all.includes(k), k);
  await new Promise((r) => setTimeout(r, 30));
  await m.flush();
  assert.equal(calls.length, 2, '그 뒤 저절로 다시 읽지 않는다');
});

test('U-b: 다른 비서가 있음 — "지금 비서: 회사 · 이름" + 바꾸기 → PUT {enabled:true, agent}', async () => {
  const other = baseView({ current: { ws: 'co-b', company: '회사 B', agent: 'wolff', name: '울프' } });
  const { m, calls, out } = await render(other, () => ({ status: 200, data: mineView() }));
  assert.equal(byTest(out(), 'assistant-on'), undefined, '켜기 대신 바꾸기');
  assert.ok(text(out()).includes('assistant.current|{"company":"회사 B","name":"울프"}'));
  assert.ok(text(out()).includes('assistant.switchHint'));
  byTest(out(), 'assistant-switch').props.onClick();
  await m.flush();
  assert.deepEqual([calls[1].method, calls[1].body.enabled, calls[1].body.agent], ['PUT', true, SLUG]);
  assert.equal(text(byTest(out(), 'assistant-state')), 'assistant.on');
});

test('U-c: 비서 상태 문구(S2) — 로그인 필요·옛 버전 실행 기기·화면 밖 변경이 사전 키로 그려진다', async () => {
  const v = mineView({ unsealed: false, status: { ...mineView().status, login: false, runner: 'runner_outdated', device: 'Old-Mac' } });
  const { out } = await render(v);
  const notes = find(out(), (n) => n.props['data-note']).map((n) => [n.props['data-note'], text(n)]);
  assert.deepEqual(notes, [['login_required', 'assistant.st.login_required'], ['runner_outdated', 'assistant.st.runner_outdated']]);
  assert.equal(text(byTest(out(), 'assistant-runner')), 'assistant.runnerOld|{"device":"Old-Mac"}');
  assert.ok(text(out()).includes('assistant.onRunner'), '실행 기기가 이 기기가 아니면 마지막 확인은 그 기기에서');
  const r2 = await render(baseView({ unsealed: true }));
  assert.deepEqual(find(r2.out(), (n) => n.props['data-note']).map((n) => text(n)), ['assistant.st.unsealed']);
  assert.ok(byTest(r2.out(), 'assistant-on'), '다시 켜기로 새로 봉인');
  const r3 = await render(baseView({ config: { ...baseView().config, enabled: true, agent: SLUG }, current: { ws: 'co-b', company: '회사 B', agent: 'wolff', name: '울프' } }));
  assert.deepEqual(find(r3.out(), (n) => n.props['data-note']).map((n) => text(n)), ['assistant.st.other_company']);
});

test('U-d: 값 바꾸기 — 칸마다 바로 저장(바뀐 칸만), 끄기 → PUT {enabled:false}', async () => {
  const replies = [];
  const { m, calls, out } = await render(mineView(), (body) => { replies.push(body); const v = mineView(); if (body.leadMinutes) v.config.leadMinutes = body.leadMinutes; return { status: 200, data: v }; });
  byTest(out(), 'assistant-lead').props.onChange({ target: { value: '15' } });
  await m.flush();
  assert.equal(byTest(out(), 'assistant-lead').props.value, 15);
  byTest(out(), 'assistant-evening').props.onChange({ target: { value: '20:30' } }); await m.flush();
  byTest(out(), 'assistant-quiet-from').props.onChange({ target: { value: '22:00' } }); await m.flush();
  byTest(out(), 'assistant-quiet-to').props.onChange({ target: { value: '07:00' } }); await m.flush();
  byTest(out(), 'assistant-quiet-alerts').props.onChange({ target: { checked: true } }); await m.flush();
  byTest(out(), 'assistant-off').props.onClick(); await m.flush();
  assert.deepEqual(calls.slice(1).map((c) => c.body), [
    { leadMinutes: 15 }, { eveningAt: '20:30' }, { quiet: { from: '22:00' } }, { quiet: { to: '07:00' } }, { quiet: { calendarAlerts: true } }, { enabled: false },
  ]);
  assert.ok(calls.slice(1).every((c) => c.method === 'PUT'));
});

test('U-e: 저장 실패 — 서버 문구(errorCode → API_MSG, 화면 언어)를 보이고 보기는 그대로(고른 값이 저장 전 값으로 돌아간다)', async () => {
  const { m, out } = await render(mineView(), () => ({ status: 400, data: { error: 'x', errorCode: 'assistant_evening_in_quiet' } }));
  byTest(out(), 'assistant-evening').props.onChange({ target: { value: '23:30' } });
  await m.flush();
  const alert = find(out(), (n) => n.props.role === 'alert')[0];
  assert.equal(text(alert), API_MSG.assistant_evening_in_quiet.ko);
  assert.equal(byTest(out(), 'assistant-evening').props.value, '21:00');
});

test('i18n — 비서 탭 문구는 ko/en 둘 다 있고 한국어는 한글(고유명사 Argo 제외)', () => {
  const src = readFileSync(file('../app/i18n.jsx'), 'utf8');
  const keys = [...src.matchAll(/^\s*'(assistant\.[^']+|chat\.card\.tab\.assistant)':\s*\[('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"),\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\]/gm)];
  assert.ok(keys.length >= 40, `키 ${keys.length}개`);
  const used = new Set([...readFileSync(file('../app/c/[ws]/crew/[slug]/assistant-section.jsx'), 'utf8').matchAll(/\bt\('([^']+)'/g)].map((x) => x[1]));
  const have = new Set(keys.map((k) => k[1]));
  for (const k of used) assert.ok(have.has(k), `사전에 ${k}`);
  for (const [, k, ko, en] of keys) {
    assert.ok(ko.length > 2 && en.length > 2, k);
    if (!/^'\{n\}건'$/.test(ko)) assert.match(ko, /[가-힣]/, `${k} 한국어`);
    assert.doesNotMatch(ko.replace(/Argo/g, '').replace(/\{[a-z]+\}/g, ''), /[A-Za-z]{2,}/, `${k} 한국어 모드에 영어 낱말 없음`);
  }
});
