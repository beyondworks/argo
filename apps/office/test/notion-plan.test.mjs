import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { LINK, PAGE_BLOCKS } from '../src/pages/page-blocks.js';
import * as F from '../scripts/fixtures/notion-sample.mjs';
import { planAll, normalizeEntry, isEvent, planEvent, planTask, blocksToDoc, stableId } from '../scripts/notion-plan.mjs';

// 유건 10/2: Notion은 한 번 옮기고 오피스가 원본 — 읽기 전용·재실행 안전·건수 대조. 이번에는 예시 원본으로 시험 실행만.
const NOW = Date.parse('2026-10-02T00:00:00Z');
const run = () => planAll(F, { org: 'org-1', people: { 김직원: 'u-kim' }, now: NOW });

test('재실행 안전: 같은 원본·같은 조직이면 id가 늘 같고, 조직이 다르면 다르다', () => {
  assert.deepEqual(run().plan, planAll(F, { org: 'org-1', people: { 김직원: 'u-kim' }, now: NOW }).plan);
  assert.equal(stableId('org-1', 'event', 'c-1'), stableId('org-1', 'event', 'c-1'));
  assert.notEqual(stableId('org-1', 'event', 'c-1'), stableId('org-2', 'event', 'c-1'));
  assert.match(stableId('o', 'x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('건수 대조: 원본 Beyond_Tasks는 빠짐없이 일정 + 할 일로 나뉜다(날짜 없는 줄도 기한 없는 할 일로)', () => {
  const { plan, summary } = run();
  assert.equal(plan.events.length + plan.tasks.length, F.calendar.length);
  assert.equal(summary.source.undated, 1);
  assert.equal(plan.tasks.find((t) => t.title === '아이디어 모음').due_on, null);
  assert.equal(plan.pages.length, 4); assert.equal(plan.company.length, F.company.length); assert.equal(plan.evals.length, F.reports.length); assert.equal(plan.people.length, F.employees.length);
  assert.ok(plan.people.every((p) => !('cli_token' in p)), 'CLI 토큰은 옮기지 않는다');
});

test('일정·할 일 가르기: 시각이나 장소가 있으면 일정(종일은 KST 자정 기준), 날짜만이면 할 일 — 끝낸 일은 원본 시각 그대로', () => {
  const e = (date, extra = {}) => normalizeEntry({ id: 'x', properties: { Date: { date }, 'Location (Entry)': { rich_text: extra.loc ? [{ plain_text: extra.loc }] : [] }, Status: { status: { name: extra.status ?? 'Not Started' } } }, last_edited_time: '2026-09-03T08:00:00.000Z' });
  assert.equal(isEvent(e({ start: '2026-09-10T14:00:00+09:00' })), true);
  assert.equal(isEvent(e({ start: '2026-09-10' }, { loc: '사무실' })), true);
  assert.equal(isEvent(e({ start: '2026-09-10' })), false);
  const allDay = planEvent(e({ start: '2026-09-15', end: '2026-09-16' }, { loc: '코엑스' }), 'o');
  assert.deepEqual([allDay.all_day, allDay.starts_at, allDay.ends_at], [true, '2026-09-15T00:00:00+09:00', '2026-09-17T00:00:00+09:00'], '끝날 포함 → 다음날 자정');
  const timed = planEvent(e({ start: '2026-09-10T14:00:00.000+09:00' }), 'o');
  assert.equal(Date.parse(timed.ends_at) - Date.parse(timed.starts_at), 3600e3, '끝 시각 없으면 1시간');
  const t = planTask(e({ start: '2026-09-03' }, { status: 'Completed' }), 'o', NOW);
  assert.deepEqual([t.due_on, t.done_at, t.source.kind], ['2026-09-03', '2026-09-03T08:00:00.000Z', 'notion']);
  assert.equal(planTask(e({ start: '2026-09-03' }, { status: 'Pending' }), 'o', NOW).done_at, null, 'Pending은 끝낸 일이 아니다(인트라넷 isDone과 같다)');
  const ev = run().plan.events.find((x) => x.title === '고객사 미팅');
  assert.equal(ev.category, '영업', '카테고리 = Parent Task 릴레이션 이름');
  assert.equal(ev.source, 'notion'); assert.equal(ev.source_id, 'c-1');
});

// 이유(유건 10/4 할 일 속성): 상태·카테고리(Parent Task)·우선순위를 메모 글자가 아니라 할 일 칸으로 옮긴다. 원래 Notion 메모는 note에 그대로,
// 오피스에 칸이 없는 것(담당 에이전트·자동화·출처)만 메모 첫 줄에 남긴다. 예정일~마감일은 시작일·기한.
test('할 일 칸 이관: 상태·우선순위·분류 이름·시작일, 메모는 원래 Notion 메모 그대로', () => {
  const { plan, summary } = run();
  const by = (title) => plan.tasks.find((t) => t.title === title);
  const landing = by('랜딩 문구 수정'), proposal = by('제안서 초안'), ideas = by('아이디어 모음'), tax = by('세금계산서 확인');
  assert.deepEqual([landing.status, landing.priority, landing.category, landing.starts_on, landing.due_on], ['todo', 1, '개발', null, '2026-09-03'], 'Completed는 끝낸 날짜로, 상태 칸은 할 일');
  assert.ok(landing.done_at);
  assert.equal(landing.note, '[노션에서 옮김] 담당: claude_code', '칸이 없는 담당 에이전트만 남는다');
  assert.deepEqual([proposal.status, proposal.priority, proposal.category, proposal.starts_on, proposal.due_on], ['doing', 2, '제안서', '2026-09-20', '2026-09-25'], 'In Progress → 진행 중, Category 선택값, 예정일~마감일');
  assert.equal(proposal.note, '1차 초안까지', '원래 Notion 메모 그대로');
  assert.deepEqual([ideas.status, ideas.category, ideas.due_on], ['hold', null, null], 'Pending → 보류');
  assert.equal(tax.note, '', '메모·남길 칸이 없으면 빈 메모');
  for (const t of plan.tasks) assert.doesNotMatch(t.note, /상태:|카테고리:|우선순위:/, '상태·카테고리·우선순위는 메모 글자로 넣지 않는다');
  assert.equal(summary.target.taskCategories, 2);
  const e = normalizeEntry({ id: 'x', properties: { Date: { date: { start: '2026-09-10' } }, Status: { status: { name: 'Not Started' } }, 우선순위: { select: { name: 'Low' } } } });
  assert.deepEqual([planTask(e, 'o', NOW).status, planTask(e, 'o', NOW).priority], ['todo', 3]);
  assert.equal(planTask(normalizeEntry({ id: 'y', properties: { Status: { status: { name: '모르는 값' } } } }), 'o', NOW).status, 'todo');
});

test('회사 정보: 분류 이름 → 오피스 분류, 서식 칸 key는 처음 나온 항목만(두 번째 전화는 자유 항목)', () => {
  const c = run().plan.company;
  const by = (l) => c.find((x) => x.label === l);
  assert.deepEqual([by('상호명').key, by('대표번호').key, by('전화').key, by('주거래 계좌').category, by('와이파이').category], ['name', 'phone', null, 'bank', 'other']);
  assert.deepEqual(c.filter((x) => x.category === 'contact').map((x) => x.position), [0, 1, 2]);
});

test('평가 레포트: 범위·대상 유형·기간 글·점수 반올림, 에이전트는 크루, 계정 지도에 있는 사람만 계정 연결', () => {
  const [w, m, y] = run().plan.evals;
  assert.deepEqual([w.scope, w.subject_type, w.subject_kind, w.subject_user, w.from, w.to], ['week', 'ceo', 'person', null, '2026-09-07', '2026-09-13']);
  assert.deepEqual([m.subject_user, m.from, m.to, m.total, m.period_label], ['u-kim', '2026-08-01', '2026-08-31', 75, '2026년 8월']);
  assert.deepEqual([y.subject_kind, y.subject_type, y.from, y.author_name, y.created_at], ['crew', 'agent', '2025-01-01', '효원', '2026-09-14T12:30:00.000Z']);
});

// 16차(유건 10/4): 예전에는 토글을 굵은 문단, 콜아웃을 인용, 표를 '|'로 이은 글줄, 2열을 풀어 놓은 블록, 링크를 '글 (주소)' 글자로 바꿨다.
// 이제 오피스 편집기에 같은 블록이 있으니 그대로 옮긴다 — 검사는 편집기와 같은 스키마(src/pages/page-blocks.js)로 한다.
test('워크보드: 트리 구조 유지, 본문은 오피스 편집기 스키마에 맞는 문서(토글·콜아웃·표·2열·링크는 같은 블록으로, 그림만 글자로 세어 보고)', () => {
  const { plan, summary } = run();
  const [root, playbook, child, minutes] = plan.pages;
  assert.equal(root.parent, null); assert.equal(playbook.parent, root.id); assert.equal(child.parent, playbook.id); assert.equal(minutes.parent, root.id);
  assert.ok(playbook.position < minutes.position, '형제 순서 유지');
  const schema = getSchema([StarterKit.configure({ link: LINK }), TaskList, TaskItem.configure({ nested: true }), ...PAGE_BLOCKS]);
  for (const p of plan.pages) schema.nodeFromJSON(p.content).check(); // 오피스 편집기가 그대로 연다
  const nodes = playbook.content.content, find = (type, list = nodes) => list.find((n) => n.type === type);
  const text = JSON.stringify(playbook.content);
  assert.doesNotMatch(text, /\(https:\/\/example\.test\/guide\)/, '주소를 글자로 덧붙이지 않는다');
  assert.deepEqual(find('paragraph', nodes.filter((n) => JSON.stringify(n).includes('참고'))).content[0], { type: 'text', text: '참고', marks: [{ type: 'link', attrs: { href: 'https://example.test/guide' } }] });
  assert.match(text, /"taskItem","attrs":\{"checked":true\}/);
  assert.deepEqual(find('callout'), { type: 'callout', attrs: { icon: 'info' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '가격표는 회사 정보 화면' }] }] }, '콜아웃은 콜아웃으로(💡 → 안내 아이콘), 이모지 글자는 넣지 않는다');
  const table = find('table');
  assert.deepEqual(table.content.map((r) => r.content.map((c) => c.type)), [['tableHeader', 'tableHeader'], ['tableCell', 'tableCell']], '첫 줄 머리 행');
  assert.equal(table.content[1].content[1].content[0].content[0].text, '1일');
  const m = minutes.content.content;
  assert.deepEqual(m[0], { type: 'toggle', attrs: { open: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '9월 1주' }] }, { type: 'paragraph', content: [{ type: 'text', text: '결정: 랜딩 개편' }] }] }, '토글은 접힌 토글로(굵은 문단 아님)');
  const cols = find('columns', m);
  assert.deepEqual(cols.content.map((c) => c.content.map((n) => n.type)), [['paragraph'], ['paragraph', 'taskList']], '2열은 칸마다 블록 그대로');
  assert.deepEqual(m.find((n) => n.type === 'toggle' && n.content[0].type === 'heading').content.map((n) => n.type), ['heading', 'paragraph'], '노션 토글 제목 → 제목이 첫 줄인 토글');
  assert.deepEqual(m.at(-1).content.map((n) => [n.text, n.marks?.[0]?.attrs?.href ?? null]), [['회의 자료 ', null], ['https://docs.example.test/deck', 'https://docs.example.test/deck']], '북마크 주소는 링크로');
  assert.deepEqual(summary.textOnlyBlocks, { image: 1 }, '표는 이제 글자로 옮기지 않는다');
  assert.deepEqual(blocksToDoc([{ type: 'synced_block', synced_block: {}, children: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: '안' }] } }] }]).map((n) => n.type), ['paragraph'], '모르는 블록은 안의 글자를 살린다');
});

test('이관 블록 변환: 칸 하나뿐인 2열은 블록만, 노션 안쪽 주소는 링크가 아니라 글자, 첫 칸 머리(has_row_header), 짧은 줄은 빈 칸으로 채운다', () => {
  const rt = (s, link) => [{ plain_text: s, href: link ?? null, annotations: {} }];
  const one = blocksToDoc([{ type: 'column_list', column_list: {}, children: [{ type: 'column', column: {}, children: [{ type: 'paragraph', paragraph: { rich_text: rt('혼자') } }] }] }]);
  assert.deepEqual(one.map((n) => n.type), ['paragraph']);
  const [p] = blocksToDoc([{ type: 'paragraph', paragraph: { rich_text: rt('다른 페이지', '/0a1b2c3d') } }]);
  assert.deepEqual(p.content, [{ type: 'text', text: '다른 페이지' }], '노션 안쪽 주소·javascript: 같은 주소는 링크로 만들지 않는다');
  assert.equal(blocksToDoc([{ type: 'paragraph', paragraph: { rich_text: rt('x', 'javascript:alert(1)') } }])[0].content[0].marks, undefined);
  const [t2] = blocksToDoc([{ type: 'table', table: { table_width: 3, has_column_header: false, has_row_header: true }, children: [{ type: 'table_row', table_row: { cells: [rt('이름'), rt('값')] } }] }]);
  assert.deepEqual(t2.content[0].content.map((c) => c.type), ['tableHeader', 'tableCell', 'tableCell'], '첫 칸 머리, 모자란 칸은 빈 칸');
  const schema = getSchema([StarterKit.configure({ link: LINK }), TaskList, TaskItem.configure({ nested: true }), ...PAGE_BLOCKS]);
  schema.nodeFromJSON({ type: 'doc', content: [t2] }).check();
});

test('실행기 시험 실행(--fixture): 네트워크·토큰 없이 계획 건수만 내고 쓰지 않는다', () => {
  const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(NOTION_|OFFICE_MIGRATE_)/.test(k)) delete env[k];
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/notion-migrate.mjs', import.meta.url)), '--fixture'], { env, encoding: 'utf8' });
  assert.match(out, /일정 3 · 할 일 4\(끝낸 일 2\) · 위키 페이지 4 · 회사 정보 10\(서식 칸 7\) · 평가 3/);
  assert.match(out, /시험 실행 — 쓰기 없음/);
  let code = 0;
  try { execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/notion-migrate.mjs', import.meta.url)), '--fixture', '--apply'], { env, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.equal(code, 2, '--apply는 --org 없이 실행되지 않는다');
});

test('--json 계획 출력은 계좌·사업자번호를 가린다(분리 검수) — 끝 4자리만', () => {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/notion-migrate.mjs', import.meta.url)), '--fixture', '--json'], { env: { ...process.env, NOTION_TOKEN: '' }, encoding: 'utf8' });
  assert.ok(out.includes('주거래 계좌'), '항목 이름은 보인다');
  assert.ok(!out.includes('000-000-000000'), '계좌 번호 원문은 나오지 않는다');
  assert.match(out, /예시은행 \*\*\*-\*\*\*-\*\*0000/);
});

test('maskForPrint: 계좌 분류·사업자·법인 번호만 숫자를 가리고 다른 값은 그대로', async () => {
  const { maskForPrint } = await import('../scripts/notion-plan.mjs');
  const m = maskForPrint({ company: [{ category: 'bank', value: '국민 123456-78-901234' }, { category: 'basic', key: 'biz_no', value: '214-86-12345' }, { category: 'basic', key: 'name', value: '(주)한빛 2026' }], evals: [{ title: 't' }] });
  assert.deepEqual(m.company.map((c) => c.value), ['국민 ******-**-**1234', '***-**-*2345', '(주)한빛 2026']);
  assert.deepEqual(m.evals, [{ title: 't' }]);
});
