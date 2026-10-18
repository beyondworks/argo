// 메신저 v2 체험 실행 스크립트(scripts/msgr2-trial-*.sh)를 맥 기본 /bin/bash(3.2)로 실제로 돌린다 — 임시 체크아웃에 스크립트 사본과 가짜 vite·tauri·next·cargo를 두고 본다.
// #1099 검수: qbwr 모드 app.sh가 bash 3.2 + set -u에서 빈 배열로 죽던 것, 관문의 직접 실행 판정이 링크·공백·한글 경로에서 거짓이 되어 검사 없이 통과하던 것.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, chmodSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const BASH = '/bin/bash';
const skip = !existsSync(BASH) && '/bin/bash 없음';
const REPO = new URL('..', import.meta.url).pathname;
const QBWR = 'https://qbwrlynzvjmphwuqglsx.supabase.co';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const ANON = `${b64({ alg: 'HS256' })}.${b64({ ref: 'qbwrlynzvjmphwuqglsx', role: 'anon' })}.sig`;
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/** 임시 체크아웃 — base 아래 name 폴더. 스크립트는 사본, 의존은 가짜. 반환 { co, home, bin, out } */
function checkout(base, name = 'co') {
  const co = join(base, name); const home = join(base, 'home'); const bin = join(base, 'bin'); const out = join(base, 'out');
  for (const d of [join(co, 'scripts'), join(co, 'apps/messenger/node_modules/vite/bin'), join(co, 'apps/messenger/node_modules/.bin'), join(co, 'apps/messenger/src-tauri'), join(co, 'node_modules/next/dist/bin'), join(home, '.argo'), bin, out]) mkdirSync(d, { recursive: true });
  for (const f of ['msgr2-trial-guard.mjs', 'msgr2-trial-web.sh', 'msgr2-trial-app.sh', 'msgr2-trial-body.sh']) copyFileSync(join(REPO, 'scripts', f), join(co, 'scripts', f));
  // 가짜 vite: 포트를 열고, 받은 서버 주소와 키가 있는지만 기록한다(키 값은 적지 않는다)
  writeFileSync(join(co, 'apps/messenger/node_modules/vite/bin/vite.js'), `require('node:fs').writeFileSync(${JSON.stringify(join(out, 'vite.json'))}, JSON.stringify({ url: process.env.VITE_SUPABASE_URL, key: !!process.env.VITE_SUPABASE_ANON_KEY, v2: process.env.VITE_MSGR_V2, svc: 'SUPABASE_SERVICE_ROLE_KEY' in process.env }));
require('node:http').createServer((q, r) => r.end('ok')).listen(Number(process.env.MSGR2_TRIAL_WEB_PORT), '127.0.0.1');\n`);
  writeFileSync(join(co, 'apps/messenger/node_modules/.bin/tauri'), `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(join(out, 'tauri.args'))}\nexit 0\n`); chmodSync(join(co, 'apps/messenger/node_modules/.bin/tauri'), 0o755);
  writeFileSync(join(co, 'apps/messenger/src-tauri/tauri.conf.json'), JSON.stringify({ app: { windows: [{ title: 'Argo Messenger', width: 1100 }] } }));
  writeFileSync(join(co, 'node_modules/next/dist/bin/next'), `require('node:fs').writeFileSync(${JSON.stringify(join(out, 'next.json'))}, JSON.stringify({ args: process.argv.slice(2), url: process.env.NEXT_PUBLIC_SUPABASE_URL, link: process.env.ARGO_AGENT_LINK, legacy: process.env.ARGO_MSGR_LEGACY, root: process.env.ARGO_ROOT, svc: 'SUPABASE_SERVICE_ROLE_KEY' in process.env }));\n`);
  writeFileSync(join(bin, 'cargo'), '#!/bin/bash\nexit 0\n'); chmodSync(join(bin, 'cargo'), 0o755);
  writeFileSync(join(home, '.argo', 'msgr2-trial.env'), `MSGR2_TRIAL_URL=${QBWR}\nMSGR2_TRIAL_ANON_KEY=${ANON}\n`);
  return { co, home, bin, out };
}
const run = (c, script, args, extraEnv = {}) => spawnSync(BASH, [script, ...args], { encoding: 'utf8', timeout: 60_000,
  env: { PATH: `${c.bin}:${process.env.PATH}`, HOME: c.home, TMPDIR: tmpdir(), SUPABASE_SERVICE_ROLE_KEY: 'should-not-pass', ...extraEnv } });

test('app.sh qbwr 모드(--fake 없이)를 /bin/bash 3.2로 — 빈 배열로 죽지 않고 화면 서버를 띄운 뒤 tauri dev를 trial 설정으로 부르고, 끝나면 화면 서버를 끈다', { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'trial-app-'));
  try {
    const c = checkout(base); const port = await freePort();
    const r = run(c, join(c.co, 'scripts/msgr2-trial-app.sh'), ['--port', String(port)]);
    assert.equal(r.status, 0, r.stderr);
    const args = readFileSync(join(c.out, 'tauri.args'), 'utf8').trim().split('\n');
    assert.deepEqual(args.slice(0, 3), ['dev', '--no-watch', '--config']);
    const conf = JSON.parse(args[3]);
    assert.equal(conf.identifier, 'com.beyondworks.argo.messenger.trial');
    assert.equal(conf.build.devUrl, `http://127.0.0.1:${port}`);
    assert.deepEqual(conf.app.windows, [{ title: 'Argo Messenger Trial (qbwr)', width: 1100 }], '창 설정은 원본에서 읽고 제목만');
    assert.deepEqual(JSON.parse(readFileSync(join(c.out, 'vite.json'), 'utf8')), { url: QBWR, key: true, v2: '1', svc: false }, '화면 서버: qbwr·v2 켜짐, 셸의 비밀 변수는 넘어가지 않는다');
    const alive = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}/`], { encoding: 'utf8' }).stdout;
    assert.equal(alive, '000', '앱이 끝나면 화면 서버도 꺼진다');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('body.sh qbwr 모드 — 환경을 비우고(셸의 서비스 키 미전달) 3310·연결 켜짐·옛 브리지 꺼짐·데이터 폴더로 next dev', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'trial-body-'));
  try {
    const c = checkout(base); const root = join(base, 'msgr2-trial', 'root');
    const r = run(c, join(c.co, 'scripts/msgr2-trial-body.sh'), ['--root', root]);
    assert.equal(r.status, 0, r.stderr);
    const n = JSON.parse(readFileSync(join(c.out, 'next.json'), 'utf8'));
    assert.deepEqual(n, { args: ['dev', '-H', '127.0.0.1', '-p', '3310'], url: QBWR, link: '1', legacy: 'off', root, svc: false });
    assert.equal(run(c, join(c.co, 'scripts/msgr2-trial-body.sh'), ['--port', '3001', '--root', root]).status, 5, '3001 거부');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('링크·공백·한글 경로로 실행해도 관문이 돈다 — 운영 같은 주소·.env.local·잘못된 데이터 폴더는 exit 5, 아무것도 띄우지 않는다', { skip }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'trial-path-')));
  try {
    const c = checkout(base, '한글 폴더 co');
    const link = join(base, 'link'); symlinkSync(c.co, link);
    writeFileSync(join(c.home, '.argo', 'msgr2-trial.env'), `MSGR2_TRIAL_URL=https://abcdefghijklmnopqrst.supabase.co\nMSGR2_TRIAL_ANON_KEY=${ANON}\n`);
    for (const s of [join(link, 'scripts/msgr2-trial-body.sh'), join(c.co, 'scripts/msgr2-trial-body.sh')]) {
      const r = run(c, s, ['--root', join(base, 'msgr2-trial', 'root')]);
      assert.equal(r.status, 5, `${s}: ${r.stderr}`); assert.match(r.stderr, /허용하지 않은 주소/);
    }
    const g = spawnSync(process.execPath, [join(link, 'scripts/msgr2-trial-guard.mjs'), '--checkout', link], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(g.status, 5, '링크 경로로 관문을 직접 불러도 검사한다'); assert.equal(g.stdout, '');
    writeFileSync(join(c.home, '.argo', 'msgr2-trial.env'), `MSGR2_TRIAL_URL=${QBWR}\nMSGR2_TRIAL_ANON_KEY=${ANON}\n`);
    assert.equal(run(c, join(link, 'scripts/msgr2-trial-body.sh'), ['--root', join(c.co, 'workspaces')]).status, 5, '데이터 폴더 관문');
    writeFileSync(join(c.co, '.env.local'), 'A=1\n');
    const e = run(c, join(link, 'scripts/msgr2-trial-web.sh'), []);
    assert.equal(e.status, 5); assert.match(e.stderr, /\.env 파일이 있습니다/);
    assert.ok(!existsSync(join(c.out, 'next.json')) && !existsSync(join(c.out, 'vite.json')), '아무것도 띄우지 않았다');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('관문이 값을 내지 않고 exit 0으로 끝나도(판정 실수) 셸은 멈춘다 — web·body·app 셋 다', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'trial-silent-'));
  try {
    const c = checkout(base);
    writeFileSync(join(c.co, 'scripts/msgr2-trial-guard.mjs'), '// 아무것도 하지 않는 관문\n');
    for (const [s, a] of [['msgr2-trial-web.sh', []], ['msgr2-trial-body.sh', ['--root', join(base, 'msgr2-trial', 'root')]], ['msgr2-trial-app.sh', []]]) {
      const r = run(c, join(c.co, 'scripts', s), a);
      assert.equal(r.status, 5, `${s}: ${r.stderr}`); assert.match(r.stderr, /관문이 값을 내지 않았습니다/);
    }
    assert.ok(!existsSync(join(c.out, 'next.json')) && !existsSync(join(c.out, 'vite.json')) && !existsSync(join(c.out, 'tauri.args')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
