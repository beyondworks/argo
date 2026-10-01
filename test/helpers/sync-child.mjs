// 동기화 루프(ensureSync)를 **별도 프로세스**로 돌리고 syncStatus()를 받는다 — 루프는 끝나지 않는 타이머라 테스트 프로세스 안에서 돌리면
// 테스트 파일이 끝나지 않는다. 같은 데이터 루트를 두 프로세스가 쓰는 상황(동기화 락·리스·기기 세션 회전)도 이 방식으로만 재현된다.
// 자식 환경은 서비스키·공개 설정·리더 플래그를 지운 뒤 필요한 것만 넣는다 — 개발자 셸 값이 판정을 바꾸지 않게.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = (rel) => new URL(`../../src/${rel}`, import.meta.url).href;
const STRIP = ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'ARGO_TENANT_OWNER', 'ARGO_SYNC_OWNER',
  'ARGO_NO_LEADER', 'ARGO_PREFER_LEADER', 'ARGO_ENFORCE_PLAN', 'ARGO_SYNC', 'ARGO_SYNC_CYCLE_MS', 'ARGO_STANDALONE', 'ARGO_PARENT_PID'];

export function childEnv(root, extra = {}) {
  const env = { ...process.env };
  for (const k of STRIP) delete env[k];
  return { ...env, ARGO_ROOT: root, HOME: root, ...extra };
}

/** 회사 하나 + 가짜 Supabase를 가리키는 기기 세션(만료 먼 — 회전 없음)을 깐다. */
export function seedRoot(root, { url, userId = 'u1', wsId = 'co-1234', expiresAt = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  mkdirSync(join(root, wsId), { recursive: true });
  writeFileSync(join(root, wsId, 'company.json'), JSON.stringify({ id: wsId, name: 'Fixture', ownerId: userId }));
  writeFileSync(join(root, '.device-session.json'), JSON.stringify({
    url, anonKey: 'anon-fixture', access_token: 'h.p.s', refresh_token: 'rt-0', expires_at: expiresAt, user: { id: userId, email: '' },
  }), { mode: 0o600 });
}

/** 자식에서 ensureSync()를 켜고 waitMs 뒤 syncStatus()를 JSON으로 돌려받는다.
    러너 프로브는 미리 채운다(globalThis.__argoRunnerProbe — sync.mjs가 60초 캐시로 쓰는 자리): 호스트 CLI 탐지(최대 5초·기기마다 다름)가
    리더 판정을 흔들지 않게. runnerUsable=false면 "러너 없는 기기"의 양보 경로를 탄다. */
export function runSyncChild({ root, env = {}, waitMs = 2500, runnerUsable = true }) {
  const script = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: ${runnerUsable ? 'true' : 'false'} };
const sync = await import(${JSON.stringify(SRC('sync.mjs'))});
sync.ensureSync();
await new Promise((r) => setTimeout(r, ${Number(waitMs)}));
const s = sync.syncStatus();
process.stdout.write('\\n@@' + JSON.stringify({ on: s.on, leader: s.leader, lastError: s.lastError, plan: s.plan }) + '\\n');
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`sync child timeout\n${err.slice(-2000)}`)); }, waitMs + 20_000);
    p.on('exit', () => {
      clearTimeout(t);
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`sync child gave no status\n${out.slice(-2000)}\n${err.slice(-2000)}`));
      resolve({ status: JSON.parse(line.slice(2)), out, err });
    });
  });
}

export const srcUrl = SRC;
export const repoPath = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
