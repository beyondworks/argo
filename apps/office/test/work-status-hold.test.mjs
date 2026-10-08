// 보류 사유(유건 10/8 확정 4) — 할 일 패널의 '보류 사유' 칸이 쓰는 것, 예시 모드가 서버와 같은 규칙으로 보류한 때·사유를 바꾸는지,
// 업무 현황 예시 데이터가 서버 응답 모양 그대로 화면 계산을 통과하는지(픽스처가 실제 모양이 아니면 화면 확인이 무효).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as V from '../src/views/model.js';
import * as CM from '../src/calendar/model.js';
import { sourceOf, buildStatus, cardKey } from '../src/core/work-status-model.js';
import { TASK_DICT } from '../src/pages/task-i18n.js';
import { WORK_STATUS_DICT } from '../src/pages/work-status-i18n.js';

const ME = 'u-me';
const ctx = (over = {}) => ({ today: '2026-10-08', me: ME, isAdmin: (s) => s === 'org-admin', members: () => null, categoryOf: () => null, ...over });
const task = (over) => V.taskItem({ id: 't1', title: '할 일', due_on: null, assignee: ME, created_by: ME, done_at: null, status: 'hold', priority: 2, note: '', hold_reason: null, held_at: null, space: 'me', ...over });

test('planHoldReason: 보류인 일의 사유만 task.status hold + reason_only로, 공백은 걷고 비면 null, 같은 값이면 쓰지 않는다', () => {
  const c = ctx();
  assert.deepEqual(V.planHoldReason(task(), '  이것부터: 검수  ', c).write,
    { type: 'task', space: 'me', action: 'task.status', data: { id: 't1', status: 'hold', hold_reason: '이것부터: 검수', reason_only: true }, patch: { hold_reason: '이것부터: 검수' } },
    'reason_only — 패널이 든 행이 낡아 그사이 보류가 풀렸으면 서버가 상태를 되돌리지 않고 task_conflict(검수 10/8)');
  assert.equal(V.planHoldReason(task({ hold_reason: '이것부터: 검수' }), '이것부터: 검수 ', c).write, null, '같은 값');
  assert.equal(V.planHoldReason(task(), '   ', c).write, null, '비어 있던 사유를 빈칸으로 — 바꿀 것 없음');
  assert.deepEqual(V.planHoldReason(task({ hold_reason: '옛 사유' }), '', c).write.data, { id: 't1', status: 'hold', hold_reason: null, reason_only: true }, '지우면 null');
  assert.equal(V.planHoldReason(task(), 'x'.repeat(V.HOLD_REASON_MAX), c).write.action, 'task.status');
  assert.equal(V.planHoldReason(task(), 'x'.repeat(V.HOLD_REASON_MAX + 1), c).reason, 'input');
  assert.equal(V.planHoldReason(task({ status: 'doing' }), '사유', c).reason, 'input', '보류가 아닌 일에는 사유를 쓰지 않는다');
  assert.equal(V.planHoldReason(task({ done_at: '2026-10-08T00:00:00Z' }), '사유', c).reason, 'done');
});

test('planHoldReason 권한: 상태 바꾸기와 같다(맡은 사람·관리자)', () => {
  const c = ctx();
  assert.equal(V.planHoldReason(task({ space: 'org-member', created_by: 'u-boss' }), '사유', c).write.action, 'task.status', '남이 맡긴 일도 맡은 사람은');
  assert.equal(V.planHoldReason(task({ space: 'org-member', assignee: 'u-a' }), '사유', c).reason, 'taskPerm');
  assert.equal(V.planHoldReason(task({ space: 'org-admin', assignee: 'u-a', created_by: 'u-a' }), '사유', c).write.action, 'task.status', '관리자');
});

// 예시 모드 쓰기(data/calendar-sample.js) — 서버 office_task_write와 같은 규칙. 화면 설정 모듈(session.js)은 노드에서 못 불러와 가져오기 줄을 지우고 값을 넣는다(task-store.test.mjs와 같은 방식)
function loadSample(path, deps) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import [\s\S]*?;$/gm, '');
  const module = { exports: {} };
  const globals = { ...deps, module, exports: module.exports };
  new Function(...Object.keys(globals), transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(globals));
  return module.exports;
}
const SPACES = [{ key: 'me', kind: 'me', role: 'owner' }, { key: 'beyondworks', kind: 'org', role: 'owner' }, { key: 'lean-studio', kind: 'org', role: 'member' }];
const calendarSample = () => loadSample('../src/data/calendar-sample.js', { ME: { id: ME, name: '김유건' }, SPACES, ...CM });

test('예시 모드 보류: 보류로 가면 보류한 때·사유, 이미 보류면 사유만(보류한 때 그대로), 다른 상태로 가면 둘 다 지운다', () => {
  const S = calendarSample();
  const created = S.sampleTaskWrite('me', 'task.create', { id: 'n1', title: '새 일', status: 'hold', hold_reason: ' 기다림 ' });
  assert.equal(created.hold_reason, '기다림');
  assert.ok(created.held_at);
  const t = S.SAMPLE_TASKS.find((x) => x.id === 't-s1'); // 진행 중인 내 일
  const statusLines = () => S.sampleTaskHistory('t-s1').filter((h) => h.kind === 'status').map((h) => `${h.from}>${h.to}`);
  const before = statusLines().length;
  assert.throws(() => S.sampleTaskWrite('me', 'task.status', { id: 't-s1', status: 'hold', hold_reason: '늦게 온 사유', reason_only: true }), /task_conflict/, '보류가 아닌 일에 사유만 고치기 → 충돌');
  assert.deepEqual([t.status, t.hold_reason, statusLines().length], ['doing', null, before], '충돌이면 상태를 보류로 되돌리지 않는다');
  S.sampleTaskWrite('me', 'task.status', { id: 't-s1', status: 'hold', hold_reason: '자료 대기' });
  assert.equal(t.status, 'hold'); assert.equal(t.hold_reason, '자료 대기');
  const heldAt = t.held_at;
  assert.ok(heldAt);
  t.held_at = '2026-10-01T00:00:00.000Z';
  S.sampleTaskWrite('me', 'task.status', { id: 't-s1', status: 'hold', hold_reason: '이것부터: 검수', reason_only: true });
  assert.deepEqual([t.status, t.hold_reason, t.held_at], ['hold', '이것부터: 검수', '2026-10-01T00:00:00.000Z'], '사유만 바뀐다');
  S.sampleTaskWrite('me', 'task.status', { id: 't-s1', status: 'hold', hold_reason: '이것부터: 검수', reason_only: true });
  S.sampleTaskWrite('me', 'task.status', { id: 't-s1', status: 'hold' });
  assert.equal(t.hold_reason, '이것부터: 검수', '사유를 안 보내면 그대로');
  assert.deepEqual(statusLines().slice(0, statusLines().length - before), ['hold>hold', 'doing>hold'], '사유를 고치면 서버처럼 보류→보류 한 줄(같은 사유·사유 없음은 줄 없음, 사유 값은 기록에 없다)');
  assert.ok(S.sampleTaskHistory('t-s1').every((h) => !String(h.to ?? '').includes('검수')));
  S.sampleTaskWrite('me', 'task.status', { id: 't-s1', status: 'doing' });
  assert.deepEqual([t.status, t.hold_reason, t.held_at], ['doing', null, null]);
  assert.throws(() => S.sampleTaskWrite('me', 'task.status', { id: 't-s1', status: 'hold', hold_reason: 'x'.repeat(501) }), /task_input/);
});

test('업무 현황 예시 데이터: 서버 응답 모양 그대로 화면 계산을 통과한다(관리자 조직 전체·멤버 조직 내 일만)', () => {
  const S = calendarSample();
  const W = loadSample('../src/data/work-status-sample.js', { ME: { id: ME, name: '김유건' }, SPACES, SAMPLE_TASKS: S.SAMPLE_TASKS, SAMPLE_PEOPLE: S.SAMPLE_PEOPLE });
  const now = Date.parse('2026-10-08T03:00:00Z');
  const d = W.sampleWorkStatus('beyondworks', now);
  assert.deepEqual(Object.keys(d).sort(), ['admin', 'crews', 'now', 'people', 'running', 'runs', 'sessions', 'tasks']);
  assert.ok(d.tasks.every((x) => !('org' in x) && !x.done_at), '응답에는 조직 칸이 없고 끝낸 일이 없다');
  const r = buildStatus(d, { me: ME });
  const mac = r.people.find((p) => p.key === cardKey(ME, '맥가이버'));
  assert.deepEqual([mac.places.session.length, mac.places.bot.length, mac.places.local.length], [1, 1, 1], '맥 세션·VPS·아르고 세 자리가 한 사람');
  assert.ok(mac.now.some((x) => x.kind === 'session' && x.id === 't-s10'), '세션이 맡은 할 일이 지금 하는 일');
  assert.ok(r.held.some((x) => x.id === 't-s11' && x.personName === '페퍼'), '세션이 남긴 보류 일이 보류된 업무에');
  assert.ok(r.unowned.held.some((x) => x.id === 't-s3' && x.assigneeName === '박준'), '사람이 맡긴 보류 일');
  assert.deepEqual(r.idle.map((p) => p.name), ['하나']);
  assert.equal(r.hidden, 1);
  const m = W.sampleWorkStatus('lean-studio', now);
  assert.equal(m.admin, false);
  assert.ok(m.tasks.every((x) => x.assignee === ME || x.created_by === ME));
});

test('사전: 보류 사유·업무 현황 문구는 ko/en 둘 다', () => {
  for (const [k, v] of Object.entries({ ...WORK_STATUS_DICT, ...Object.fromEntries(['task.f.holdReason', 'task.heldAt', 'task.holdReasonPh', 'task.h.holdReason'].map((x) => [x, TASK_DICT[x]])) })) {
    assert.ok(Array.isArray(v) && v.length === 2 && v[0] && v[1], k);
    assert.doesNotMatch(v[1], /[가-힣]/, `${k} 영어 쪽에 한글`);
  }
});

// 할 일 패널 '바뀐 기록'(views/TaskPanel.jsx historyLine) — 서버는 이미 보류인 일의 사유만 고칠 때 'status' 보류→보류 한 줄을 남긴다(사유 값 없음).
// '상태 보류 → 보류'로 보이면 뜻이 없다 — '보류 사유를 고침'. 패널 파일은 화면 모듈을 불러와 노드에서 못 실행하므로 그 함수 원문만 꺼내 실행한다
test('바뀐 기록: 상태 보류→보류는 "보류 사유를 고침", 다른 상태 바뀜은 그대로', () => {
  const src = readFileSync(new URL('../src/views/TaskPanel.jsx', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const FIELD_OF'), src.indexOf('/** space:'));
  assert.match(body, /export function historyLine/);
  const dict = { ...TASK_DICT };
  const t = (k, v = {}) => (dict[k]?.[0] ?? k).replace(/\{(\w+)\}/g, (_, n) => v[n]);
  const { historyLine } = new Function('t', 'day', `${transformSync(body.replace('export function', 'function'), { loader: 'js' }).code}; return { historyLine };`)(t, (d) => d);
  assert.equal(historyLine({ kind: 'status', from: 'hold', to: 'hold' }), '보류 사유를 고침');
  assert.equal(historyLine({ kind: 'status', from: 'doing', to: 'hold' }), t('task.h.change', { field: t('task.f.status'), from: t('task.st.doing'), to: t('task.st.hold') }));
  assert.notEqual(historyLine({ kind: 'status', from: 'todo', to: 'todo' }), '보류 사유를 고침');
});

// 업무 현황 화면(pages/WorkStatus.jsx)의 표시 글 — 담당·출처·카드 주인. 화면 파일은 노드에서 못 불러오므로 그 함수 원문만 꺼내 실행한다(위와 같은 방식)
test('업무 현황 표시: 보류 카드 담당은 맡은 사람, 이름 없는 세션 출처는 "세션", 남의 카드는 주인 이름(모르면 "다른 사람")', () => {
  const src = readFileSync(new URL('../src/pages/WorkStatus.jsx', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('/** 할 일의 출처 한 줄'), src.indexOf('function useWorkStatus'));
  const t = (k, v = {}) => (WORK_STATUS_DICT[k]?.[0] ?? k).replace(/\{(\w+)\}/g, (_, n) => v[n]);
  const F = new Function('t', 'sourceOf', `${transformSync(body, { loader: 'js' }).code}; return { fromText, who, ownerOf, label };`)(t, sourceOf);
  const held = { person: 'u1|페퍼', personName: '페퍼', assigneeName: '박준', source: { kind: 'session', name: '페퍼 - 총괄' } };
  assert.equal(F.who(held), '박준', '담당 = 실제 맡은 사람(에이전트 이름은 출처 줄에만)');
  assert.equal(F.who({ personName: '페퍼', assigneeName: null }), '나간 사람');
  assert.equal(F.fromText(held), '세션 페퍼 - 총괄');
  assert.equal(F.fromText({ source: { kind: 'session' } }), '세션', '이름 없는 세션 출처는 사람이 맡김이 아니라 세션');
  assert.equal(F.fromText({ source: { kind: 'session', name: '' } }), '세션');
  assert.equal(F.fromText({ source: null }), '사람이 맡김');
  assert.equal(F.fromText({ person: 'u1|오토', personName: '오토', source: { kind: 'crew', crew: 'c1' } }), '에이전트 오토');
  assert.equal(F.fromText({ person: null, source: { kind: 'crew', crew: 'c9', name: '페퍼' } }), '에이전트', '주인 대조에 실패한 출처는 적어 보낸 이름을 쓰지 않는다');
  assert.equal(F.fromText({ person: null, source: { kind: 'session', name: '페퍼 - 총괄' } }), '세션');
  assert.equal(F.ownerOf({ mine: true, ownerName: '김유건' }), null);
  assert.equal(F.ownerOf({ mine: false, ownerName: '박준' }), '박준');
  assert.equal(F.ownerOf({ mine: false, ownerName: null }), '다른 사람');
  assert.equal(F.label({ name: '오토', mine: false, ownerName: '박준' }), '오토 (박준)');
  assert.equal(F.label({ name: '오토', mine: true }), '오토');
});

// 보류 사유 저장과 상태 단추가 겹칠 때(검수 10/8) — 할 일 패널은 같은 할 일 쓰기를 한 줄로 이어 보낸다(views/TaskPanel.jsx inLine).
// 앞 쓰기가 끝나기 전에 뒤 쓰기가 나가면 서버가 뒤 것을 먼저 처리해 상태가 되돌아갈 수 있다. 앞 쓰기가 실패해도 뒤 쓰기는 나간다
test('할 일 패널 쓰기 줄: 앞 쓰기가 끝난 뒤에 다음 쓰기, 앞이 실패해도 다음은 나간다', async () => {
  const src = readFileSync(new URL('../src/views/TaskPanel.jsx', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  const queue = useRef('), src.indexOf('  useEffect(() => () => {'));
  assert.match(body, /const inLine = /);
  const { inLine } = new Function('useRef', `${body}; return { inLine };`)((v) => ({ current: v }));
  const log = [];
  const slow = () => new Promise((ok) => setTimeout(() => { log.push('reason:end'); ok({ failed: 'task.error.conflict' }); }, 20));
  const a = inLine(() => { log.push('reason:start'); return slow(); });
  const b = inLine(() => { log.push('status:start'); return { failed: null }; });
  const c = inLine(() => { log.push('boom'); throw new Error('x'); });
  const d = inLine(() => { log.push('after'); return 1; });
  assert.deepEqual(await a, { failed: 'task.error.conflict' });
  assert.deepEqual(await b, { failed: null });
  await assert.rejects(c);
  assert.equal(await d, 1);
  assert.deepEqual(log, ['reason:start', 'reason:end', 'status:start', 'boom', 'after']);
});

// 서버가 task_conflict를 주면(그사이 남이 바꿈) 그 공간 목록을 다시 읽는다 — 한 건 쓰기는 먼저 화면에 반영했다가 되돌리므로, 다시 읽어야 지금 값이 보인다(views/data.js writeAll)
test('쓰기 충돌이면 그 공간을 다시 읽는다(다른 실패는 그대로)', async () => {
  const src = readFileSync(new URL('../src/views/data.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function writeAll'), src.indexOf('/* ── 보기 설정'));
  const run = async (message) => {
    const loaded = [];
    const deps = { writeTask: async () => { throw new Error(message); }, sample: () => false, loadTasks: async (k) => { loaded.push(k); }, emit: () => {}, writeEvent: async () => {}, refreshEvents: async () => {} };
    const writeAll = new Function(...Object.keys(deps), `${body}; return writeAll;`)(...Object.values(deps));
    const r = await writeAll([{ type: 'task', space: 'beyondworks', action: 'task.status', data: { id: 't', status: 'hold', hold_reason: 'x', reason_only: true } }]);
    return [r.failed, loaded];
  };
  assert.deepEqual(await run('task.error.conflict'), ['task.error.conflict', ['beyondworks']]);
  assert.deepEqual(await run('task.error.permission'), ['task.error.permission', []]);
});
