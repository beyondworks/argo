// 크루별 능력 범위 회귀 테스트 — 카드 skills:/mcp: 계약 고정(유건 지시 2026-07-19):
// 설치는 회사 공용(모든 크루 기본 사용), 크루 카드에서 크루별로 좁힐 수 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT — WS_ROOT는 모듈 로드 시 고정되므로 import보다 먼저 심는다(실데이터 미접촉)
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-scopetest-'));
const { parseScopeList, updateAgentMeta } = await import('../src/persona.mjs');
const { loadSkills } = await import('../src/chat.mjs');
const { paths } = await import('../src/workspace.mjs');

test('parseScopeList: 미기재=전체(null), none=빈 배열, csv=목록 — 계약 고정', () => {
  assert.equal(parseScopeList(undefined), null, '필드 없음 = 전체 사용(기본)');
  assert.equal(parseScopeList(''), null, '빈 값 = 전체 사용');
  assert.deepEqual(parseScopeList('none'), [], "'none' = 사용 안 함");
  assert.deepEqual(parseScopeList(' None '), [], '대소문자·공백 관용');
  assert.deepEqual(parseScopeList('a, b ,c'), ['a', 'b', 'c'], 'csv = 지정 목록(공백 트림)');
});

test('loadSkills: allow 범위대로만 주입 — 전체/지정/없음', async () => {
  const ws = 'co-scope1';
  const dir = paths(ws).skills;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'writing.md'), '# 글쓰기 규칙\n짧게 써라.');
  await writeFile(join(dir, 'research.md'), '# 리서치 규칙\n출처를 남겨라.');
  const all = await loadSkills(ws, 6000, 'ko', null);
  assert.ok(all.includes('writing') && all.includes('research'), '전체(기본) — 설치 스킬 모두 주입');
  const only = await loadSkills(ws, 6000, 'ko', ['writing']);
  assert.ok(only.includes('writing') && !only.includes('research'), '지정 목록만 주입');
  assert.equal(await loadSkills(ws, 6000, 'ko', []), '', "'none' — 주입 없음");
});

test('updateAgentMeta: skills/mcp 필드 왕복 — 저장·해제', async () => {
  const ws = 'co-scope2';
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'kim.md'), '---\nname: 김서기\nslug: kim\nrole: 서기\n---\n\n# 김서기 — 서기\n');
  const m1 = await updateAgentMeta(ws, 'kim', { skills: 'writing', mcp: 'none' });
  assert.equal(m1.skills, 'writing', '스킬 범위 저장');
  assert.equal(m1.mcp, 'none', 'MCP 사용 안 함 저장');
  const m2 = await updateAgentMeta(ws, 'kim', { skills: '' });
  assert.ok(!parseScopeList(m2.skills), '빈 값으로 되돌리면 전체 사용(기본) 복귀');
  assert.equal(m2.name, '김서기', '다른 필드 보존');
});
