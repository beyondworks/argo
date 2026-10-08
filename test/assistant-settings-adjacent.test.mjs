// 능동 비서 2단계(설정 API·에이전트 카드 "비서" 탭) — 고치기 전에 먼저 잠그는 인접 행동.
// 2단계는 비서 켜짐 판정을 assistant.json 하나가 아니라 company.json의 봉인(assistantSeal)과 대조하게 한다(옛 버전 기기의 에이전트는
// 옛 권한 게이트 때문에 assistant.json을 쓸 수 있다 — #863 2차 검수 LOW). 그 설계가 기대는 지금 동작:
//  ① 에이전트는 파일 쓰기·셸로 company.json을 고치지 못한다(#141, 2026-07-28부터 모든 버전).
//  ② 회사 설정 API(PUT /api/companies/[ws])는 정해진 칸만 받는다 — 본문에 다른 칸(assistantSeal)을 실어도 저장하지 않는다.
//  ③ company.json을 고치는 공용 관문(updateCompany)은 자기가 모르는 칸을 그대로 둔다 — 다른 설정을 저장해도 봉인이 지워지지 않는다.
// 셋 다 이 PR 전 코드(origin/main)에서 통과해야 한다(옛 동작 고정). 에이전트 카드의 기존 칸 배치는 test/tabs-layout.test.mjs가 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-asst-adj2-'));
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'ARGO_SYNC']) delete process.env[k]; // 인증 꺼짐(로컬 모드) — 라우트 실호출
const { register } = await import('node:module');
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
globalThis.__argoScheduler = true; globalThis.__argoGateway = true; // 회사 라우트 임포트가 상주 데몬(타이머)을 띄우지 않게(company-load-errors 관례)
const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');

const company = async (ws) => JSON.parse(await readFile(paths(ws).company, 'utf8'));
const SEAL = 'a'.repeat(64);

test('① 에이전트는 파일 쓰기·셸로 company.json을 고치지 못한다', async () => {
  await createCompany('adj-gate', '게이트', 'owner', 'u1');
  const root = paths('adj-gate').root;
  const gate = makePermissionGate('adj-gate', 'pepper', root);
  const deny = async (tool, input) => (await gate(tool, input)).behavior;
  assert.equal(await deny('Write', { file_path: join(root, 'company.json'), content: `{"assistantSeal":"${SEAL}"}` }), 'deny');
  assert.equal(await deny('Edit', { file_path: join(root, 'company.json'), old_string: '{', new_string: '{"assistantSeal":"x",' }), 'deny');
  assert.equal(await deny('Bash', { command: `echo '{"assistantSeal":"${SEAL}"}' > company.json` }), 'deny');
  assert.equal(await deny('Bash', { command: `jq '.assistantSeal="x"' ./company.json > /tmp/c && mv /tmp/c company.json` }), 'deny');
});

test('② 회사 설정 API는 정해진 칸만 저장한다 — 본문의 assistantSeal은 무시', async () => {
  await createCompany('adj-route', '라우트', 'owner');
  const route = await import('../app/api/companies/[ws]/route.js');
  const res = await route.PUT(new Request('http://localhost/api/companies/adj-route', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '새 이름', assistantSeal: SEAL }),
  }), { params: Promise.resolve({ ws: 'adj-route' }) });
  assert.equal(res.status, 200);
  const c = await company('adj-route');
  assert.equal(c.name, '새 이름');
  assert.equal('assistantSeal' in c, false, '정해진 칸 밖은 저장하지 않는다');
});

test('③ 다른 설정을 저장해도 company.json의 모르는 칸(봉인)은 그대로 — updateCompany·회사 설정 API', async () => {
  await createCompany('adj-keep', '보존', 'owner');
  await updateCompany('adj-keep', () => ({ assistantSeal: SEAL }));
  await updateCompany('adj-keep', (c) => ({ msgr: { ...(c.msgr ?? {}), enabled: true } }));
  assert.equal((await company('adj-keep')).assistantSeal, SEAL, '중첩 칸 갱신(함수 패치)');
  const route = await import('../app/api/companies/[ws]/route.js');
  const res = await route.PUT(new Request('http://localhost/api/companies/adj-keep', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lang: 'en', fullAuto: true }),
  }), { params: Promise.resolve({ ws: 'adj-keep' }) });
  assert.equal(res.status, 200);
  const c = await company('adj-keep');
  assert.equal(c.lang, 'en');
  assert.equal(c.assistantSeal, SEAL, '회사 설정 저장이 봉인을 지우지 않는다');
});
