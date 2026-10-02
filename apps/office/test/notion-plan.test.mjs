import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
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

test('워크보드: 트리 구조 유지, 본문은 오피스 편집기 스키마에 맞는 문서(링크는 주소 글자로, 표·그림은 글자로 세어 보고)', () => {
  const { plan, summary } = run();
  const [root, playbook, child, minutes] = plan.pages;
  assert.equal(root.parent, null); assert.equal(playbook.parent, root.id); assert.equal(child.parent, playbook.id); assert.equal(minutes.parent, root.id);
  assert.ok(playbook.position < minutes.position, '형제 순서 유지');
  const schema = getSchema([StarterKit.configure({ link: false }), TaskList, TaskItem.configure({ nested: true })]);
  for (const p of plan.pages) schema.nodeFromJSON(p.content).check(); // 오피스 편집기가 그대로 연다
  const text = JSON.stringify(playbook.content);
  assert.match(text, /참고 \(https:\/\/example\.test\/guide\)/);
  assert.match(text, /"taskItem","attrs":\{"checked":true\}/);
  assert.deepEqual(summary.textOnlyBlocks, { table: 1, image: 1 });
  assert.deepEqual(blocksToDoc([{ type: 'synced_block', synced_block: {}, children: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: '안' }] } }] }]).map((n) => n.type), ['paragraph'], '모르는 블록은 안의 글자를 살린다');
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
