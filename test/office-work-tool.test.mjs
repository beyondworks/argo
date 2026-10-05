// 에이전트 할 일·페이지 도구(office_work) — 오피스 17차 B-6(PARITY-tasks I2~I6): 인트라넷 tasks_*·categories_list·workboard_*를 오피스로.
// DB 함수는 가짜 세션 클라이언트로 대신한다(라이브 DB 호출 0). 권한·범위는 회사·문서함 도구와 같다 — 메신저 조직 채널의 그 조직, 주인의 기기 세션, 손님 턴 거절.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-work-tool-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });
process.env.ARGO_MODEL_CATALOG = 'off';

const { makeCrewServer } = await import('../src/chat.mjs');
const { crewToolSpecs, ensureRequired } = await import('../src/engine/native-query.mjs');
const { workTool, workDeps, textToNodes, docMarkdown, between } = await import('../src/gateway/office-work.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const ME = 'owner-uid', OTHER = 'm2-uid', ORG = '11111111-1111-4111-8111-111111111111', ORG2 = '99999999-9999-4999-8999-999999999999';
const NEW = '33333333-3333-4333-8333-333333333333';
const real = { ...workDeps };
after(() => Object.assign(workDeps, real));
const msgrCtx = (extra = {}) => ({ kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: ORG, channelId: 'ch-1', crewId: 'crew-uuid-1', uid: ME, wsId: 'w', origin: ME, ...extra });
const DM = (extra = {}) => msgrCtx({ channelKind: 'dm', channelId: 'dm-1', ...extra });
const PRIV = (extra = {}) => msgrCtx({ channelKind: 'private', channelId: 'pv-1', ...extra });
const P = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const CAT = 'cccccccc-cccc-4ccc-8ccc-000000000001';

const baseTasks = () => [
  { id: 't1', title: '견적서 보내기', note: '한빛 건', status: 'doing', priority: 1, category_id: CAT, category: '영업', starts_on: null, due_on: '2026-10-01', assignee: ME, created_by: ME, done_at: null, source: null },
  { id: 't2', title: '세금계산서 확인', note: '', status: 'todo', priority: 2, category_id: null, category: null, starts_on: '2026-10-05', due_on: '2026-10-10', assignee: ME, created_by: ME, done_at: null, source: { kind: 'crew', crew: 'crew-uuid-1', slug: 'pepper', name: '페퍼' } },
  { id: 't3', title: '민지 업무', note: '비밀 메모', status: 'todo', priority: 2, category_id: null, category: null, due_on: '2026-09-01', assignee: OTHER, created_by: ME, done_at: null, source: null },
  { id: 't4', title: '끝낸 일', note: '', status: 'doing', priority: 3, category_id: null, category: null, due_on: null, assignee: ME, created_by: ME, done_at: '2026-10-02T01:00:00Z', source: null },
];
const basePages = () => [
  { id: P(1), org_id: ORG, space_kind: 'org', parent_id: null, position: 'a', title: '위키', general: 'org_edit', restricted: false, is_template: false, archived_at: null, access: 'full' },
  { id: P(2), org_id: ORG, space_kind: 'org', parent_id: P(1), position: 'a', title: '회의록', general: 'org_edit', restricted: false, is_template: false, archived_at: null, access: 'full' },
  { id: P(3), org_id: ORG, space_kind: 'org', parent_id: null, position: 'b', title: '인사 비공개', general: 'org_edit', restricted: true, is_template: false, archived_at: null, access: 'full' },
  { id: P(4), org_id: ORG, space_kind: 'org', parent_id: P(3), position: 'a', title: '연봉표', general: 'org_edit', restricted: false, is_template: false, archived_at: null, access: 'full' },
  { id: P(5), org_id: ORG, space_kind: 'org', parent_id: null, position: 'c', title: '초대만', general: 'invited', restricted: false, is_template: false, archived_at: null, access: 'view' },
  { id: P(6), org_id: ORG, space_kind: 'org', parent_id: null, position: 'd', title: '템플릿', general: 'org_view', restricted: false, is_template: true, archived_at: null, access: 'full' },
  { id: P(7), org_id: ORG2, space_kind: 'org', parent_id: null, position: 'a', title: '다른 조직', general: 'org_edit', restricted: false, is_template: false, archived_at: null, access: 'full' },
  { id: P(8), org_id: null, space_kind: 'me', parent_id: null, position: 'a', title: '내 공간', general: 'invited', restricted: false, is_template: false, archived_at: null, access: 'full' },
  { id: P(9), org_id: ORG, space_kind: 'org', parent_id: P(1), position: 'b', title: '파일 든 페이지', general: 'org_edit', restricted: false, is_template: false, archived_at: null, access: 'full' },
  { id: P(10), org_id: ORG, space_kind: 'org', parent_id: P(1), position: 'c', title: '보기만', general: 'org_view', restricted: false, is_template: false, archived_at: null, access: 'view' },
  { id: P(11), org_id: ORG, space_kind: 'org', parent_id: null, position: 'e', title: '지운 섹션', general: 'org_edit', restricted: false, is_template: false, archived_at: '2026-10-01T00:00:00Z', access: 'full' },
  { id: P(12), org_id: ORG, space_kind: 'org', parent_id: P(11), position: 'a', title: '지운 섹션의 하위', general: 'org_edit', restricted: false, is_template: false, archived_at: null, access: 'full' },
];
const BODY = {
  [P(2)]: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '10월 회의' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '견적 정리' }] }] }] }, { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '메일 보내기' }] }] }] }] },
  [P(4)]: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '연봉 3000' }] }] },
  [P(9)]: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '계약서 첨부' }] }, { type: 'fileRef', attrs: { id: 'f1', name: '계약서.pdf' } }] },
};
function table(rows) {
  const q = { f: [], select() { return q; }, eq(k, v) { q.f.push((r) => r[k] === v); return q; }, in(k, vs) { q.f.push((r) => vs.includes(r[k])); return q; },
    maybeSingle() { return Promise.resolve({ data: rows.filter((r) => q.f.every((x) => x(r)))[0] ?? null, error: null }); },
    then(ok, no) { return Promise.resolve({ data: rows.filter((r) => q.f.every((x) => x(r))), error: null }).then(ok, no); } };
  return q;
}
function fake({ members = { 'dm-1': [ME], 'pv-1': [ME, OTHER], 'gv-1': [ME, 'g1'] }, roles = { [ME]: 'owner', [OTHER]: 'member', g1: 'guest' }, fail = {} } = {}) {
  const calls = [];
  const state = { tasks: baseTasks(), pages: basePages(), versions: { [P(2)]: 4, [P(4)]: 1, [P(9)]: 2, [P(10)]: 1, [P(1)]: 1 } };
  const client = {
    from: (t) => {
      calls.push({ name: `from:${t}` });
      if (t === 'msgr_channel_members') return table(Object.entries(members).flatMap(([ch, ids]) => ids.map((id) => ({ channel_id: ch, member_kind: 'user', member_id: id }))));
      if (t === 'msgr_org_members') return table(Object.entries(roles).map(([id, role]) => ({ org_id: ORG, user_id: id, role, removed_at: null })));
      if (t === 'office_pages') return table(state.pages.map((p) => ({ id: p.id, title: p.title, content: BODY[p.id] ?? {}, version: state.versions[p.id] ?? 1, updated_at: '2026-10-03T00:00:00Z' })));
      return table([]);
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      const step = `${name}:${args?.p_action ?? ''}`;
      if (fail[step]) return { data: null, error: { message: fail[step] } };
      if (name === 'office_task_list') return { data: state.tasks.map((t) => ({ ...t })), error: null };
      if (name === 'office_task_category_list') return { data: [{ id: CAT, name: '영업', position: 0, tasks: 1 }, { id: 'cccccccc-cccc-4ccc-8ccc-000000000002', name: '운영', position: 1, tasks: 0 }], error: null };
      if (name === 'office_org_people') return { data: [{ user_id: ME, name: '김유건', role: 'owner' }, { user_id: OTHER, name: '최민지', role: 'member' }], error: null };
      if (name === 'office_task_write') {
        const d = args.p_data;
        if (args.p_action === 'task.create') { const row = { assignee: ME, created_by: ME, done_at: null, ...d }; state.tasks.push(row); return { data: row, error: null }; }
        const t = state.tasks.find((x) => x.id === d.id);
        const set = { 'task.title': { title: d.title }, 'task.status': { status: d.status }, 'task.priority': { priority: d.priority }, 'task.category': { category_id: d.category_id },
          'task.start': { starts_on: d.starts_on || null }, 'task.due': { due_on: d.due_on || null }, 'task.note': { note: d.note }, 'task.done': { done_at: '2026-10-04T01:00:00Z' }, 'task.reopen': { done_at: null } }[args.p_action];
        Object.assign(t, set);
        if (t.starts_on && t.due_on && t.starts_on > t.due_on) return { data: null, error: { message: 'task_dates' } }; // 서버처럼 중간 상태도 검사
        return { data: { ...t }, error: null };
      }
      if (name === 'office_page_list_access') return { data: state.pages.map((p) => ({ ...p })), error: null };
      if (name === 'office_page_create') return { data: args.p_id, error: null };
      if (name === 'office_page_save') return { data: (state.versions[args.p_id] ?? 1) + 1, error: null };
      return { data: null, error: { message: 'unknown' } };
    },
  };
  Object.assign(workDeps, { session: async () => ({ client, uid: ME }), now: () => Date.parse('2026-10-04T03:00:00Z'), newId: () => NEW });
  return { calls, state };
}
const run = (args, opts = {}) => workTool(args, { ctx: msgrCtx(), crew: 'pepper', crewName: '페퍼', lang: 'ko', ownerId: ME, ...opts });
const writes = (calls) => calls.filter((c) => ['office_task_write', 'office_page_create', 'office_page_save'].includes(c.name));

test('W1. 메신저 조직 채널이 아니거나·위임 턴·주인 아닌 로그인·손님이 있는 방이면 거절(오피스 호출 없음)', async () => {
  const { calls } = fake();
  assert.match(await run({ action: 'tasks' }, { ctx: null }), /조직 채널/);
  assert.match(await run({ action: 'tasks' }, { ctx: { kind: 'msgr-rules' } }), /위임 턴/);
  assert.match(await run({ action: 'tasks' }, { ownerId: 'someone' }), /주인의 계정이 아니라/);
  assert.match(await run({ action: 'task_add', title: 'x' }, { ctx: PRIV({ channelId: 'gv-1' }) }), /손님/);
  assert.ok(!calls.some((c) => c.name.startsWith('office_')));
});

test('W2(I2). tasks: 기본은 주인이 맡은 안 끝난 일 — 상태·기한 지남·분류·검색 거르기, 여럿이 보는 방에서는 who=all이어도 남의 일을 내지 않는다', async () => {
  const { calls } = fake();
  const out = await run({ action: 'tasks' });
  assert.equal(calls.find((c) => c.name === 'office_task_list').args.p_org, ORG);
  assert.match(out, /\[진행 중\] 견적서 보내기 · 중요도 높음 · 분류 영업 · 기한 2026-10-01 · 기한 지남 3일 · id=t1/);
  assert.match(out, /\[할 일\] 세금계산서 확인 · 시작 2026-10-05 · 기한 2026-10-10 · 크루 페퍼가 만듦 · id=t2/);
  assert.doesNotMatch(out, /민지 업무|끝낸 일/);
  assert.match(await run({ action: 'tasks', overdue: true }), /^(?![\s\S]*t2)[\s\S]*id=t1/);
  assert.match(await run({ action: 'tasks', category: '영업' }), /^(?![\s\S]*t2)[\s\S]*id=t1/);
  assert.match(await run({ action: 'tasks', category: 'none' }), /^(?![\s\S]*id=t1)[\s\S]*id=t2/);
  assert.match(await run({ action: 'tasks', status: 'done' }), /\[끝냄\] 끝낸 일/);
  assert.match(await run({ action: 'tasks', q: '한빛' }), /id=t1/);
  const pub = await run({ action: 'tasks', who: 'all' });
  assert.doesNotMatch(pub, /민지 업무|비밀 메모|id=t3/); assert.match(pub, /남의 일은 주인과의 1:1/);
  assert.ok(!calls.some((c) => c.name === 'office_org_people'), '여럿이 보는 방에서는 사람 이름도 부르지 않는다');
  const dm = await run({ action: 'tasks', who: 'all' }, { ctx: DM() });
  assert.match(dm, /민지 업무 · 기한 2026-09-01 · 기한 지남 33일 · 맡은 사람 최민지 · id=t3/); assert.match(dm, /맡은 사람 주인 · id=t1/);
});

test('W3(I3). task_add: 주인이 맡는 새 일 — source에 크루(메신저 크루 id·slug·이름), 분류 이름 → id, 틀린 입력은 쓰지 않는다', async () => {
  const { calls } = fake();
  const out = await run({ action: 'task_add', title: '  계약서 검토  ', due_on: '2026-10-08', starts_on: '2026-10-06', status: 'doing', priority: 'high', category: '영업', note: '김 대리 요청' });
  const w = calls.find((c) => c.name === 'office_task_write');
  assert.equal(w.args.p_action, 'task.create'); assert.equal(w.args.p_org, ORG);
  assert.deepEqual(w.args.p_data, { id: NEW, title: '계약서 검토', note: '김 대리 요청', due_on: '2026-10-08', starts_on: '2026-10-06', status: 'doing', priority: 1, category_id: CAT, source: { kind: 'crew', crew: 'crew-uuid-1', slug: 'pepper', name: '페퍼' } });
  assert.ok(!('assignee' in w.args.p_data), '남에게 맡기지 않는다 — 맡은 사람은 서버 기본값(주인)');
  assert.match(out, /주인이 맡음[\s\S]*\[진행 중\] 계약서 검토 · 중요도 높음 · 분류 영업/);
  const before = writes(calls).length;
  assert.match(await run({ action: 'task_add', title: 'x', category: '없는분류' }), /영업, 운영/);
  assert.match(await run({ action: 'task_add', title: 'x', due_on: '2026-02-30' }), /YYYY-MM-DD/);
  assert.match(await run({ action: 'task_add', title: 'x', due_on: '2026-13-01' }), /YYYY-MM-DD/, '없는 달도 예외 없이 거절');
  assert.match(await run({ action: 'task_add', title: 'x', due_on: '2026-10-01', starts_on: '2026-10-02' }), /시작일이 기한보다/);
  assert.match(await run({ action: 'task_add', title: 'x', status: 'done' }), /todo·doing·hold/);
  assert.match(await run({ action: 'task_add' }), /title/);
  assert.equal(writes(calls).length, before, '틀린 입력은 서버를 부르지 않는다');
});

test('W4(I4). task_set: 주인이 맡은 일만 — 남의 일은 쓰지 않고, 준 칸만 바꾸며(빈 값 무시·같은 값 건너뜀) 메모는 덧붙인다', async () => {
  let { calls } = fake();
  assert.match(await run({ action: 'task_set', id: 't3', status: 'doing' }), /주인이 맡은 일이 아니라/);
  assert.equal(writes(calls).length, 0, '남의 일은 서버를 부르지 않는다');
  assert.match(await run({ action: 'task_set', id: 't1', title: '', note: '', status: 'doing', priority: 'high' }), /바꿀 것이 없다/);
  assert.equal(writes(calls).length, 0, '빈 값·같은 값만 오면 쓰지 않는다');
  const out = await run({ action: 'task_set', id: 't1', note: '전화함', priority: 'low', status: 'hold', category: 'none' });
  const seq = writes(calls).map((c) => c.args.p_action);
  assert.deepEqual(seq, ['task.priority', 'task.category', 'task.note', 'task.status']);
  assert.equal(writes(calls).find((c) => c.args.p_action === 'task.note').args.p_data.note, '한빛 건\n전화함', '기존 메모 뒤에 덧붙인다');
  assert.equal(writes(calls).find((c) => c.args.p_action === 'task.category').args.p_data.category_id, null);
  assert.match(out, /고쳤다\(중요도·분류·메모·상태\)[\s\S]*\[보류\] 견적서 보내기 · 중요도 낮음 · 기한/);
  ({ calls } = fake());
  await run({ action: 'task_set', id: 't1', note: '새 메모', note_mode: 'replace', status: 'done' });
  assert.deepEqual(writes(calls).map((c) => c.args.p_action), ['task.note', 'task.done'], '끝내기는 다른 칸을 고친 뒤 맨 끝');
  assert.equal(writes(calls)[0].args.p_data.note, '새 메모');
});

test('W4b. task_set: 끝낸 일은 다시 열어야 고치고, 시작일·기한은 중간 상태도 시작 ≤ 기한이 되게 순서를 정한다', async () => {
  let { calls } = fake();
  assert.match(await run({ action: 'task_set', id: 't4', title: '새 제목' }), /다시 열어라/);
  assert.match(await run({ action: 'task_set', id: 't4', status: 'done' }), /이미 끝낸/);
  assert.equal(writes(calls).length, 0);
  await run({ action: 'task_set', id: 't4', status: 'todo', title: '다시 할 일' });
  assert.deepEqual(writes(calls).map((c) => c.args.p_action), ['task.reopen', 'task.title', 'task.status']);
  ({ calls } = fake());
  await run({ action: 'task_set', id: 't4', status: 'doing' });
  assert.deepEqual(writes(calls).map((c) => c.args.p_action), ['task.reopen'], '열 때 원래 상태(doing)와 같으면 상태는 다시 쓰지 않는다');
  ({ calls } = fake());
  const out = await run({ action: 'task_set', id: 't2', starts_on: '2026-10-12', due_on: '2026-10-20' });
  assert.deepEqual(writes(calls).map((c) => c.args.p_action), ['task.due', 'task.start'], '새 시작일이 지금 기한보다 늦으면 기한부터');
  assert.match(out, /시작 2026-10-12 · 기한 2026-10-20/);
  ({ calls } = fake());
  await run({ action: 'task_set', id: 't2', starts_on: 'none' });
  assert.deepEqual(writes(calls).map((c) => [c.args.p_action, c.args.p_data.starts_on]), [['task.start', '']], 'none은 지우기');
  ({ calls } = fake());
  assert.match(await run({ action: 'task_set', id: 't2', due_on: '2026-10-01' }), /시작일이 기한보다/);
  assert.equal(writes(calls).length, 0, '최종 날짜가 틀리면 하나도 쓰지 않는다');
});

test('W5. task_set 도중 서버가 거절하면 앞에서 바꾼 칸과 멈춘 이유를 함께 알린다(삼키지 않는다)', async () => {
  fake({ fail: { 'office_task_write:task.note': 'task_limit' } });
  const out = await run({ action: 'task_set', id: 't1', priority: 'low', note: '추가' });
  assert.match(out, /중요도은\(는\) 바꿨지만 메모에서 멈췄다 — 오피스 서버 거절: 한도에 걸렸다/);
  fake({ fail: { 'office_task_write:task.create': 'task_forbidden' } });
  assert.match(await run({ action: 'task_add', title: 'x' }), /권한이 없다/);
});

test('W6(I6). pages: 이 조직 페이지만(템플릿·다른 조직·내 공간 제외) 트리로, 여럿이 보는 방에서는 비공개·초대 페이지와 그 하위를 내지 않는다', async () => {
  fake();
  const dm = await run({ action: 'pages' }, { ctx: DM() });
  assert.match(dm, /- 위키 · 편집 가능 · id=.*\n  - 회의록 · 편집 가능/);
  assert.match(dm, /인사 비공개[\s\S]*  - 연봉표/); assert.match(dm, /초대만 · 보기만/);
  assert.doesNotMatch(dm, /템플릿|다른 조직|내 공간/);
  const pub = await run({ action: 'pages' });
  assert.match(pub, /위키/); assert.match(pub, /회의록/);
  assert.doesNotMatch(pub, /인사 비공개|연봉표|초대만/); assert.match(pub, /3개는 주인과의 1:1/);
  assert.match(await run({ action: 'pages', q: '회의' }), /회의록/);
});

test('W7(I6). page_read: 본문을 읽기 쉬운 글로, 조직 전체가 보지 못하는 페이지는 1:1에서만(본문을 읽지도 않는다)', async () => {
  const { calls } = fake();
  const out = await run({ action: 'page_read', id: P(2) });
  assert.match(out, /회의록 · 편집 가능 · 버전 4\n---\n## 10월 회의\n- 견적 정리\n- \[x\] 메일 보내기/);
  assert.match(await run({ action: 'page_read', id: P(9) }), /\[파일: 계약서\.pdf\]/);
  const n = calls.filter((c) => c.name === 'from:office_pages').length;
  assert.match(await run({ action: 'page_read', id: P(4) }), /1:1/);
  assert.equal(calls.filter((c) => c.name === 'from:office_pages').length, n, '조상이 비공개인 페이지는 본문을 받지 않는다');
  assert.match(await run({ action: 'page_read', id: P(4) }, { ctx: DM() }), /연봉 3000/);
  assert.match(await run({ action: 'page_read', id: P(7) }), /이 조직에 없다/);
});

test('W8(I6). page_add: 글 → 편집기 블록, 형제 뒤 순서 값, 보기만 되는 상위 아래에는 만들지 않는다, 최상위 거절은 이유를 알린다', async () => {
  let { calls } = fake();
  const out = await run({ action: 'page_add', title: '10월 결산', parent_id: P(1), text: '# 요약\n- 매출 정리\n- [ ] 확인\n\n본문' });
  const c = calls.find((x) => x.name === 'office_page_create').args;
  assert.equal(c.p_org, ORG); assert.equal(c.p_parent, P(1)); assert.equal(c.p_id, NEW); assert.equal(c.p_template, false);
  assert.equal(c.p_position, between('c', null), '형제(a·b·c) 뒤');
  assert.deepEqual(c.p_content.content.map((n) => n.type), ['heading', 'bulletList', 'taskList', 'paragraph']);
  assert.match(out, /만들었다: 10월 결산 · 상위 위키/);
  assert.match(await run({ action: 'page_add', title: 'x', parent_id: P(10) }), /보기만/);
  assert.match(await run({ action: 'page_add', title: 'x', parent_id: P(3) }), /1:1/, '여럿이 보는 방에서 비공개 아래에 만들지 않는다');
  ({ calls } = fake({ fail: { 'office_page_create:': 'office: only admins add top-level wiki pages' } }));
  assert.match(await run({ action: 'page_add', title: '새 섹션' }), /최상위 페이지는 조직 관리자만/);
  assert.deepEqual(calls.find((x) => x.name === 'office_page_create').args.p_content, {}, '본문이 없으면 빈 문서');
});

test('W9(I6). page_edit: 덧붙이기는 기존 블록(파일 포함)을 지키고, 글자 아닌 블록이 있으면 본문 바꾸기를 거절, 버전으로 충돌을 막는다', async () => {
  let { calls } = fake();
  assert.match(await run({ action: 'page_edit', id: P(9), text: '추가 메모' }), /끝에 덧붙임.*버전 3/);
  const s = calls.find((x) => x.name === 'office_page_save').args;
  assert.equal(s.p_base_version, 2);
  assert.deepEqual(s.p_content.content.map((n) => n.type), ['paragraph', 'fileRef', 'paragraph'], '파일 블록이 남는다');
  const before = calls.filter((x) => x.name === 'office_page_save').length;
  assert.match(await run({ action: 'page_edit', id: P(9), text: '새 본문', mode: 'replace' }), /글자가 아닌 블록\(fileRef\)/);
  assert.equal(calls.filter((x) => x.name === 'office_page_save').length, before, '바꾸기를 거절하면 저장하지 않는다');
  await run({ action: 'page_edit', id: P(2), text: '# 새 회의\n- 하나', mode: 'replace', title: '회의록(정리)' });
  const r = calls.filter((x) => x.name === 'office_page_save').at(-1).args;
  assert.deepEqual([r.p_title, r.p_base_version, r.p_content.content.map((n) => n.type)], ['회의록(정리)', 4, ['heading', 'bulletList']]);
  assert.match(await run({ action: 'page_edit', id: P(10), text: 'x' }), /보기만/);
  assert.match(await run({ action: 'page_edit', id: P(2) }), /text.*title/);
  ({ calls } = fake({ fail: { 'office_page_save:': 'version_conflict' } }));
  assert.match(await run({ action: 'page_edit', id: P(2), text: 'x' }), /page_read로 다시 읽고/);
});

test('W9b(2차 의심 4). 조상이 휴지통에 있는 페이지는 목록·읽기·하위 만들기에서 없는 페이지로 본다(1:1이어도)', async () => {
  const { calls } = fake();
  for (const ctx of [msgrCtx(), DM()]) {
    const out = await run({ action: 'pages' }, { ctx });
    assert.doesNotMatch(out, /지운 섹션/, '휴지통 페이지와 그 하위는 목록에 없다');
  }
  assert.match(await run({ action: 'pages' }), /3개는 주인과의 1:1/, '휴지통 페이지는 "1:1에서만" 수에도 넣지 않는다');
  assert.match(await run({ action: 'page_read', id: P(12) }, { ctx: DM() }), /이 조직에 없다/);
  assert.ok(!calls.some((c) => c.name === 'from:office_pages'), '본문을 받지 않는다');
  assert.match(await run({ action: 'page_add', title: 'x', parent_id: P(12) }, { ctx: DM() }), /이 조직에 없다/);
  assert.match(await run({ action: 'page_edit', id: P(12), text: 'x' }, { ctx: DM() }), /이 조직에 없다/);
  assert.equal(writes(calls).length, 0);
});

test('W10. 글 ↔ 블록 변환(순수): 목록·체크·인용·구분선·코드, 빈 줄은 건너뛰고 빈 글자 조각을 만들지 않는다', () => {
  const nodes = textToNodes('## 제목\n1. 하나\n2. 둘\n> 인용\n---\n```\ncode\n```\n- [x] 끝\n-   \n');
  assert.deepEqual(nodes.map((n) => n.type), ['heading', 'orderedList', 'blockquote', 'horizontalRule', 'codeBlock', 'taskList', 'paragraph']);
  assert.equal(nodes[1].content.length, 2);
  assert.deepEqual(nodes.at(-1), { type: 'paragraph', content: [{ type: 'text', text: '-' }] });
  assert.equal(docMarkdown({ type: 'doc', content: nodes }), '## 제목\n1. 하나\n2. 둘\n> 인용\n---\n```\ncode\n```\n- [x] 끝\n-');
  assert.deepEqual(textToNodes('- [ ]'), [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }] }]);
});

const WS = 'work-wire';
await createCompany(WS, '할일도구사', 'owner', ME);
test('W11. office_work 도구는 메신저 조직 턴에만 보이고(네이티브 sink 포함), 손님 턴은 세션을 부르지 않으며, 벤더 스키마에 required가 있다', async () => {
  const none = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], null, 'ko', [], '', none);
  assert.ok(!none.some((d) => d.name === 'office_work'));
  let called = 0; Object.assign(workDeps, { session: async () => { called++; return null; } });
  const guest = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], msgrCtx({ origin: 'guest-uid' }), 'ko', [], '', guest);
  assert.match((await guest.find((d) => d.name === 'office_work').handler({ action: 'tasks' })).content[0].text, /주인이 아닌 사람/);
  assert.equal(called, 0);
  const { calls } = fake();
  const owner = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], msgrCtx(), 'en', [], '', owner);
  const def = owner.find((d) => d.name === 'office_work');
  assert.match(def.description, /Argo Office tasks/);
  assert.deepEqual(ensureRequired(crewToolSpecs([def])[0].input_schema).required, ['action']);
  assert.match((await def.handler({ action: 'task_add', title: 'wire' })).content[0].text, /Created the task/);
  assert.deepEqual(calls.find((c) => c.name === 'office_task_write').args.p_data.source, { kind: 'crew', crew: 'crew-uuid-1', slug: 'alpha', name: 'Alpha' }, '처리기가 크루 slug·이름을 넘긴다');
});
