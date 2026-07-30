// 스킬 주입 정직화(제보 2026-07-31: "설치했는데 크루가 그런 스킬 없다고 한다") —
// ① 예산 초과가 break가 아니라 skip+참조 주입인지(뒤의 작은 스킬 생존) ② 참조 라인이 크루에게
// "파일로 열어 적용" 계약을 주는지 ③ 카드 PUT이 스코프를 되살리지 않는지 ④ 배선(route 태깅·UI 배지).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-skill-inj-'));
process.env.ARGO_ROOT = ROOT; // workspace 임포트 전
const { planSkillInjection } = await import('../src/market.mjs');
const { loadSkills } = await import('../src/chat.mjs');
const { createCompany } = await import('../src/workspace.mjs');
const { paths } = await import('../src/workspace.mjs');

test('planSkillInjection: 초과는 skip — 큰 스킬이 앞에 있어도 뒤의 작은 스킬이 산다', () => {
  const r = planSkillInjection([
    { id: 'a-huge.md', size: 9000 },   // 예산(6000) 단독 초과 — 이름순 맨 앞
    { id: 'b-small.md', size: 500 },
    { id: 'c-small.md', size: 500 },
  ]);
  // 이전 구현(break)이면 b·c까지 전멸 — 화면은 '설치됨', 크루는 "그런 스킬 없음"이던 조합.
  assert.deepEqual(r.full, ['b-small.md', 'c-small.md']);
  assert.deepEqual(r.ref, ['a-huge.md']);
  const r2 = planSkillInjection([{ id: 'x.md', size: 3000 }, { id: 'y.md', size: 3000 }, { id: 'z.md', size: 3000 }]);
  assert.deepEqual(r2.full, ['x.md', 'y.md']);
  assert.deepEqual(r2.ref, ['z.md']);
});

test('loadSkills: 초과 스킬은 참조로 주입 — 존재+파일 열람 계약을 크루가 받는다', async () => {
  const ws = 'ski-1';
  await createCompany(ws, '스킬검증', 'captain');
  const dir = paths(ws).skills;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'a-거대스킬.md'), '# 거대\n' + 'x'.repeat(9000));
  await writeFile(join(dir, 'b-작은스킬.md'), '# 작은\n핵심 지침 한 줄');
  const out = await loadSkills(ws, 6000, 'ko');
  assert.match(out, /### 스킬: b-작은스킬\n# 작은/);            // 뒤의 작은 스킬 본문 생존
  assert.match(out, /### 스킬: a-거대스킬\n\(본문 생략/);        // 초과분도 존재는 알린다
  assert.match(out, /skills\/a-거대스킬\.md 을 Read로 열어/);   // 파일 열람 계약
  assert.doesNotMatch(out, /x{100}/);                           // 본문은 정말 생략됨
});

test('saveAgentCard(PUT): 패널 stale 저장이 skills/mcp/effort를 되살리지 않는다', async () => {
  const ws = 'ski-2';
  await createCompany(ws, '보존검증', 'captain');
  const { saveAgentCard } = await import('../src/persona.mjs');
  const dir = paths(ws).agents;
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'crew-a.md');
  await writeFile(file, '---\nname: 크루A\nrunner: codex\nskills: only-this\nmcp: none\neffort: high\n---\n\n본문.\n');
  // raw 편집기는 보통 스코프 키 없는 md를 보낸다(칩으로 바꾼 뒤 본문만 저장하는 시나리오)
  await saveAgentCard(ws, 'crew-a', '---\nname: 크루A\n---\n\n본문 수정.\n');
  const saved = await readFile(file, 'utf8');
  assert.match(saved, /skills: only-this/);
  assert.match(saved, /mcp: none/);
  assert.match(saved, /effort: high/);
  assert.match(saved, /runner: codex/);
  assert.match(saved, /본문 수정\./);
});

test('배선: route 주입 태깅·마켓 배지·MCP 러너 배너·스코프 복구·init MCP 실측', async () => {
  const route = await readFile(new URL('../app/api/companies/[ws]/market/route.js', import.meta.url), 'utf8');
  assert.match(route, /planSkillInjection\(skills\.map/, 'GET이 주입과 같은 규칙으로 태깅');
  assert.match(route, /injected: refSet\.has\(s\.id\) \? 'ref' : 'full'/, 'injected 필드');
  const page = await readFile(new URL('../app/c/[ws]/market/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /market\.skillRefBadge/, '스킬 ref 배지');
  assert.match(page, /market\.mcpRunnerNote/, 'MCP 러너 조건 배너(설치 시점 안내 — 유건 요구)');
  const crew = await readFile(new URL('../app/c/[ws]/crew/[slug]/page.jsx', import.meta.url), 'utf8');
  assert.match(crew, /chat\.card\.mcpCliWarn/, '크루 카드 CLI 러너 경고');
  assert.match(crew, /chat\.card\.scopeReset/, 'none 고착 복구 수단');
  assert.match(crew, /scopePartialHint/, '부분 선택 = 신규 미적용 경고');
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(chat, /msg\.mcp_servers \?\? \[\]/, 'init에서 MCP 접속 실측 소비');
  assert.match(chat, /type: 'mcp', server: sv\.name, status: sv\.status/, '실패를 원장에');
  const market = await readFile(new URL('../src/market.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(market, /playwright/, '내장 스킬이 카탈로그에 없는 이름을 제안하면 안 된다(puppeteer가 정본)');
});
