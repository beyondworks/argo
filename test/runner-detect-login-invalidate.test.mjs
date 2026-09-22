// 본체 전수 검수(2026-09-22) K77 — runnerStatus는 10분 감지 캐시(detectRunners)를 쓴다. CLI 로그인을 마친 직후에도
// 캐시가 authed:false로 데워져 있으면 저장된 "이 컴퓨터 로그인"(host) 마커가 최대 10분 '재연결 필요'(invalid)로 남았다.
// 처방: 로그인 완료를 관찰하는 자리(runnerLoginStatus가 authed:true를 볼 때)에서 감지 캐시를 버린다.
// runnerStatus 자체를 force로 바꾸지 않는다(페이지마다 CLI 4종 스폰 2.7초 — exec.mjs 캐시 주석).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const HOME = await mkdtemp(join(tmpdir(), 'argo-k77-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.SHELL = '/usr/bin/true';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-k77-root-'));
process.env.ARGO_CACHE_DIR = await mkdtemp(join(tmpdir(), 'argo-k77-cache-'));
delete process.env.ARGO_CODEX_PREFER_PATH;

const { runnerLoginStatus } = await import('../src/runners/exec.mjs');
const { runnerStatus } = await import('../src/runners.mjs');
process.env.PATH = '/usr/bin:/bin';

test('K77 CLI 로그인 완료가 관찰되면 host 마커가 10분 캐시 때문에 "재연결 필요"로 남지 않는다',
  { skip: process.platform === 'win32' ? 'POSIX 셸 가짜 codex' : false }, async () => {
  const WS = 'k77co';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await writeFile(join(process.env.ARGO_ROOT, WS, 'company.json'), JSON.stringify({ id: WS, name: 'T', created: '2026-09-22T00:00:00Z' }));
  await writeFile(join(process.env.ARGO_ROOT, WS, '.secrets.json'), JSON.stringify({ runners: { codex: { type: 'host', value: 'host' } } }));
  // 관리본 codex(설치됨) — 로그인 전: auth.json 없음
  const dir = join(HOME, '.argo', 'tools', 'codex-cli');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'codex'), '#!/bin/sh\nif [ "$1 $2" = "login status" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi\nexit 0\n');
  await chmod(join(dir, 'codex'), 0o755);
  assert.equal((await runnerStatus(WS)).codex.company.invalid, true, '전제: 로그인 전 host 마커는 무효(감지 캐시가 authed:false로 데워짐)');
  // 사용자가 브라우저 로그인을 마침 → 자격 파일 생김 → 연결 화면 폴링이 authed:true를 관찰
  await mkdir(join(HOME, '.codex'), { recursive: true });
  await writeFile(join(HOME, '.codex', 'auth.json'), '{}');
  assert.deepEqual(await runnerLoginStatus('codex'), { supported: true, authed: true });
  assert.ok(!(await runnerStatus(WS)).codex.company.invalid, '로그인을 관찰했는데 10분 캐시가 옛 authed:false를 돌려준다');
});
