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
