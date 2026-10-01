// 적재된 트리에서 argo CLI가 **실제로 실행**된다 — 파일이 있는지만 보는 것으로는 부족하다(반대 검토 L-g, 2026-10-01).
// Next standalone 사본의 패키지는 일부 파일만 있고(zod 415/718 등), CLI는 서버가 안 쓰는 모듈·패키지를 import한다. 그래서 scripts/stage-cli.mjs가 만든 트리
// (Next 추적물 없이 CLI 몫만)에서 ① `argo status`가 끝까지 돌고 ② src의 모든 모듈이 import되는지 본다. 새 패키지를 import하면서 CLI_DEPS에 안 넣으면 여기서 red다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, existsSync, cpSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';
import { stageCli } from '../scripts/stage-cli.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const base = await mkdtemp(join(tmpdir(), 'argo-stage-cli-tree-'));
const tree = join(base, 'server');
mkdirSync(tree, { recursive: true });
writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'argo', version: '0.0.0-fixture', type: 'module' }));
// 두 stage 스크립트가 stageCli 앞에서 하는 일 — Claude Agent SDK 스코프 전체(플랫폼 네이티브 CLI 포함, stage-sidecar 3.4·stage-server 3). 이 패키지는 CLI_DEPS가 아니라 그 단계가 싣는다.
cpSync(join(ROOT, 'node_modules', '@anthropic-ai'), join(tree, 'node_modules', '@anthropic-ai'), { recursive: true });
const staged = stageCli({ root: ROOT, tree, env: { NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture' }, publicEnv: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] });
const env = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: join(base, 'home'), USERPROFILE: join(base, 'home'), ARGO_CLI_HOME: join(base, 'cli'), ARGO_CLI_APP: '1', LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', ARGO_ENC_VAULT: '0' };
mkdirSync(env.HOME, { recursive: true });

test('적재 결과 — 의존성 폐포가 복사되고 공개 설정이 구워진다', () => {
  assert.ok(staged.deps >= 6 && staged.publicConfig);
  for (const f of ['bin/argo.mjs', 'bin/argo-public.json', 'src/cli/env.mjs', 'instrumentation-node.mjs', 'node_modules/@supabase/supabase-js/package.json', 'node_modules/zod/package.json']) assert.ok(existsSync(join(tree, f)), f);
});

test('적재된 트리에서 argo status가 끝까지 돈다(데이터 폴더는 앱 폴더, 공개 설정은 구운 파일에서)', () => {
  const r = spawnSync(process.execPath, [join(tree, 'bin', 'argo.mjs'), 'status'], { cwd: base, env, encoding: 'utf8', timeout: 90_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /데이터: .*com\.beyondworks\.argo/);
});

test('적재된 트리에서 src의 모든 모듈이 import된다 — CLI_DEPS에 없는 패키지를 쓰는 모듈이 없다', () => {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name)); else if (e.name.endsWith('.mjs')) files.push(join(d, e.name)); } };
  walk(join(tree, 'src'));
  // *-stdio.mjs는 자식 프로세스 진입점(릴레이 환경 없이 import하면 스스로 종료한다) — 모듈이 아니라 실행 파일
  files.splice(0, files.length, ...files.filter((f) => !/-stdio\.mjs$/.test(f)));
  const script = `
const files = ${JSON.stringify(files.map((f) => pathToFileURL(f).href))};
const bad = [];
for (const f of files) { try { await import(f); } catch (e) { bad.push(f.split('/src/')[1] + ' — ' + String(e?.message ?? e).split('\\n')[0].slice(0, 160)); } }
process.stdout.write('\\n@@' + JSON.stringify(bad) + '\\n');
process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: base, env: { ...env, ARGO_ROOT: join(base, 'root') }, encoding: 'utf8', timeout: 120_000 });
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `${r.stdout.slice(-600)}\n${r.stderr.slice(-600)}`);
  assert.deepEqual(JSON.parse(line.slice(2)), [], `${files.length}개 중 import 실패`);
});
