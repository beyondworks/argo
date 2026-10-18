// 메신저 v2 체험 환경 관문(scripts/msgr2-trial-guard.mjs) — 주소 허용 목록·공개 키만·.env 섞임·데이터 폴더. 셸 스크립트는 이 관문이 exit 5면 아무것도 띄우지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { targetProblems, envFilesIn, rootProblems, readEnvFile, QBWR_URL, QBWR_REF } from '../scripts/msgr2-trial-guard.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
const ANON = jwt({ iss: 'supabase', ref: QBWR_REF, role: 'anon' });

test('주소: qbwr만 통과(끝 / 허용), 다른 supabase 주소·빈 값은 멈춤, 로컬 하네스는 가짜 모드에서만', () => {
  assert.deepEqual(targetProblems({ url: QBWR_URL, anonKey: ANON }), []);
  assert.deepEqual(targetProblems({ url: `${QBWR_URL}/`, anonKey: ANON }), []);
  assert.match(targetProblems({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: ANON }).join(), /허용하지 않은 주소/);
  assert.match(targetProblems({ url: '', anonKey: ANON }).join(), /주소가 없습니다/);
  assert.match(targetProblems({ url: 'http://127.0.0.1:5297', anonKey: 'x' }).join(), /허용하지 않은 주소/);
  assert.deepEqual(targetProblems({ url: 'http://127.0.0.1:5297', anonKey: 'fake-anon-key', fake: true }), []);
  assert.match(targetProblems({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: ANON, fake: true }).join(), /허용하지 않은 주소/, '가짜 모드도 다른 원격 주소는 멈춤');
});

test('키: anon JWT(ref qbwr)·sb_publishable_만, service_role·sb_secret_·다른 ref·빈 값은 멈춤 — 이유에 키 값을 싣지 않는다', () => {
  assert.deepEqual(targetProblems({ url: QBWR_URL, anonKey: 'sb_publishable_abc' }), []);
  const svc = jwt({ ref: QBWR_REF, role: 'service_role' });
  const p1 = targetProblems({ url: QBWR_URL, anonKey: svc });
  assert.match(p1.join(), /공개 키가 아닙니다\(role=service_role\)/);
  assert.ok(!p1.join().includes(svc), '키 값 미출력');
  assert.match(targetProblems({ url: QBWR_URL, anonKey: 'sb_secret_zzz' }).join(), /비밀 키/);
  assert.match(targetProblems({ url: QBWR_URL, anonKey: jwt({ ref: 'otherprojectref00000', role: 'anon' }) }).join(), /프로젝트\(ref\)가 qbwr가 아닙니다/);
  assert.match(targetProblems({ url: QBWR_URL, anonKey: '' }).join(), /공개 키가 없습니다/);
  assert.match(targetProblems({ url: QBWR_URL, anonKey: 'not-a-key' }).join(), /키 모양을 알 수 없습니다/);
});

test('.env 섞임: 루트·apps/messenger의 .env* 파일을 찾고(.env.example은 둔다), 데이터 폴더는 msgr2-trial 이름·체크아웃 workspaces 밖만', () => {
  const d = mkdtempSync(join(tmpdir(), 'trial-guard-'));
  try {
    mkdirSync(join(d, 'apps', 'messenger'), { recursive: true });
    assert.deepEqual(envFilesIn([d, join(d, 'apps', 'messenger')]), []);
    writeFileSync(join(d, '.env.example'), 'X=\n');
    writeFileSync(join(d, 'apps', 'messenger', '.env.local'), 'VITE_SUPABASE_URL=x\n');
    assert.deepEqual(envFilesIn([d, join(d, 'apps', 'messenger')]), [join(d, 'apps', 'messenger', '.env.local')]);
    assert.deepEqual(rootProblems(join(d, 'msgr2-trial', 'root'), d), []);
    assert.match(rootProblems(join(d, 'workspaces'), d).join(), /msgr2-trial/);
    assert.match(rootProblems(join(d, 'workspaces', 'msgr2-trial'), d).join(), /workspaces 폴더는 쓰지 않습니다/);
    writeFileSync(join(d, 'k.env'), '# 주석\nMSGR2_TRIAL_URL="https://x"\nMSGR2_TRIAL_ANON_KEY=abc\n');
    assert.deepEqual(readEnvFile(join(d, 'k.env')), { MSGR2_TRIAL_URL: 'https://x', MSGR2_TRIAL_ANON_KEY: 'abc' });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('CLI: 걸리면 exit 5와 이유(표준 오류, 키 값 없음)·표준 출력 비움, 통과하면 셸 변수 두 줄만', () => {
  const d = mkdtempSync(join(tmpdir(), 'trial-guard-cli-'));
  const run = (args, env = {}) => spawnSync(process.execPath, [new URL('../scripts/msgr2-trial-guard.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: d, ...env } });
  try {
    const bad = run(['--checkout', d], { MSGR2_TRIAL_URL: 'https://abcdefghijklmnopqrst.supabase.co', MSGR2_TRIAL_ANON_KEY: ANON });
    assert.equal(bad.status, 5); assert.equal(bad.stdout, ''); assert.match(bad.stderr, /허용하지 않은 주소/); assert.ok(!bad.stderr.includes(ANON));
    const ok = run(['--checkout', d], { MSGR2_TRIAL_URL: `${QBWR_URL}/`, MSGR2_TRIAL_ANON_KEY: ANON });
    assert.equal(ok.status, 0, ok.stderr); assert.equal(ok.stdout, `MSGR2_TRIAL_URL='${QBWR_URL}'\nMSGR2_TRIAL_ANON_KEY='${ANON}'\n`);
    writeFileSync(join(d, '.env.local'), 'A=1\n');
    const dirty = run(['--checkout', d], { MSGR2_TRIAL_URL: QBWR_URL, MSGR2_TRIAL_ANON_KEY: ANON });
    assert.equal(dirty.status, 5); assert.match(dirty.stderr, /\.env 파일이 있습니다/);
    rmSync(join(d, '.env.local'));
    assert.equal(run(['--checkout', d, '--root', join(d, 'workspaces')], { MSGR2_TRIAL_URL: QBWR_URL, MSGR2_TRIAL_ANON_KEY: ANON }).status, 5, '데이터 폴더 관문');
    assert.equal(run(['--checkout', d, '--fake']).status, 0, '가짜 모드: 로컬 하네스 기본값');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
