// 하트비트 관리 → 루틴 화면(유건 10/10) — 루틴 화면 하트비트 칸(app/c/[ws]/routines/heartbeat-card.jsx).
// 경우 표(PR 본문): 없음 → 만들기, 다른 회사가 맡음 → 이 회사에서 만들기, 켜짐 → 일시 정지·확인 주기·값·담당 바꾸기·메일·끄기(확인 창), 일시 정지 → 다시 켜기·담당만 바꾸기.
// 컴포넌트는 mini-react(test/helpers/mini-react.mjs) 위에서 실제 코드 그대로 돌린다 — fetch만 가짜(요청 기록·응답 주입).
// (이 파일의 U-a~U-f는 예전 카드 탭 테스트(assistant-section.test.mjs)에서 관리 화면과 함께 옮겨 왔다.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { API_MSG } = await import('../app/apimsg.mjs');
const file = (p) => fileURLToPath(new URL(p, import.meta.url));

const WS = 'co'; const SLUG = 'pepper';
const AGENTS = [{ slug: 'pepper', name: '페퍼', role: '비서' }, { slug: 'wolff', name: '울프', role: '영업' }];
const baseView = (over = {}) => ({
  config: { enabled: false, agent: null, agentName: null, intervalMinutes: 15, leadMinutes: 30, morningAt: '08:00', eveningAt: '21:00', quiet: { from: '23:00', to: '08:00', calendarAlerts: false }, tz: null, mail: 'off' },
  unsealed: false, current: null, choices: { lead: [10, 15, 30, 60], interval: [10, 15, 30, 60] },
  status: { login: true, muted: false, runner: 'this_device', device: 'Geony-Mac-Pro', code: null, codeAt: 0, readAt: 0, instantToday: 0, dailyCap: 10 },
  ...over,
});
const mineView = (over = {}) => baseView({ config: { ...baseView().config, enabled: true, agent: SLUG, agentName: '페퍼' }, current: { ws: WS, company: '하트비트 회사', agent: SLUG, name: '페퍼' }, ...over });
const pausedView = (over = {}) => baseView({ config: { ...baseView().config, enabled: false, agent: SLUG, agentName: '페퍼', intervalMinutes: 30, leadMinutes: 15 }, ...over });

const { loadComponent } = await import('./helpers/load-component.mjs');
const { mount } = await import('./helpers/mini-react.mjs');
const stubs = {
  '../../../ui': 'export const Icon = () => null; export const Skeleton = () => null; export const Spinner = () => null; export const ConfirmModal = () => null;',
  '../../../i18n': "export const useLang = () => ({ lang: 'ko', t: (k, v) => (v ? k + '|' + JSON.stringify(v) : k) }); export const fmtMsgTime = (lang, ts) => 'T' + ts;",
};
const { HeartbeatCard } = await loadComponent(file('../app/c/[ws]/routines/heartbeat-card.jsx'), {
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
const modal = (out) => find(out, (n) => typeof n.props.onConfirm === 'function')[0];

function fakeFetch(view, reply) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method, body });
    const r = method === 'GET' ? { status: 200, data: view } : reply(body, method);
    return { ok: r.status < 400, status: r.status, json: async () => r.data };
  };
  return calls;
}
async function render(view, reply = () => ({ status: 200, data: view }), props = {}) {
  const calls = fakeFetch(view, reply);
  const m = mount(HeartbeatCard, { ws: WS, agents: AGENTS, agentsLoaded: true, ...props });
  await m.flush();
  return { m, calls, out: () => m.state.out };
}

test('U-a: 없음 — 한 화면에서 고른 값은 화면에만 있다가, 스위치를 켤 때 PUT 1번(담당·일정·메일·주기·알림 시각·방해 금지)으로 저장. 화면을 열 때 GET 1번, 주기 호출 없음', async () => {
  const { m, calls, out } = await render(baseView(), () => ({ status: 200, data: mineView() }));
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', '/api/companies/co/assistant']]);
  assert.equal(text(byTest(out(), 'assistant-state')), 'assistant.off');
  assert.equal(byTest(out(), 'assistant-switch').props['aria-checked'], false);
  assert.equal(text(byTest(out(), 'assistant-line')), 'assistant.hb.stNone');
  for (const id of ['assistant-what', 'assistant-when', 'assistant-quiet', 'assistant-often', 'assistant-who', 'assistant-chat-hint', 'assistant-advanced']) assert.ok(byTest(out(), id), id);
  assert.equal(byTest(out(), 'assistant-agent').props.value, 'pepper', '첫 에이전트');
  assert.equal(byTest(out(), 'assistant-interval').props.value, 15, '확인 주기 기본 15분');
  byTest(out(), 'assistant-agent').props.onChange({ target: { value: 'wolff' } }); await m.flush();
  byTest(out(), 'assistant-interval').props.onChange({ target: { value: '30' } }); await m.flush();
  byTest(out(), 'assistant-lead').props.onChange({ target: { value: '10' } }); await m.flush();
  byTest(out(), 'assistant-mail').props.onChange({ target: { checked: true } }); await m.flush();
  byTest(out(), 'assistant-quiet-alerts').props.onChange({ target: { checked: true } }); await m.flush();
  assert.equal(calls.length, 1, '설정이 없는 동안 고르는 것은 저장하지 않는다');
  assert.equal(byTest(out(), 'assistant-interval').props.value, 30, '고른 값이 화면에 남는다');
  byTest(out(), 'assistant-switch').props.onClick(); await m.flush();
  assert.equal(calls.length, 2);
  const b = calls[1].body;
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual([b.enabled, b.agent, b.calendar, b.mail, b.intervalMinutes, b.leadMinutes, b.eveningAt, b.quiet], [true, 'wolff', true, true, 30, 10, '21:00', { from: '23:00', to: '08:00', calendarAlerts: true }]);
  assert.ok('tz' in b, '켤 때 화면 시간대를 보낸다');
  assert.equal(text(byTest(out(), 'assistant-state')), 'assistant.on');
  assert.equal(byTest(out(), 'assistant-switch').props['aria-checked'], true);
  await new Promise((r) => setTimeout(r, 30)); await m.flush();
  assert.equal(calls.length, 2, '그 뒤 저절로 다시 읽지 않는다');
});

test('U-a2: 에이전트가 없으면 스위치를 켤 수 없고 안내가 보인다', async () => {
  const { out } = await render(baseView(), undefined, { agents: [] });
  assert.equal(byTest(out(), 'assistant-switch').props.disabled, true);
  assert.ok(text(out()).includes('assistant.hb.noAgents'));
});

test('U-b: 다른 회사가 맡음 — "지금 하트비트: 회사 · 이름" + 켜면 그쪽은 꺼진다는 안내(assistant.switchHint 그대로), 이 회사의 꺼 둔 설정으로 켠다', async () => {
  const other = pausedView({ current: { ws: 'co-b', company: '회사 B', agent: 'wolff', name: '울프' } });
  const { m, calls, out } = await render(other, () => ({ status: 200, data: mineView() }));
  assert.equal(text(byTest(out(), 'assistant-line')), 'assistant.current|{"company":"회사 B","name":"울프"}');
  assert.ok(text(out()).includes('assistant.switchHint'));
  assert.deepEqual([byTest(out(), 'assistant-agent').props.value, byTest(out(), 'assistant-interval').props.value, byTest(out(), 'assistant-lead').props.value], ['pepper', 30, 15], '남은 설정');
  byTest(out(), 'assistant-switch').props.onClick(); await m.flush();
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual([calls[1].body.enabled, calls[1].body.agent], [true, SLUG]);
  assert.equal(text(byTest(out(), 'assistant-state')), 'assistant.on');
});

test('U-c: 상태 문구(S2) — 회사 기준: 로그인 필요·끈 목록·옛 버전 실행 기기·화면 밖 변경·다른 회사', async () => {
  const notesOf = async (v) => find((await render(v)).out(), (n) => n.props['data-note']).map((n) => [n.props['data-note'], text(n)]);
  assert.deepEqual(await notesOf(mineView({ status: { ...mineView().status, login: false, muted: true } })),
    [['login_required', 'assistant.st.login_required'], ['muted', 'assistant.st.muted']]);
  assert.deepEqual(await notesOf(mineView({ status: { ...mineView().status, login: false, runner: 'runner_outdated', device: 'Old-Mac' } })), [['runner_outdated', 'assistant.st.runner_outdated']]);
  assert.deepEqual(await notesOf(baseView({ unsealed: true })), [['unsealed', 'assistant.st.unsealed']]);
  assert.deepEqual(await notesOf(baseView({ config: { ...baseView().config, enabled: true, agent: SLUG }, current: { ws: 'co-b', company: '회사 B', agent: 'wolff', name: '울프' } })), [['other_company', 'assistant.st.other_company']]);
  const r = await render(mineView({ status: { ...mineView().status, runner: 'runner_outdated', device: 'Old-Mac' } }));
  assert.equal(text(byTest(r.out(), 'assistant-runner')), 'assistant.runnerOld|{"device":"Old-Mac"}', '실행 기기는 고급에');
  assert.ok(text(byTest(r.out(), 'assistant-line')).includes('assistant.onRunner'), '실행 기기가 이 기기가 아니면 마지막 확인은 그 기기에서');
});

test('U-d: 켜짐 — 칸마다 바로 저장(바뀐 칸만): 주기·일정 알림·아침 정리·요약·방해 금지·예외·일정·담당, 스위치 끄기 = PUT {enabled:false}(설정 남김)', async () => {
  const { m, calls, out } = await render(mineView({ config: { ...mineView().config, mail: 'live' } }), (body) => { const v = mineView({ config: { ...mineView().config, mail: 'live' } }); if (body.leadMinutes) v.config.leadMinutes = body.leadMinutes; if (body.intervalMinutes) v.config.intervalMinutes = body.intervalMinutes; return { status: 200, data: v }; });
  byTest(out(), 'assistant-interval').props.onChange({ target: { value: '60' } }); await m.flush();
  assert.equal(byTest(out(), 'assistant-interval').props.value, 60);
  byTest(out(), 'assistant-lead').props.onChange({ target: { value: '15' } }); await m.flush();
  byTest(out(), 'assistant-quiet-to').props.onChange({ target: { value: '07:00' } }); await m.flush();
  byTest(out(), 'assistant-evening').props.onChange({ target: { value: '20:30' } }); await m.flush();
  byTest(out(), 'assistant-quiet-from').props.onChange({ target: { value: '22:00' } }); await m.flush();
  byTest(out(), 'assistant-quiet-alerts').props.onChange({ target: { checked: true } }); await m.flush();
  byTest(out(), 'assistant-calendar').props.onChange({ target: { checked: false } }); await m.flush();
  byTest(out(), 'assistant-agent').props.onChange({ target: { value: 'wolff' } }); await m.flush();
  byTest(out(), 'assistant-switch').props.onClick(); await m.flush();
  const bodies = calls.slice(1).map((c) => { const { tz, ...rest } = c.body; return rest; });
  assert.deepEqual(bodies, [
    { intervalMinutes: 60 }, { leadMinutes: 15 }, { quiet: { to: '07:00' } }, { eveningAt: '20:30' }, { quiet: { from: '22:00' } }, { quiet: { calendarAlerts: true } },
    { calendar: false }, { enabled: true, agent: 'wolff' }, { enabled: false },
  ]);
  assert.ok('tz' in calls[8].body, '켜진 채 담당을 바꾸면 지금처럼 켜기(바꾸기) — 화면 시간대');
  assert.ok(calls.slice(1).every((c) => c.method === 'PUT'));
});

test('U-d2: 꺼 둠 — 스위치 켜기 = PUT {enabled:true, agent}, 담당만 바꾸기 = PUT {agent}(켜지 않는다), 일정·메일 중 하나는 남긴다', async () => {
  const { m, calls, out } = await render(pausedView(), (body) => ({ status: 200, data: body.enabled ? mineView() : pausedView({ config: { ...pausedView().config, agent: body.agent ?? SLUG } }) }));
  assert.equal(text(byTest(out(), 'assistant-state')), 'assistant.off');
  assert.equal(text(byTest(out(), 'assistant-line')), 'assistant.hb.stPaused');
  assert.equal(byTest(out(), 'assistant-runner'), undefined, '꺼 둔 동안은 실행 기기 줄이 없다');
  assert.equal(byTest(out(), 'assistant-interval').props.value, 30, '남은 설정 그대로');
  assert.equal(byTest(out(), 'assistant-calendar').props.disabled, true, '메일을 안 볼 때 일정은 끌 수 없다(볼 것 0이 되지 않게)');
  byTest(out(), 'assistant-agent').props.onChange({ target: { value: 'wolff' } }); await m.flush();
  assert.deepEqual(calls[1].body, { agent: 'wolff' });
  assert.equal(text(byTest(out(), 'assistant-state')), 'assistant.off', '담당만 바꾸면 꺼진 채');
  byTest(out(), 'assistant-switch').props.onClick(); await m.flush();
  assert.deepEqual([calls[2].body.enabled, calls[2].body.agent], [true, 'wolff']);
  assert.equal(text(byTest(out(), 'assistant-state')), 'assistant.on');
});

test('U-h: 담당이 해고됨(분리 검수 M2) — 저장된 담당을 그대로 "(지금 없는 에이전트)"로 보이고 멈춤 안내, 다른 에이전트를 고르면 바로 바뀐다. 꺼 둔 채면 스위치로 켜지 않는다', async () => {
  const gone = (c) => ({ ...c, agent: 'ghost', agentName: '유령' });
  const on = mineView({ config: gone(mineView().config), current: { ws: WS, company: '하트비트 회사', agent: 'ghost', name: '유령' } });
  const r = await render(on, () => ({ status: 200, data: mineView() }));
  assert.equal(byTest(r.out(), 'assistant-agent').props.value, 'ghost', '첫 에이전트로 바꿔 보이지 않는다');
  assert.ok(text(byTest(r.out(), 'assistant-agent')).includes('assistant.hb.agentGone|{"name":"유령"}'));
  assert.deepEqual(find(r.out(), (n) => n.props['data-note']).map((n) => n.props['data-note']), ['no_agent']);
  byTest(r.out(), 'assistant-agent').props.onChange({ target: { value: 'wolff' } }); await r.m.flush();
  assert.deepEqual([r.calls[1].body.enabled, r.calls[1].body.agent], [true, 'wolff']);
  const paused = pausedView({ config: gone(pausedView().config) });
  const p = await render(paused);
  assert.equal(byTest(p.out(), 'assistant-switch').props.disabled, true, '없는 담당으로 다시 켜지 않는다 — 먼저 "누가"에서 고른다');
});

test('U-q: 방해 금지 시간 — 시작과 끝(아침 정리)이 같아지는 선택지는 고를 수 없다', async () => {
  const { out } = await render(mineView());
  const from = byTest(out(), 'assistant-quiet-from');
  const to = byTest(out(), 'assistant-quiet-to');
  const opt = (sel, v) => find(sel, (n) => n.type === 'option' && n.props.value === v)[0];
  assert.equal(opt(from, '08:00').props.disabled, true, '시작 = 지금 끝');
  assert.equal(opt(to, '23:00').props.disabled, true, '끝 = 지금 시작');
  assert.equal(opt(from, '22:00').props.disabled, false);
});

test('U-g: 설정 지우기(고급) — 확인 창(ui.jsx ConfirmModal) 뒤에만 DELETE, 취소면 요청 0, 응답으로 처음 상태', async () => {
  const { m, calls, out } = await render(mineView(), (_b, method) => ({ status: 200, data: method === 'DELETE' ? baseView() : mineView() }));
  assert.equal(modal(out()), undefined);
  byTest(out(), 'assistant-clear').props.onClick(); await m.flush();
  const md = modal(out());
  assert.ok(md, '확인 창');
  assert.deepEqual([md.props.title, md.props.description, md.props.tone], ['assistant.hb.clearTitle', 'assistant.hb.clearConfirm', 'danger']);
  md.props.onClose(); await m.flush();
  assert.equal(modal(out()), undefined); assert.equal(calls.length, 1, '취소면 요청 0');
  byTest(out(), 'assistant-clear').props.onClick(); await m.flush();
  modal(out()).props.onConfirm(); await m.flush();
  assert.deepEqual([calls[1].method, calls[1].url, calls[1].body], ['DELETE', '/api/companies/co/assistant', undefined]);
  assert.equal(text(byTest(out(), 'assistant-line')), 'assistant.hb.stNone');
  assert.equal(byTest(out(), 'assistant-clear'), undefined, '지운 뒤에는 지우기 버튼이 없다');
});

test('U-e: 저장 실패 — 서버 문구(errorCode → API_MSG, 화면 언어)를 보이고 보기는 그대로', async () => {
  const { m, out } = await render(mineView(), () => ({ status: 400, data: { error: 'x', errorCode: 'assistant_interval_invalid' } }));
  byTest(out(), 'assistant-interval').props.onChange({ target: { value: '5' } }); await m.flush();
  const alert = find(out(), (n) => n.props.role === 'alert')[0];
  assert.equal(text(alert), API_MSG.assistant_interval_invalid.ko);
  assert.equal(byTest(out(), 'assistant-interval').props.value, 15);
});

test('K6(화면): 켜짐 줄 — 마지막 확인·오늘 보낸 일정 알림과 하루 한도(정확히 한도·넘음·확인 중·다른 기기)', async () => {
  const at = async (st) => text(byTest((await render(mineView({ status: { ...mineView().status, ...st } }))).out(), 'assistant-line'));
  assert.ok((await at({ instantToday: 10, dailyCap: 10 })).includes('assistant.todayUnder|{"n":10,"cap":10}'));
  assert.ok((await at({ instantToday: 11, dailyCap: 10 })).includes('assistant.todayOver|{"n":11,"cap":10}'));
  assert.ok((await at({ instantToday: 3, dailyCap: 10, instantSure: false })).includes('assistant.todayUnsure|{"n":3}'));
  assert.ok((await at({ runner: 'other_device', instantToday: 3 })).includes('assistant.onRunner'));
});

test('U-f: 메일 — 체크 = PUT {mail:true}, 끄기 = {mail:false}, 고급의 미리 보기만 = {mail:"shadow"}, 켠 동안 고급에 마지막 메일 확인', async () => {
  const mk = (mail) => mineView({ config: { ...mineView().config, mail } });
  const r = await render(mk('off'), (body) => ({ status: 200, data: mk(body.mail === true ? 'live' : body.mail === false ? 'off' : 'shadow') }));
  assert.equal(byTest(r.out(), 'assistant-mail').props.checked, false);
  assert.equal(byTest(r.out(), 'assistant-mail-preview'), undefined, '메일을 안 볼 때는 미리 보기 칸이 없다');
  byTest(r.out(), 'assistant-mail').props.onChange({ target: { checked: true } }); await r.m.flush();
  assert.deepEqual(r.calls.at(-1).body, { mail: true });
  byTest(r.out(), 'assistant-mail-preview').props.onChange({ target: { checked: true } }); await r.m.flush();
  assert.deepEqual(r.calls.at(-1).body, { mail: 'shadow' });
  byTest(r.out(), 'assistant-mail').props.onChange({ target: { checked: false } }); await r.m.flush();
  assert.deepEqual(r.calls.at(-1).body, { mail: false });
  const st = (mail, cfgMail = 'shadow', runner = 'this_device') => render(mineView({ config: { ...mineView().config, mail: cfgMail }, status: { ...mineView().status, runner, mail } }));
  assert.equal(text(byTest((await st({ code: 'ok', checkedAt: 5, shadow: { days: 2, total: 7 } })).out(), 'assistant-mail-status')), 'T5 · assistant.mailShadow|{"days":2,"n":7}');
  assert.equal(text(byTest((await st({ code: 'weird', checkedAt: 0 }, 'live')).out(), 'assistant-mail-status')), 'assistant.mailSt.mail_error');
});

test('i18n — 루틴 화면 하트비트 칸 문구는 사전에 ko/en 둘 다 있고, 새·옮긴 문구에 "오피스" 낱말이 없다', () => {
  const src = readFileSync(file('../app/i18n.jsx'), 'utf8');
  const entries = new Map([...src.matchAll(/^\s*'([^']+)':\s*\[('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"),\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\]/gm)].map((m) => [m[1], [m[2], m[3]]]));
  const used = new Set([
    ...readFileSync(file('../app/c/[ws]/routines/heartbeat-card.jsx'), 'utf8').matchAll(/\bt\('([^']+)'/g),
    ...readFileSync(file('../app/c/[ws]/crew/[slug]/assistant-section.jsx'), 'utf8').matchAll(/\bt\('([^']+)'/g),
    ...readFileSync(file('../app/c/[ws]/crew/[slug]/assistant-view.mjs'), 'utf8').matchAll(/\bt\('([^']+)'/g),
  ].map((x) => x[1]));
  for (const k of used) assert.ok(entries.has(k), `사전에 ${k}`);
  for (const [k, [ko, en]] of entries) {
    if (!k.startsWith('assistant.')) continue;
    assert.doesNotMatch(ko, /오피스/, `${k} 한국어에 '오피스' 없음`);
    assert.doesNotMatch(en, /\bOffice\b/, `${k} 영어에 'Office' 없음`);
  }
});
