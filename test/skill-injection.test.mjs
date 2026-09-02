// 스킬 주입 정직화(제보 2026-07-31: "설치했는데 크루가 그런 스킬 없다고 한다") —
// ① 예산 초과가 break가 아니라 skip+참조 주입인지(뒤의 작은 스킬 생존) ② 참조 라인이 크루에게
// "파일로 열어 적용" 계약을 주는지 ③ 카드 PUT이 스코프를 되살리지 않는지 ④ 배선(route 태깅·UI 배지).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
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
  assert.deepEqual(r2.omitted, []); // 상한 안이면 무명 상태는 없다
});

test('planSkillInjection: 21번째 ref는 무명(omitted) — 마켓이 ref 배지를 달면 거짓(검수 R2)', () => {
  // 전부 예산(6000) 단독 초과 — full 0, 참조 상한(20)까지만 ref, 그 뒤는 이름조차 미주입.
  const entries = Array.from({ length: 23 }, (_, i) => ({ id: `s-${String(i).padStart(2, '0')}.md`, size: 9000 }));
  const r = planSkillInjection(entries);
  assert.deepEqual(r.full, []);
  assert.deepEqual(r.ref, entries.slice(0, 20).map((e) => e.id));   // 위치 단언 — 앞 20개 그대로
  assert.deepEqual(r.omitted, entries.slice(20).map((e) => e.id));  // 21번째(s-20)부터 무명
  // 변이 D 잠금: SKILL_REF_CAP→Infinity면 s-20이 ref로 새서 아래가 red가 된다.
  assert.ok(!r.ref.includes('s-20.md'), '21번째가 ref(참조 주입됨)로 표기되면 안 된다');
});

test('loadSkills: 계획대로만 주입 — 21번째부터는 참조 라인 없이 개수 요약만(주입=표기 동일 규칙)', async () => {
  const ws = 'ski-refcap';
  await createCompany(ws, '상한검증', 'captain');
  const dir = paths(ws).skills;
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 22; i++) {
    await writeFile(join(dir, `s-${String(i).padStart(2, '0')}.md`), '# 제목\n' + 'x'.repeat(9000)); // 각각 예산 단독 초과
  }
  const out = await loadSkills(ws, 6000, 'ko');
  assert.match(out, /### 스킬: s-19\n\(본문 생략/);       // 20번째까지는 참조 주입
  assert.doesNotMatch(out, /s-20/);                        // 21번째부터는 이름조차 없다
  assert.doesNotMatch(out, /s-21/);
  assert.match(out, /그 외 설치 스킬 2개/);                // 무명분은 개수 요약 한 줄
});

test('listInstalledSkills: 손상 항목(디렉터리)이 마켓 목록을 죽이지 않는다 — #203 M3(턴 경로)의 마켓 대칭', async () => {
  const ws = 'ski-market-tol';
  await createCompany(ws, '마켓관용', 'captain');
  const dir = paths(ws).skills;
  await mkdir(join(dir, 'a-폴더.md'), { recursive: true }); // 디렉터리인데 .md — EISDIR 유발(이전엔 throw → GET 500)
  await writeFile(join(dir, 'b-정상.md'), '# 정상목록\n지침');
  const { listInstalledSkills } = await import('../src/market.mjs');
  const out = await listInstalledSkills(ws);
  assert.deepEqual(out.map((s) => s.id), ['b-정상']); // 손상 항목만 스킵, 나머지는 산다
  assert.equal(out[0].title, '정상목록');
});

test('isNewMcpFailure(순수): 같은 서버·같은 상태 연속이면 억제 — 상태 변화·신규 서버는 기록', async () => {
  const { isNewMcpFailure } = await import('../src/chat.mjs');
  const recent = [ // readEvents 계약: 최신순 — 같은 서버는 첫 매치가 마지막 기록
    { type: 'mcp', server: 'fetch', status: 'failed' },
    { type: 'turn', ok: true },
    { type: 'mcp', server: 'fetch', status: 'disabled' }, // 더 오래된 기록 — 판정에 쓰이면 안 된다
    { type: 'mcp', server: 'sync', status: 'failed' },
  ];
  assert.equal(isNewMcpFailure(recent, { name: 'fetch', status: 'failed' }), false);  // 마지막과 동일 → 스킵
  assert.equal(isNewMcpFailure(recent, { name: 'fetch', status: 'disabled' }), true); // 상태 바뀜 → 기록
  assert.equal(isNewMcpFailure(recent, { name: 'sync', status: 'failed' }), false);
  assert.equal(isNewMcpFailure(recent, { name: 'memory', status: 'failed' }), true);  // 신규 서버
  assert.equal(isNewMcpFailure([], { name: 'fetch', status: 'failed' }), true);
});

test('mcpRecoveries(순수): 직전 기록이 실패였던 서버의 복구만 1회 — 연속 connected·무기록·crew는 제외', async () => {
  const { mcpRecoveries } = await import('../src/chat.mjs');
  const init = { mcp_servers: [
    { name: 'fetch', status: 'connected' },  // 직전 실패 → 복구 기록 대상
    { name: 'sync', status: 'connected' },   // 직전 기록이 이미 복구(ok:true) → 재기록 없음
    { name: 'memory', status: 'connected' }, // 원장 무기록 → 기록 없음(첫 connected는 서사가 아님)
    { name: 'crew', status: 'connected' },   // 내장 — 항상 제외
    { name: 'broken', status: 'failed' },    // 실패는 이 함수의 대상 아님
  ] };
  const recent = [ // 최신순(readEvents 계약)
    { type: 'mcp', server: 'fetch', status: 'failed', ok: false },
    { type: 'mcp', server: 'sync', status: 'connected', ok: true },
    { type: 'mcp', server: 'fetch', status: 'disabled', ok: false }, // 더 오래된 기록 — 무시
  ];
  assert.deepEqual(mcpRecoveries(init, recent).map((s) => s.name), ['fetch']);
  assert.deepEqual(mcpRecoveries(init, []), []); // 원장이 비면 복구 서사도 없다
  // 복구 기록 후 다음 턴: fetch의 마지막 기록이 ok:true → 재실패가 상태 변화로 잡히는 전제 성립
  const afterRecovery = [{ type: 'mcp', server: 'fetch', status: 'connected', ok: true }, ...recent];
  assert.deepEqual(mcpRecoveries(init, afterRecovery), []);
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
  assert.match(route, /injected: omittedSet\.has\(s\.id\) \? 'omitted' : refSet\.has\(s\.id\) \? 'ref' : 'full'/, 'injected 3상태 — omitted를 ref로 뭉개면 배지가 거짓(검수 R2)');
  const page = await readFile(new URL('../app/c/[ws]/market/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /market\.skillRefBadge/, '스킬 ref 배지');
  assert.match(page, /market\.skillOmittedBadge/, '스킬 omitted(무명) 배지 — 제3 상태 표기');
  assert.match(page, /market\.mcpRunnerNote/, 'MCP 러너 조건 배너(설치 시점 안내 — 유건 요구)');
  const crew = await readFile(new URL('../app/c/[ws]/crew/[slug]/page.jsx', import.meta.url), 'utf8');
  assert.match(crew, /chat\.card\.mcpCliWarn/, '크루 카드 CLI 러너 경고');
  assert.match(crew, /sel\.runner \|\| autoRunnerId/, '자동 크루도 실제 받을 러너로 CLI 경고 판정(검수 L4)');
  assert.match(crew, /chat\.card\.scopeReset/, 'none 고착 복구 수단');
  assert.match(crew, /scopePartialHint/, '부분 선택 = 신규 미적용 경고');
  const runnersRoute = await readFile(new URL('../app/api/runners/route.js', import.meta.url), 'utf8');
  // 판정 자체는 코어 autoRunnerOf(= pickRunner ∘ 회사상태)가 단위로 잠근다(test/runners-route.test.mjs) —
  // 여기는 라우트가 그 코어 함수를 응답에 배선하는지만 본다(옛 인라인 pickRunner 앵커는 리팩터에 거짓 red).
  assert.match(runnersRoute, /autoRunnerId: autoRunnerOf\(company\)/, '자동 러너 판정은 코어 단일 진실을 배선(폴백 순서 클라 복제 금지)');
  assert.match(runnersRoute, /autoRunnerId/, '자동 크루의 실제 러너를 응답에 노출');
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(chat, /const fails = mcpFailures\(msg\)/, 'init에서 순수 판정 경유 소비(검수 M1)');
  assert.match(chat, /if \(!isNewMcpFailure\(recent, sv\)\) continue;/, '연속 중복 억제 경유 후에만 원장 기록(관찰 정리)');
  assert.match(chat, /type: 'mcp', server: sv\.name, status: sv\.status, ok: false/, '실패를 원장에(ok:false — 오류 집계 포함, 검수 M2)');
  // 검수 PR #211 N: 이 한 줄이 복구 서사 전체의 하중을 진다 — fails.length로 되돌리면 복구 감지가
  // 통째로 죽는데(정상 턴에 원장을 안 읽음) 다른 게이트는 전부 침묵했다(변이 N green 실증).
  assert.match(chat, /const hasMcp = \(msg\?\.mcp_servers \?\? \[\]\)\.some/, '원장 조회 게이트는 hasMcp — 복구 감지는 정상 턴에도 원장이 필요하다');
  // 검수 PR #211 M: 실패 루프와 대칭 — 복구 기록이 순수 판정(mcpRecoveries)을 경유하는 배선.
  assert.match(chat, /for \(const sv of mcpRecoveries\(msg, recent\)\)/, '복구 서사는 순수 판정 경유로만 기록');
  const activity = await readFile(new URL('../app/c/[ws]/activity/page.jsx', import.meta.url), 'utf8');
  assert.match(activity, /href: `\/c\/\$\{ws\}\/market`, linkLabel: t\('nav\.market'\)/, 'mcp 행 라벨=목적지(/market) 이름 — 설정 라벨 불일치 정리');
  const market = await readFile(new URL('../src/market.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(market, /playwright/, '내장 스킬이 카탈로그에 없는 이름을 제안하면 안 된다(puppeteer가 정본)');
});

test('mcpFailures(순수): 실패만·crew 제외·상태 없는 항목 보류(검수 M1 — 분기를 단위로 잠금)', async () => {
  const { mcpFailures } = await import('../src/chat.mjs');
  const out = mcpFailures({ mcp_servers: [
    { name: 'crew', status: 'failed' },        // 내장 — 제외
    { name: 'memory', status: 'connected' },   // 정상 — 제외
    { name: 'fetch', status: 'failed' },
    { name: 'sync', status: 'disabled' },
    { name: 'odd' },                            // 상태 없음 — 판단 보류
  ] });
  assert.deepEqual(out.map((s) => s.name), ['fetch', 'sync']);
  assert.deepEqual(mcpFailures({}), []);
  assert.deepEqual(mcpFailures(null), []);
});

test('loadSkills: 손상 항목(디렉터리·읽기 실패)이 턴을 죽이지 않는다(검수 M3)', async () => {
  const { mkdir: mk } = await import('node:fs/promises');
  const ws = 'ski-3';
  const { createCompany: cc, paths: pp } = await import('../src/workspace.mjs');
  await cc(ws, '관용검증', 'captain');
  const dir = pp(ws).skills;
  await mk(join(dir, 'a-폴더.md'), { recursive: true }); // 디렉터리인데 .md — EISDIR 유발
  await writeFile(join(dir, 'b-정상.md'), '# 정상\n지침');
  const out = await loadSkills(ws, 6000, 'ko');
  assert.match(out, /### 스킬: b-정상/); // 손상 항목을 건너뛰고 정상분은 산다
  assert.doesNotMatch(out, /a-폴더/);
});
