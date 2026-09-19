// 기억 문서 경로 충돌(검수 D13: "B 채널 메모"·"B 회의록"이 둘 다 b.md → 두 번째가 "이미 있음"으로 막혔다).
// 서버 제약(msgr_org_docs_path_check)은 영문·숫자 슬러그만 받는다 — 같은 경로면 -2, -3…을 붙여 다음 후보로 간다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { docSlug, docPath, insertWithFreePath, isPathTaken } from '../src/doc-path.mjs';

const CHECK = /^(rules|glossary|projects|journal)\/[a-z0-9][a-z0-9_-]{0,79}\.md$/; // 20260914120000 msgr_org_docs_path_check
const DUP = { message: 'duplicate key value violates unique constraint "msgr_org_docs_path"' };
const fakeTable = (existing = []) => { const rows = new Set(existing); const tried = []; return { tried, insert: async (path) => { tried.push(path); if (rows.has(path)) return { error: DUP }; rows.add(path); return { data: { path } }; } }; };

test('제보 재현: 영문 머리만 같은 두 제목 → 둘째는 b-2.md로 만들어진다', async () => {
  assert.equal(docSlug('B 채널 메모'), 'b'); assert.equal(docSlug('B 회의록'), 'b');
  const tb = fakeTable();
  assert.equal((await insertWithFreePath('projects', 'B 채널 메모', tb.insert)).data.path, 'projects/b.md');
  assert.equal((await insertWithFreePath('projects', 'B 회의록', tb.insert)).data.path, 'projects/b-2.md');
  assert.equal((await insertWithFreePath('projects', 'B 안건', tb.insert)).data.path, 'projects/b-3.md');
});

test('모든 후보 경로가 서버 제약을 지킨다(긴 제목 + 접미 포함)', () => {
  const slug = docSlug('A'.repeat(200));
  for (const n of [1, 2, 20]) assert.match(docPath('rules', slug, n), CHECK);
  assert.match(docPath('projects', docSlug('회의록'), 1), CHECK, '한글만인 제목은 시간 기반 슬러그');
});

test('경로 충돌이 아닌 오류는 곧바로 돌려준다(권한 거절 등을 접미로 덮지 않는다)', async () => {
  const tried = [];
  const res = await insertWithFreePath('rules', 'x', async (p) => { tried.push(p); return { error: { message: 'new row violates row-level security policy' } }; });
  assert.equal(tried.length, 1);
  assert.match(res.error.message, /row-level security/);
  assert.equal(isPathTaken('new row for relation "msgr_org_docs" violates check constraint "msgr_org_docs_path_check"'), false, '제약 위반은 충돌이 아니다');
});

test('끝까지 막히면 마지막 결과(충돌)를 돌려준다 — 화면은 docs.dup를 보인다', async () => {
  const all = Array.from({ length: 20 }, (_, i) => docPath('rules', 'x', i + 1));
  const tb = fakeTable(all);
  const res = await insertWithFreePath('rules', 'x', tb.insert, 20);
  assert.equal(tb.tried.length, 20);
  assert.ok(isPathTaken(res.error.message));
});
