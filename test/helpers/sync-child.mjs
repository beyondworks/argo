// 동기화 루프(ensureSync)를 **별도 프로세스**로 돌리고 syncStatus()를 받는다 — 루프는 끝나지 않는 타이머라 테스트 프로세스 안에서 돌리면
// 테스트 파일이 끝나지 않는다. 같은 데이터 루트를 두 프로세스가 쓰는 상황(동기화 락·리스·기기 세션 회전)도 이 방식으로만 재현된다.
// 자식 환경은 서비스키·공개 설정·리더 플래그를 지운 뒤 필요한 것만 넣는다 — 개발자 셸 값이 판정을 바꾸지 않게.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = (rel) => new URL(`../../src/${rel}`, import.meta.url).href;
const STRIP = ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'ARGO_TENANT_OWNER', 'ARGO_SYNC_OWNER',
  'ARGO_NO_LEADER', 'ARGO_PREFER_LEADER', 'ARGO_STANDBY_LEADER', 'ARGO_ENFORCE_PLAN', 'ARGO_SYNC', 'ARGO_SYNC_CYCLE_MS', 'ARGO_STANDALONE', 'ARGO_PARENT_PID'];

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
  // 기기 id를 미리 둔다 — 실제 기기는 이미 갖고 있다. 없으면 동시에 처음 켜진 두 자식이 서로 다른 id를 만들어 같은 기기가 아니게 된다.
  writeFileSync(join(root, '.device-id'), 'fixture-mac-0001');
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

/** 오래 도는 자식 — 동기화 루프 + (선택) 실행 리스(daemonLease: 게이트웨이·스케줄러가 쓰는 프로세스 단위 리스)를 켜고,
    intervalMs마다 { t, proc(게이트웨이 리스), sched, cloud(isCloudLeader) }를 내보낸다. 게이트웨이 폴러가 실제로 도는 조건은
    proc && cloud다(gateway.mjs ensureGateway). 테스트는 이 표본으로 "그 조건이 참인 프로세스가 정확히 하나"를 본다.
    kill()은 SIGKILL — 크래시·강제 종료(락·리스 파일이 그대로 남는다)를 흉내 낸다.
    nudgeForMs > 0이면 시작부터 그 시간 동안 nudgeEveryMs마다 nudgeSync()를 부른다 — 앱에서 대화를 보내 동기화 주기가 기다림 없이 연달아 도는 경우.
    awakeAgoMs를 주면 이 프로세스가 그만큼 전부터 깨어 있던 것으로 시작한다(sync.mjs 되찾기 조건 AWAKE_MIN_MS — 기본은 기동 순간부터 센다).
    운영 주기 장면을 짧게 돌리려는 것이다. 주지 않으면 실제 기동처럼 센다. */
export function spawnLeaseChild({ root, env = {}, leases = ['gateway', 'scheduler'], runnerUsable = true, intervalMs = 300, name = '', nudgeForMs = 0, nudgeEveryMs = 300, awakeAgoMs = null }) {
  const script = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: ${runnerUsable ? 'true' : 'false'} };
${awakeAgoMs == null ? '' : `globalThis.__argoSyncAwake = { since: Date.now() - ${Number(awakeAgoMs)} };`}
const { daemonLease } = await import(${JSON.stringify(SRC('lock.mjs'))});
const sync = await import(${JSON.stringify(SRC('sync.mjs'))});
const held = Object.fromEntries(${JSON.stringify(leases)}.map((n) => [n, daemonLease(n)]));
sync.ensureSync();
const nudgeUntil = Date.now() + ${Number(nudgeForMs)};
if (${Number(nudgeForMs)} > 0) { const iv = setInterval(() => { if (Date.now() > nudgeUntil) clearInterval(iv); else sync.nudgeSync(); }, ${Number(nudgeEveryMs)}); }
setInterval(() => {
  process.stdout.write('\\n@@' + JSON.stringify({ t: Date.now(), proc: !!held.gateway?.isLeader(), sched: !!held.scheduler?.isLeader(), cloud: sync.isCloudLeader() }) + '\\n');
}, ${Number(intervalMs)});`;
  const startedAt = Date.now();
  const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root, env), stdio: ['ignore', 'pipe', 'pipe'] });
  const samples = []; let buf = ''; let err = ''; let exited = false;
  p.stdout.on('data', (c) => {
    buf += c; const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) if (l.startsWith('@@')) { try { samples.push(JSON.parse(l.slice(2))); } catch { /* 잘린 줄 */ } }
  });
  p.stderr.on('data', (c) => { err += c; });
  const done = new Promise((r) => p.on('exit', () => { exited = true; r(); }));
  return {
    name, samples, pid: p.pid, startedAt,
    get err() { return err; },
    alive: () => !exited,
    last: () => samples[samples.length - 1] ?? null,
    kill: async () => { if (!exited) { p.kill('SIGKILL'); await done; } },
  };
}

/** 시각 t에 살아 있던 자식들의 직전 표본(1초 이내)으로 "게이트웨이가 도는 프로세스 수"(proc && cloud)를 센다. */
export function runnersAt(children, t, { field = 'proc' } = {}) {
  let n = 0;
  for (const c of children) {
    const s = [...c.samples].reverse().find((x) => x.t <= t);
    if (s && t - s.t <= 1000 && (c.diedAt == null || t < c.diedAt) && s[field] && s.cloud) n++;
  }
  return n;
}
