#!/usr/bin/env node
// 네이티브 엔진 산출물 검사 — standalone 빌드(.next/standalone)에서 Grep 워커가 실제로 로드되는지 **실행으로** 확인한다.
// 배경(재검수 NEW-HIGH-2 2026-09-05): webpack이 `new URL('./grep-worker.mjs', import.meta.url)`을 청크 에셋(/_next/NNNN.js)으로 재작성해
// `next start`·사이드카(standalone/server.js)에서 MODULE_NOT_FOUND가 났는데, 소스만 임포트하는 단위 테스트·CI는 이 축을 전혀 못 봤다.
// 절차: ① ARGO_STANDALONE=1 로컬 모드 빌드(이미 있으면 재사용: --rebuild로 강제) ② standalone/src/engine/grep-worker.mjs 존재 ③ 임시 ARGO_ROOT에
// 회사·크루·가짜 openrouter 자격 시드 ④ 가짜 Messages 서버(1턴: Grep tool_use → 최종 답) ⑤ standalone server.js 부팅(사이드카와 같은 cwd 규약)
// ⑥ /api/companies/<ws>/chat 실호출 → 두 번째 요청의 tool_result가 실제 검색 결과인지(MODULE_NOT_FOUND 아님) 확인 ⑦ 정리.
// 실벤더 호출 0. 상주 :3001·~/.argo 무접촉. 사용: node scripts/native-standalone-smoke.mjs [--rebuild] [--port 3162]
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, cpSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 3162;
const standalone = join(ROOT, '.next', 'standalone');
const log = (...a) => console.log('[standalone-smoke]', ...a);
const fail = (m) => { console.error('[standalone-smoke] FAIL:', m); process.exit(1); };

// ① 빌드(로컬 모드 — NEXT_PUBLIC_*는 빌드 시 인라인되므로 여기서 비운다)
if (args.includes('--rebuild') || !existsSync(join(standalone, 'server.js'))) {
  log('standalone 빌드(로컬 모드)…');
  execFileSync('npx', ['next', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, ARGO_STANDALONE: '1', NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' } });
}
// ② 워커 파일이 산출물에 복사됐는가(nft 추적 — next.config outputFileTracingIncludes)
const workerInStandalone = join(standalone, 'src', 'engine', 'grep-worker.mjs');
if (!existsSync(workerInStandalone)) fail(`워커가 standalone에 없다: ${workerInStandalone}`);
log('워커 산출물 존재:', workerInStandalone);
if (!existsSync(join(standalone, '.next', 'static'))) cpSync(join(ROOT, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });

// ③ 시드
const argoRoot = await mkdtemp(join(tmpdir(), 'argo-standalone-smoke-'));
process.env.ARGO_ROOT = argoRoot;
const { createCompany, paths } = await import(join(ROOT, 'src', 'workspace.mjs'));
const { saveRunnerCred } = await import(join(ROOT, 'src', 'runners', 'creds.mjs'));
const ws = 'sa-smoke';
await createCompany(ws, '산출물 스모크', '스모크');
await mkdir(paths(ws).agents, { recursive: true }); await mkdir(join(paths(ws).root, 'vault'), { recursive: true });
await writeFile(join(paths(ws).agents, 'seoyun.md'), '---\nname: 서윤\nrole: QA\nrunner: openrouter\nmodel: fake/model\n---\n# 서윤\n');
await writeFile(join(paths(ws).root, 'vault', 'facts.md'), 'STANDALONE-CANARY line\n');
await saveRunnerCred(ws, 'openrouter', 'apikey', 'fake-openrouter-key-for-standalone-smoke');

// ④ 가짜 Messages 서버
const bodies = [];
const fake = createServer((req, res) => {
  let d = ''; req.on('data', (c) => { d += c; });
  req.on('end', () => {
    bodies.push(JSON.parse(d || '{}'));
    const first = bodies.length === 1;
    const content = first
      ? [{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'STANDALONE-CANARY', path: 'vault', output_mode: 'content' } }]
      : [{ type: 'text', text: 'grep done' }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'fake/model', content, stop_reason: first ? 'tool_use' : 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

// ⑤ standalone 서버 부팅 — 사이드카(lib.rs)와 같은 규약: cwd=standalone, `node server.js`
const child = spawn(process.execPath, ['server.js'], { cwd: standalone, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, PORT: String(PORT), HOSTNAME: '127.0.0.1', ARGO_ROOT: argoRoot, ARGO_NATIVE_RUNNERS: 'openrouter', OPENROUTER_BASE_URL: fakeBase,
  NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', ARGO_MODEL_CATALOG: 'off',
} });
let serverLog = ''; child.stdout.on('data', (d) => { serverLog += d; }); child.stderr.on('data', (d) => { serverLog += d; });
const cleanup = async () => { child.kill('SIGKILL'); fake.close(); await rm(argoRoot, { recursive: true, force: true }).catch(() => {}); };
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`); up = r.ok; } catch { /* 부팅 중 */ } if (!up) await new Promise((r) => setTimeout(r, 500)); }
  if (!up) fail(`standalone 서버가 뜨지 않았다\n${serverLog.slice(-1500)}`);
  // ⑥ 실턴
  const r = await fetch(`http://127.0.0.1:${PORT}/api/companies/${ws}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'seoyun', message: 'facts.md에서 카나리 찾아' }) });
  const j = await r.json();
  const toolResult = bodies[1]?.messages?.at(-1)?.content?.[0];
  log('응답:', JSON.stringify(j).slice(0, 200));
  log('tool_result:', JSON.stringify(toolResult).slice(0, 200));
  if (!toolResult || toolResult.is_error || !/STANDALONE-CANARY/.test(String(toolResult.content))) fail(`Grep 워커가 산출물에서 돌지 않았다 — tool_result: ${JSON.stringify(toolResult)}\n서버 로그: ${serverLog.slice(-1500)}`);
  if (j.reply !== 'grep done') fail(`턴이 완주하지 않았다: ${JSON.stringify(j).slice(0, 300)}`);
  log('OK — standalone 산출물에서 네이티브 Grep 워커 실행·턴 완주');
} finally { await cleanup(); }
