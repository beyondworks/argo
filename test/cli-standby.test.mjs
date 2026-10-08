// argo run --standby · argo service install --standby — 서버(VPS)를 예비 실행 기기로 띄우는 입구를 실제 명령으로 잠근다.
// ① run --standby는 리스 글에 standby 표지를 남기고(가짜 Supabase), 기본 run은 종전대로 우선 기기(preferred)다.
// ② service install --standby는 상주 파일(systemd 유닛·launchd plist)의 실행 인자에 --standby를 넣는다 — 지금까지는 ExecStart가 'run'으로 고정돼 옵션을 못 넣었다.
//    launchctl·systemctl·loginctl은 가짜 실행 파일(PATH 앞)로 바꿔 이 컴퓨터의 실제 상주를 건드리지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot } from './helpers/sync-child.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(REPO, 'bin', 'argo.mjs');
const LEASE_KEY = 'companies/u1/_device-lease.json';
const fakes = []; const kids = [];
after(async () => { for (const k of kids) k.kill('SIGKILL'); for (const f of fakes) await f.close(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const baseEnv = (extra) => {
  const env = { ...process.env, LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off', ...extra };
  for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'ARGO_TENANT_OWNER', 'ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER', 'ARGO_CLI_APP', 'ARGO_SYNC', 'ARGO_PARENT_PID', 'ARGO_STANDALONE']) if (!(k in extra)) delete env[k];
  return env;
};

/** 상주(argo run …)를 띄워 리스 글이 생길 때까지 기다린다 — 러너 자격(API 키)을 시드해 '러너 없음' 양보(160초)를 타지 않게 한다. */
async function runResident(args) {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const base = await mkdtemp(join(tmpdir(), 'argo-cli-standby-'));
  const root = join(base, 'root'); const home = join(base, 'home'); mkdirSync(home, { recursive: true });
  seedRoot(root, { url: fake.url });
  const env = baseEnv({ HOME: home, USERPROFILE: home, ARGO_CLI_HOME: join(base, 'cli'), ARGO_ROOT: root, ARGO_SYNC_CYCLE_MS: '1000', NEXT_PUBLIC_SUPABASE_URL: fake.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture' });
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { saveRunnerCred } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/runners/creds.mjs')).href)});
    await saveRunnerCred('co-1234', 'claude', 'apikey', 'sk-ant-api03-' + 'x'.repeat(80));`], { env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const c = spawn(process.execPath, [BIN, ...args], { env }); kids.push(c);
  let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
  let doc = null;
  for (let i = 0; i < 40 && !doc; i++) { await sleep(500); const b = fake.store.get(LEASE_KEY); doc = b ? JSON.parse(b.toString()) : null; }
  c.kill('SIGKILL');
  return { doc, out };
}

test('argo run --standby — 리스 글에 standby 표지(우선 표지 없음), 시작 안내가 예비 역할을 말한다', { timeout: 60_000 }, async () => {
  const { doc, out } = await runResident(['run', '--standby']);
  assert.ok(doc, `리스 글이 생기지 않았다\n${out.slice(-1500)}`);
  assert.equal(doc.standby, true);
  assert.equal(doc.preferred, undefined);
  assert.match(out, /예비/, '시작 안내');
});

test('argo run(기본) — 종전대로 우선 기기(preferred 표지)', { timeout: 60_000 }, async () => {
  const { doc, out } = await runResident(['run']);
  assert.ok(doc, `리스 글이 생기지 않았다\n${out.slice(-1500)}`);
  assert.equal(doc.preferred, true);
  assert.equal(doc.standby, undefined);
});

/** 가짜 launchctl·systemctl·loginctl — 받은 인자를 로그에 적는다. loginctl enable-linger는 lingerExit로 끝나고(0이면 켜짐 표시 파일을 만든다),
    show-user는 그 표시 파일로 Linger=yes/no를 답한다(관리자 권한이 없어 켜지 못하는 SSH 셸 흉내). */
function stubs(dir, { lingerExit = 0, systemctlExit = 0 } = {}) {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'calls.log'); const on = join(dir, 'linger.on');
  for (const [name, code] of [['launchctl', 0], ['systemctl', systemctlExit]]) {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${code}\n`); chmodSync(f, 0o755);
  }
  const lc = join(dir, 'loginctl');
  writeFileSync(lc, `#!/bin/sh\necho "loginctl $*" >> "${log}"\nif [ "$1" = show-user ]; then if [ -f "${on}" ]; then echo Linger=yes; else echo Linger=no; fi; exit 0; fi\nif [ ${lingerExit} = 0 ]; then touch "${on}"; fi\nexit ${lingerExit}\n`); chmodSync(lc, 0o755);
  return log;
}
function serviceInstall(args, { lingerExit = 0, systemctlExit = 0 } = {}) {
  const base = join(tmpdir(), `argo-svc-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const home = join(base, 'home'); mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const log = stubs(join(base, 'bin'), { lingerExit, systemctlExit });
  const env = baseEnv({ HOME: home, USER: 'crew', ARGO_CLI_HOME: join(base, 'cli'), ARGO_ROOT: join(base, 'root'), PATH: `${join(base, 'bin')}:${process.env.PATH}` });
  const r = spawnSync(process.execPath, [BIN, 'service', ...args], { env, encoding: 'utf8' });
  const file = process.platform === 'darwin' ? join(home, 'Library', 'LaunchAgents', 'com.beyondworks.argo-cli.plist') : join(home, '.config', 'systemd', 'user', 'argo-cli.service');
  return { r, file, body: existsSync(file) ? readFileSync(file, 'utf8') : '', calls: existsSync(log) ? readFileSync(log, 'utf8') : '', base };
}
const runArgs = (body) => (process.platform === 'darwin'
  ? [...body.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]).filter((v) => v === 'run' || v.startsWith('--'))
  : (body.match(/^ExecStart=.*$/m)?.[0] ?? '').split(' ').slice(2));

test('argo service install --standby — 상주 파일의 실행 인자가 run --standby다', { skip: process.platform === 'win32' && '윈도우는 서비스 등록 미지원' }, () => {
  const { r, body, calls } = serviceInstall(['install', '--standby']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(runArgs(body), ['run', '--standby']);
  assert.match(calls, process.platform === 'darwin' ? /launchctl bootstrap/ : /systemctl --user enable --now argo-cli\.service/);
  assert.match(r.stdout, /예비/, '등록 안내가 예비 역할을 말한다');
});

test('argo service install(기본) — 종전대로 run만(우선 기기)', { skip: process.platform === 'win32' && '윈도우는 서비스 등록 미지원' }, () => {
  const { r, body } = serviceInstall(['install']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(runArgs(body), ['run']);
});

test('리눅스: linger를 켜지 못하면(관리자 권한 필요) 관리자 명령을 안내한다 — 조용히 넘어가면 로그아웃 때 상주가 꺼진다', { skip: process.platform !== 'linux' && 'systemd 사용자 서비스는 리눅스 전용' }, () => {
  const fail = serviceInstall(['install', '--standby'], { lingerExit: 1 });
  assert.equal(fail.r.status, 0);
  assert.match(fail.r.stdout + fail.r.stderr, /sudo loginctl enable-linger crew/);
  const ok = serviceInstall(['install', '--standby'], { lingerExit: 0 });
  assert.doesNotMatch(ok.r.stdout + ok.r.stderr, /sudo loginctl enable-linger/);
});

test('리눅스: 사용자 systemd에 닿지 못하면(su로 바꾼 셸 등) 실패로 끝내고 SSH 로그인·linger·XDG_RUNTIME_DIR을 안내한다', { skip: process.platform !== 'linux' && 'systemd 사용자 서비스는 리눅스 전용' }, () => {
  const r = serviceInstall(['install', '--standby'], { lingerExit: 1, systemctlExit: 1 });
  assert.equal(r.r.status, 1);
  assert.match(r.r.stderr, /systemctl --user/);
  assert.match(r.r.stderr, /sudo loginctl enable-linger crew/);
  assert.match(r.r.stderr, /XDG_RUNTIME_DIR/);
});
