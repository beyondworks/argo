// 운영 읽기 전용 점검 스크립트(2026-10-08) — psql 세션마다 첫 SQL 문장이 읽기 전용 set인지 본다.
// 종전 PGOPTIONS 방식은 Supavisor 풀러가 시작 옵션을 버려 운영에서 default_transaction_read_only=off였다(show로 관찰). 보호 장치가 가짜였다.
// 가짜 psql(PATH 앞)이 받은 -c 값과 표준 입력을 기록한다. 접속 정보는 가짜 값이고 네트워크에 나가지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skip = process.platform === 'win32' && '운영 점검은 맥 운영 전용 bash 스크립트(윈도우 CI의 bash 경로가 달라 픽스처가 성립하지 않는다)';
const RO = 'set default_transaction_read_only = on;';
const OUT = Symbol('out');
const SCRIPTS = [['db-health.sh'], ['db-rate.sh', '0'], ['incident-2026-09-23-diagnose.sh'], ['incident-2026-09-23-member.sh'], ['incident-2026-09-23-dump.sh', OUT]];

test('운영 읽기 전용 스크립트는 psql 세션마다 첫 SQL 문장에서 읽기 전용을 건다(풀러가 PGOPTIONS를 버린다)', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'argo-db-ro-'));
  try {
    for (const d of ['scripts', 'bin', 'out']) mkdirSync(join(root, d));
    writeFileSync(join(root, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://fixtureref.supabase.co\nSUPABASE_DB_PASSWORD=fixture\n');
    const log = join(root, 'psql.log');
    // psql은 -c가 있으면 표준 입력을 읽지 않는다 — 그때는 -c 값들이, 없으면 표준 입력(heredoc)이 그 세션의 SQL이다.
    // -q가 없으면 결과 첫 줄에 SET이 섞인다(dump의 tsv 대조가 틀어진다) — 호출마다 -q 여부도 기록한다
    writeFileSync(join(root, 'bin/psql'), `#!/bin/sh\nL=${JSON.stringify(log)}\nq=0; for a in "$@"; do [ "$a" = -q ] && q=1; done\necho "--call q=$q" >> "$L"\nc=0\nwhile [ $# -gt 0 ]; do if [ "$1" = -c ]; then printf '%s;\\n' "$2" >> "$L"; c=1; fi; shift; done\n[ $c = 1 ] || cat >> "$L"\n`, { mode: 0o755 });
    for (const [name, arg] of SCRIPTS) {
      copyFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), join(root, 'scripts', name));
      writeFileSync(log, '');
      const args = arg === OUT ? [join(root, 'out')] : arg ? [arg] : [];
      const r = spawnSync('bash', [join('scripts', name), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, PGOPTIONS: '' } });
      assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
      const calls = readFileSync(log, 'utf8').split('--call ').slice(1).map((c) => c.split('\n').map((l) => l.trim()).filter(Boolean));
      assert.ok(calls.length >= 1, `${name}: psql 호출 없음`);
      for (const [q, ...sql] of calls) {
        assert.equal(q, 'q=1', `${name}: -q 없이 부르면 결과에 SET 줄이 섞인다`);
        assert.equal(sql[0], RO, `${name}: 세션 첫 문장이 읽기 전용 set이 아니다\n${sql.slice(0, 3).join('\n')}`);
        if (name === 'db-health.sh') assert.ok(sql.slice(0, sql.findIndex((l) => !l.startsWith('set '))).includes('set statement_timeout = 60000;'), '점검 조회는 60초 제한도 첫 select 전에 건다');
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
