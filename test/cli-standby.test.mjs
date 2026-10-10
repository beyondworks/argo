// argo run --standby · argo service install --standby — 서버(VPS)를 예비 실행 기기로 띄우는 입구를 실제 명령으로 잠근다.
// ① run --standby는 리스 글에 standby 표지를 남기고(가짜 Supabase), 기본 run은 종전대로 우선 기기(preferred)다.
// ② service install --standby는 상주 파일(systemd 유닛·launchd plist)의 실행 인자에 --standby를 넣는다 — 지금까지는 ExecStart가 'run'으로 고정돼 옵션을 못 넣었다.
//    launchctl·systemctl·loginctl은 가짜 실행 파일(PATH 앞)로 바꿔 이 컴퓨터의 실제 상주를 건드리지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
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

/** 상주(argo run …)를 띄워 리스 글이 생길 때까지(또는 until(out)이 참일 때까지) 기다린다 — 러너 자격(API 키)을 시드해 '러너 없음' 양보(160초)를 타지 않게 한다.
    seedLease: 미리 둘 다른 기기의 리스 글, noCompany: 이 기기 폴더에 회사가 아직 없는 상태(첫 동기화 전). */
async function runResident(args, { seedLease = null, noCompany = false, until = null } = {}) {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const base = await mkdtemp(join(tmpdir(), 'argo-cli-standby-'));
  const root = join(base, 'root'); const home = join(base, 'home'); mkdirSync(home, { recursive: true });
  seedRoot(root, { url: fake.url });
  if (seedLease) fake.store.set(LEASE_KEY, Buffer.from(JSON.stringify(seedLease)));
  if (noCompany) rmSync(join(root, 'co-1234', 'company.json'));
  const env = baseEnv({ HOME: home, USERPROFILE: home, ARGO_CLI_HOME: join(base, 'cli'), ARGO_ROOT: root, ARGO_SYNC_CYCLE_MS: '1000', NEXT_PUBLIC_SUPABASE_URL: fake.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture' });
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { saveRunnerCred } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/runners/creds.mjs')).href)});
    await saveRunnerCred('co-1234', 'claude', 'apikey', 'sk-ant-api03-' + 'x'.repeat(80));`], { env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const c = spawn(process.execPath, [BIN, ...args], { env }); kids.push(c);
  let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
  let doc = null;
  const done = () => (until ? until(out) : doc && !seedLease);
  for (let i = 0; i < 40 && !done(); i++) { await sleep(500); const b = fake.store.get(LEASE_KEY); doc = b ? JSON.parse(b.toString()) : null; }
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

// ─── 시작 안내는 판정 뒤의 실제 결과로(VPS 0.1.100 제보 2026-10-10: "company - · 이 기기가 먼저 맡음"이라 했는데 실제로는 맥에 양보) ───
const ROLE_LINE = /^실행 담당:/m;
test('argo run — 시작 줄은 역할 설정만 말하고, 리스를 확인한 뒤에야 "실행 담당: 이 기기가 맡았습니다"를 한 줄 낸다', { timeout: 60_000 }, async () => {
  const { out } = await runResident(['run'], { until: (o) => ROLE_LINE.test(o) });
  const start = out.indexOf('상주를 시작했습니다');
  assert.ok(start >= 0, out.slice(-1500));
  assert.match(out, /^회사: Fixture$/m, '이미 이 기기에 있는 회사는 바로 보여 준다');
  assert.match(out, /^실행 담당: 이 기기가 맡았습니다/m, out.slice(-1500));
  assert.ok(out.indexOf('[argo] 동기화: 실행 리더 획득') < out.search(ROLE_LINE), `리스 획득 로그보다 먼저 맡았다고 말하지 않는다\n${out.slice(-1500)}`);
  assert.doesNotMatch(out, /company -|회사 -/);
});
test('argo run --standby — 다른 기기가 살아 있는 리스를 갖고 있으면 그 기기가 맡고 있다고 알린다(맡았다고 하지 않는다)', { timeout: 60_000 }, async () => {
  const lease = { deviceId: 'Geony-Mac-Pro-test', token: 't-mac', ts: Date.now(), assistant: 2 };
  const { out } = await runResident(['run', '--standby'], { seedLease: lease, until: (o) => ROLE_LINE.test(o) });
  assert.match(out, /^실행 담당: 다른 기기\(Geony-Mac-Pro-test\)가 맡고 있어 이 기기는 대기합니다/m, out.slice(-1500));
  assert.doesNotMatch(out, /이 기기가 맡았습니다/);
});
test('argo run — 이 기기에 회사가 아직 없으면 "-" 대신 불러오는 중이라고 말하고, 실행 담당도 판정 전에는 말하지 않는다', { timeout: 60_000 }, async () => {
  const { out } = await runResident(['run'], { noCompany: true, until: (o) => /불러오는 중/.test(o) });
  assert.match(out, /^회사를 불러오는 중입니다\(동기화 중\)/m, out.slice(-1500));
  assert.doesNotMatch(out, /company -|회사 -|회사: -/);
  assert.doesNotMatch(out, /이 기기가 맡았습니다/);
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
async function serviceInstall(args, { lingerExit = 0, systemctlExit = 0 } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'argo-svc-')); // 테스트 끝에 지워진다(helpers/tmp.mjs)
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

test('argo service install --standby — 상주 파일의 실행 인자가 run --standby다', { skip: process.platform === 'win32' && '윈도우는 서비스 등록 미지원' }, async () => {
  const { r, body, calls } = await serviceInstall(['install', '--standby']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(runArgs(body), ['run', '--standby']);
  assert.match(calls, process.platform === 'darwin' ? /launchctl bootstrap/ : /systemctl --user enable argo-cli\.service/);
  assert.match(r.stdout, /예비/, '등록 안내가 예비 역할을 말한다');
});

test('역할을 바꿔 다시 등록하면(argo service install → --standby) 돌고 있는 상주를 새 실행 인자로 다시 시작한다 — enable --now만으로는 옛 인자로 계속 돈다', { skip: process.platform === 'win32' && '윈도우는 서비스 등록 미지원' }, async () => {
  const { r, body, calls } = await serviceInstall(['install', '--standby']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(runArgs(body), ['run', '--standby']);
  const lines = calls.trim().split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  if (process.platform === 'darwin') {
    assert.ok(at(/^launchctl bootout /) >= 0 && at(/^launchctl bootout /) < at(/^launchctl bootstrap /), `내린 뒤 다시 올린다\n${calls}`);
  } else {
    // systemd: start(= enable --now)는 이미 active인 유닛에 아무 일도 하지 않는다 — 바뀐 ExecStart는 다음 재시작 때에야 적용됐다(D 1차 검수)
    assert.ok(at(/^systemctl --user daemon-reload$/) >= 0, calls);
    assert.ok(at(/^systemctl --user restart argo-cli\.service$/) > at(/^systemctl --user daemon-reload$/), `새 유닛을 읽은 뒤 다시 시작한다\n${calls}`);
    assert.ok(at(/^systemctl --user enable argo-cli\.service$/) >= 0, `재부팅 뒤에도 켜지게 enable\n${calls}`);
    assert.equal(at(/enable --now/), -1, calls);
  }
});

test('argo service install(기본) — 종전대로 run만(우선 기기)', { skip: process.platform === 'win32' && '윈도우는 서비스 등록 미지원' }, async () => {
  const { r, body } = await serviceInstall(['install']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(runArgs(body), ['run']);
});

test('리눅스: linger를 켜지 못하면(관리자 권한 필요) 관리자 명령을 안내한다 — 조용히 넘어가면 로그아웃 때 상주가 꺼진다', { skip: process.platform !== 'linux' && 'systemd 사용자 서비스는 리눅스 전용' }, async () => {
  const fail = await serviceInstall(['install', '--standby'], { lingerExit: 1 });
  assert.equal(fail.r.status, 0);
  assert.match(fail.r.stdout + fail.r.stderr, /sudo loginctl enable-linger crew/);
  const ok = await serviceInstall(['install', '--standby'], { lingerExit: 0 });
  assert.doesNotMatch(ok.r.stdout + ok.r.stderr, /sudo loginctl enable-linger/);
});

test('리눅스: linger가 켜져 있는데 사용자 systemd에 닿지 못하면(su로 바꾼 셸 등) 실패로 끝내고 SSH 로그인·XDG_RUNTIME_DIR을 안내한다', { skip: process.platform !== 'linux' && 'systemd 사용자 서비스는 리눅스 전용' }, async () => {
  const r = await serviceInstall(['install', '--standby'], { lingerExit: 0, systemctlExit: 1 });
  assert.equal(r.r.status, 1);
  assert.match(r.r.stderr, /systemctl --user/);
  assert.match(r.r.stderr, /XDG_RUNTIME_DIR/);
});
test('리눅스: linger가 꺼져 있고 켤 권한도 없어 사용자 systemd에 닿지 못하면, 먼저 실행할 관리자 명령(sudo loginctl enable-linger) 한 줄로 안내한다(VPS 제보 2026-10-10)', { skip: process.platform !== 'linux' && 'systemd 사용자 서비스는 리눅스 전용' }, async () => {
  const r = await serviceInstall(['install', '--standby'], { lingerExit: 1, systemctlExit: 1 });
  assert.equal(r.r.status, 1);
  assert.match(r.r.stderr, /sudo loginctl enable-linger crew — 그다음 argo service install을 다시 실행하세요/);
  assert.match(r.calls, /loginctl --no-ask-password enable-linger crew/, '암호를 묻지 않고 한 번 켜 본다');
  assert.doesNotMatch(r.calls, /systemctl --user (enable|restart)/, '등록하지 못했으니 시작하지 않는다');
});
