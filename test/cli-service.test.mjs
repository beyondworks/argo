// argo run 서비스 파일 — ARGO_ROOT 같은 값에 XML·개행이 섞여도 새 키(NODE_OPTIONS 등)가 추가되지 않는다(분리 검수 2026-09-30 MEDIUM).
// plist는 macOS plutil로 실제 파싱해 키 집합과 값 왕복을 본다(문자열 비교가 아니라 launchd가 읽는 모양 그대로).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { launchdPlist, systemdUnit, runArgs } from '../src/cli/service.mjs';
import { writeConfig } from '../src/cli/env.mjs';

const evil = `/legit</string><key>NODE_OPTIONS</key><string>--require=/tmp/evil.js`;

test('plist — 값에 XML을 넣어도 환경변수 키는 ARGO_ROOT·LANG 둘뿐이고 값은 그대로 돌아온다', { skip: process.platform !== 'darwin' && 'plutil은 macOS 전용' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-svc-'));
  const f = join(dir, 'x.plist');
  writeFileSync(f, launchdPlist({ label: 'com.test.argo', node: '/usr/bin/node & co', bin: '/a/"b"/argo.mjs', env: { ARGO_ROOT: evil, LANG: 'ko_KR.UTF-8' }, log: '/tmp/<log>' }));
  const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j.EnvironmentVariables).sort(), ['ARGO_ROOT', 'LANG']);
  assert.equal(j.EnvironmentVariables.ARGO_ROOT, evil);
  assert.deepEqual(j.ProgramArguments, ['/usr/bin/node & co', '/a/"b"/argo.mjs', 'run']);
  assert.equal(j.StandardErrorPath, '/tmp/<log>');
});

test('systemd — 개행이 든 값은 거부해 Environment= 줄이 추가되지 않고, 따옴표·%는 이스케이프한다', () => {
  assert.throws(() => systemdUnit({ node: '/n', bin: '/b', env: { ARGO_ROOT: '/x\nEnvironment=NODE_OPTIONS=--require=/tmp/evil.js' } }), /control characters/);
  assert.throws(() => systemdUnit({ node: '/n\n', bin: '/b', env: {} }), /control characters/);
  const u = systemdUnit({ node: '/opt/my node/node', bin: '/b/argo.mjs', env: { ARGO_ROOT: '/r/"q"/50%', LANG: 'en_US.UTF-8' } });
  assert.match(u, /^ExecStart="\/opt\/my node\/node" "\/b\/argo\.mjs" run$/m);
  assert.match(u, /^Environment="ARGO_ROOT=\/r\/\\"q\\"\/50%%"$/m);
  assert.equal(u.match(/^Environment=/gm).length, 2);
});

test('상주 실행 인자 — 아는 역할 표지만 넣고(예비가 이긴다), 모르는 값·공백·제어 문자는 유닛·plist에 들어가지 않는다', () => {
  assert.deepEqual(runArgs([]), ['run']);
  assert.deepEqual(runArgs(['--standby']), ['run', '--standby']);
  assert.deepEqual(runArgs(['--no-prefer']), ['run', '--no-prefer']);
  assert.deepEqual(runArgs(['--no-prefer', '--standby']), ['run', '--standby'], '둘 다 주면 예비(가져가지 않는 쪽)');
  assert.deepEqual(runArgs(['--evil', 'x;rm -rf /']), ['run'], '모르는 값은 버린다');
  assert.match(systemdUnit({ node: '/n', bin: '/b', env: {}, args: runArgs(['--standby']) }), /^ExecStart="\/n" "\/b" run --standby$/m);
  assert.throws(() => systemdUnit({ node: '/n', bin: '/b', env: {}, args: ['run', '--x\nExecStartPre=/bin/evil'] }), /bad service argument/);
  assert.throws(() => launchdPlist({ label: 'l', node: '/n', bin: '/b', env: {}, log: '/l', args: ['run', 'a b'] }), /bad service argument/);
});

test('cli.json — 이미 느슨한 권한(0644)으로 있던 파일도 쓰면 0600이 된다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'argo-cfg-'));
  const env = { ARGO_CLI_HOME: home };
  writeConfig({ lang: 'ko' }, env);
  chmodSync(join(home, 'cli.json'), 0o644);
  writeConfig({ ws: 'x' }, env);
  if (process.platform !== 'win32') assert.equal(statSync(join(home, 'cli.json')).mode & 0o777, 0o600); // win32: POSIX 모드 미지원
});

// ─── 리눅스 사용자 서비스 등록 — linger·user bus(헤드리스 서버 VPS 0.1.100 제보, 2026-10-10) ───
import { installLinuxUserService, userBusEnv } from '../src/cli/service.mjs';
// 가짜 loginctl·systemctl — linger: 처음 상태, allow: enable-linger 권한, bus: 이 env로 사용자 systemd에 닿는가
function fakeHost({ linger = false, allow = false, bus = (env) => !!env.XDG_RUNTIME_DIR, busFile = false } = {}) {
  const calls = [];
  const state = { linger };
  const sh = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env });
    if (cmd === 'loginctl' && args.includes('show-user')) return { status: 0, stdout: `Linger=${state.linger ? 'yes' : 'no'}\n` };
    if (cmd === 'loginctl' && args.includes('enable-linger')) { if (allow) { state.linger = true; return { status: 0 }; } return { status: 1, stderr: 'Access denied' }; }
    if (cmd === 'systemctl') return { status: bus(opts.env ?? {}) ? 0 : 1, stderr: 'Failed to connect to bus: No such file or directory' };
    return { status: 0 };
  };
  const exists = (p) => (typeof busFile === 'function' ? busFile(state) : busFile) && p === '/run/user/1001/bus';
  return { sh, exists, calls, state, sleep: () => {} };
}
const run = (h, env = {}) => installLinuxUserService({ user: 'crew', uid: 1001, env, sh: h.sh, exists: h.exists, sleep: h.sleep });

test('service install(리눅스) — linger가 꺼져 있고 켤 권한이 없으며 user bus도 없으면 등록하지 않고 needLinger로 알린다', () => {
  const h = fakeHost();
  const r = run(h);
  assert.deepEqual(r, { ok: false, linger: false });
  const enable = h.calls.find((c) => c.args.includes('enable-linger'));
  assert.deepEqual(enable.args, ['--no-ask-password', 'enable-linger', 'crew'], '암호를 묻는 창 없이 한 번 켜 본다');
  assert.ok(!h.calls.some((c) => c.cmd === 'sudo'), 'sudo는 부르지 않는다');
  assert.ok(!h.calls.some((c) => c.args.includes('restart')), '등록·시작은 하지 않는다');
});
test('service install(리눅스) — su로 바꾼 셸(XDG_RUNTIME_DIR 없음)이라도 linger가 켜져 있어 /run/user/<uid>/bus가 있으면 그 bus로 등록한다', () => {
  const h = fakeHost({ linger: true, busFile: true });
  const r = run(h, { PATH: '/usr/bin' });
  assert.deepEqual(r, { ok: true, linger: true });
  const restart = h.calls.find((c) => c.args.includes('restart'));
  assert.equal(restart.env.XDG_RUNTIME_DIR, '/run/user/1001');
  assert.ok(!h.calls.some((c) => c.args.includes('enable-linger')), '이미 켜져 있으면 다시 켜지 않는다');
});
test('service install(리눅스) — 권한이 있어 linger를 방금 켰으면 사용자 systemd가 뜰 때까지 잠깐 기다려 등록한다', () => {
  let polls = 0;
  const h = fakeHost({ allow: true, busFile: (s) => s.linger && ++polls > 3 }); // 켠 뒤 몇 번 확인해야 bus가 생긴다
  const r = run(h);
  assert.deepEqual(r, { ok: true, linger: true });
  assert.ok(h.calls.some((c) => c.args.includes('restart')));
});
test('service install(리눅스) — linger가 꺼져 있어도 지금 셸에 user bus가 있으면 등록하고, 결과에 linger 꺼짐을 남긴다(안내용)', () => {
  const h = fakeHost({ bus: () => true });
  assert.deepEqual(run(h, { XDG_RUNTIME_DIR: '/run/user/1001' }), { ok: true, linger: false });
});
test('userBusEnv — 이미 bus 주소가 있으면 그대로, 없을 때만 /run/user/<uid>를 채운다', () => {
  const env = { XDG_RUNTIME_DIR: '/custom' };
  assert.equal(userBusEnv(env, 5, () => true), env);
  assert.deepEqual(userBusEnv({}, 5, (p) => p === '/run/user/5/bus'), { XDG_RUNTIME_DIR: '/run/user/5' });
  assert.deepEqual(userBusEnv({}, 5, () => false), {});
  assert.deepEqual(userBusEnv({}, 5, (p) => p === '/run/user/5/systemd/private'), { XDG_RUNTIME_DIR: '/run/user/5' }, 'dbus-user-session이 없는 서버도 systemd 개인 소켓으로 닿는다(컨테이너 실측)');
});
