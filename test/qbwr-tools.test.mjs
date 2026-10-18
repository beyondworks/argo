// qbwr 실전 시험 도구(U9) — 대상 검문(qbwr가 아니면 exit 5)과 합성 데이터 생성기(합성 계정만, 고정 id 접두)를 본다. DB에는 붙지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'qbwr-tools-'));
const run = (script, args, envText) => {
  const f = join(dir, `env-${Math.random().toString(36).slice(2)}`);
  if (envText != null) writeFileSync(f, envText);
  // psql을 부르기 전에 검문에서 멈춰야 한다 — PATH를 비워 psql이 있어도 못 부르게 한다(검문을 지나면 다른 오류로 끝난다)
  return spawnSync('bash', [`scripts/${script}`, ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir, QBWR_ENV: envText == null ? join(dir, 'none') : f } });
};
const PROD = 'nvqorpdorlbkhpcvwoty', QBWR = 'qbwrlynzvjmphwuqglsx';

test('대상 검문: 운영 ref·다른 프로젝트·운영 API 주소·파일 없음·변수 없음은 psql 전에 exit 5', () => {
  const cases = [
    ['운영 ref', `QBWR_DB_URL=postgresql://postgres.${PROD}:x@pooler/postgres\n`],
    ['운영 ref가 섞인 qbwr 문자열', `QBWR_DB_URL=postgresql://postgres.${QBWR}:x@h/postgres?x=${PROD}\n`],
    ['다른 프로젝트', 'QBWR_DB_URL=postgresql://postgres.abcdefgh:x@h/postgres\n'],
    ['API 주소가 운영', `QBWR_DB_URL=postgresql://postgres.${QBWR}:x@h/postgres\nNEXT_PUBLIC_SUPABASE_URL=https://${PROD}.supabase.co\n`],
    ['변수 없음', 'FOO=1\n'],
    ['파일 없음', null],
  ];
  for (const script of [['qbwr-apply.sh', ['plan']], ['qbwr-rate.sh', ['snap', join(dir, 's')]], ['qbwr-seed.sh', ['db']], ['qbwr-q.sh', ['q1']]]) {
    for (const [name, env] of cases) {
      const r = run(script[0], script[1], env);
      assert.equal(r.status, 5, `${script[0]} ${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /^거부 /, `${script[0]} ${name}`);
    }
  }
  // 운영 env 파일 이름은 내용과 상관없이 읽지 않는다
  const r = spawnSync('bash', ['scripts/qbwr-apply.sh', 'plan'], { cwd: ROOT, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', QBWR_ENV: '.env.local' } });
  assert.equal(r.status, 5); assert.match(r.stdout, /운영 env 파일/);
});

test('대상 검문: qbwr 접속 문자열이면 검문을 지난다(그 뒤 psql 단계에서 끝난다)', () => {
  const r = run('qbwr-apply.sh', ['plan'], `QBWR_DB_URL=postgresql://postgres.${QBWR}:x@127.0.0.1:1/postgres\n`);
  assert.notEqual(r.status, 5, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /거부/);
});

test('합성 데이터 생성기: 계정은 전부 @example.test, id는 c9 접두, 운영 ref·비밀번호 평문이 없다, 같은 씨앗이면 같은 SQL', () => {
  const gen = () => spawnSync('node', ['test/fixtures/msgr2/qbwr-seed.mjs', '--scale', '0.01', '--manifest', join(dir, 'm.json')], { cwd: ROOT, encoding: 'utf8' });
  const a = gen(), b = gen();
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  const emails = [...a.stdout.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g)].map((m) => m[0]);
  assert.equal(new Set(emails.filter((e) => e.startsWith('p'))).size, 60);
  assert.ok(emails.every((e) => e.endsWith('@example.test')), emails.find((e) => !e.endsWith('@example.test')));
  assert.ok(!a.stdout.includes(PROD));
  assert.match(a.stdout, /crypt\(current_setting\('argo\.seed_pw'\), gen_salt\('bf'\)\)/); // 비밀번호는 세션 설정에서만
  const ids = [...a.stdout.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12})'/g)].map((m) => m[1]);
  assert.ok(ids.length > 100 && ids.every((x) => x.startsWith('c9') || x === '00000000-0000-0000-0000-000000000000'), ids.find((x) => !x.startsWith('c9')));
  const m = JSON.parse(readFileSync(join(dir, 'm.json'), 'utf8'));
  assert.ok(m.length >= 1 && m.every((x) => x.bucket === 'msgr' && /^(c902[0-9a-f-]+\/c905[0-9a-f-]+|p\/c905[0-9a-f-]+)\/f\d+\.txt$/.test(x.path)));
});
