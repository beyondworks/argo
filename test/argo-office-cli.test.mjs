// argo office — 실제 명령(bin/argo.mjs)을 자식 프로세스로 실행해 가짜 Supabase(로컬 HTTP)에 무엇을 보내는지 잠근다.
// 요점: ① report는 인자를 office_session_report에 그대로 넘긴다 ② hold는 새 일(task.create, status hold·사유·출처 세션)과
// 있는 일(task.status hold·사유)을 가른다 ③ tasks는 끝내지 않은 일만 ④ 로그인이 없으면 안내 한 줄 + 종료 코드 2, 서버 호출 0
// ⑤ 만료 직전 세션은 기기 세션 회전 경로(getFreshDeviceSession)로 새 토큰을 받아 그 토큰으로 부른다.
// ⑥ hold 새 일은 --source-name(세션 제목)이 없으면 1 ⑦ 이미 보류인 일은 reason_only(사유만) ⑧ office는 cli.json 모드를 바꾸지 않고, ARGO_ROOT가 없으면 훅 폴더를 쓴다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const base = await mkdtemp(join(tmpdir(), 'argo-office-cli-'));
const ORG = '11111111-2222-4333-8444-555555555555';
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TASK = '99999999-8888-4777-8666-555555555555';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* 가짜 Supabase — rpc 이름별 응답을 테스트가 정한다. 토큰 회전은 한 번 쓴 refresh 토큰을 거절한다(GoTrue 재사용 감지). */
const calls = []; const tokens = []; const used = new Set();
let handlers = {};
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const path = new URL(req.url, 'http://x').pathname;
    const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (path === '/auth/v1/token') {
      const rt = JSON.parse(b || '{}').refresh_token; tokens.push(rt);
      if (used.has(rt)) return json(400, { code: 400, error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' });
      used.add(rt);
      return json(200, { access_token: `at-new-${tokens.length}`, refresh_token: `rt-new-${tokens.length}`, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'u1@example.test', aud: 'authenticated', role: 'authenticated' } });
    }
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(path);
    if (m) {
      calls.push({ fn: m[1], body: JSON.parse(b || '{}'), auth: req.headers.authorization ?? null });
      const [s, o] = handlers[m[1]]?.(JSON.parse(b || '{}')) ?? [200, null];
      return json(s, o);
    }
    if (path.startsWith('/rest/v1/')) return json(200, []); // 이름 조회(msgr_profiles) 등
    return json(404, { message: 'not found' });
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => srv.close());
const URL_ = `http://127.0.0.1:${srv.address().port}`;

let n = 0;
/** 격리 데이터 폴더 — session: 'ok' | 'expiring' | null, org: config.json 조직 */
async function makeRoot({ session = 'ok', org = null } = {}) {
  const root = join(base, `root-${++n}`); await mkdir(root, { recursive: true });
  if (session) {
    const exp = Math.floor(Date.now() / 1000) + (session === 'expiring' ? 10 : 3600);
    await writeFile(join(root, '.device-session.json'), JSON.stringify({ url: URL_, anonKey: 'anon-test', access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_at: exp, user: { id: 'u1', email: 'u1@example.test', nameAt: Date.now() } }), { mode: 0o600 });
  }
  if (org) await writeFile(join(root, 'config.json'), JSON.stringify({ org }));
  return root;
}
const HOME = join(base, 'home'); await mkdir(HOME, { recursive: true });
/** argo office … 실행 — 테스트 프로세스의 서버가 답해야 하므로 비동기 spawn(spawnSync면 서버가 멈춘다) */
function argo(root, args, { cliHome = join(base, 'cli') } = {}) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME, USERPROFILE: HOME, ARGO_CLI_HOME: cliHome, ...(root ? { ARGO_ROOT: root } : {}), LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', ARGO_SYNC: '0' };
    const p = spawn(process.execPath, [join(REPO, 'bin', 'argo.mjs'), 'office', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const since = () => { const k = calls.length; return () => calls.slice(k); };

test('report — 인자를 office_session_report에 그대로 넘기고 기기 세션 토큰으로 부른다, 보낸 값을 상태 파일에 남긴다', async () => {
  const root = await makeRoot();
  handlers = { office_session_report: () => [200, { ok: true, written: true }] };
  const got = since();
  const r = await argo(root, ['report', '--org', ORG, '--id', SID, '--name', '  오피스   업무 현황 ', '--project', 'argo', '--task', TASK]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /보고했습니다/);
  const c = got();
  assert.equal(c.length, 1);
  assert.equal(c[0].fn, 'office_session_report');
  assert.deepEqual(c[0].body, { p_id: SID, p_org: ORG, p_name: '오피스 업무 현황', p_project: 'argo', p_task: TASK }, '제목은 한 줄로 정리해서');
  assert.equal(c[0].auth, `Bearer at-${n}`);
  const st = JSON.parse(await readFile(join(root, 'sessions.json'), 'utf8'));
  assert.deepEqual(st[SID].sent, { org: ORG, name: '오피스 업무 현황', project: 'argo', task: TASK }, '훅이 이 값을 4분 안에 다시 보내지 않고 task를 이어 보낸다');
  // 서버가 '바뀐 것 없음'이라 하면 그렇게 말한다
  handlers = { office_session_report: () => [200, { ok: true, written: false }] };
  const r2 = await argo(root, ['report', '--org', ORG, '--id', SID, '--name', 'x', '--json']);
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(JSON.parse(r2.out), { ok: true, written: false });
  assert.equal(got().at(-1).body.p_task, null, '--task가 없으면 null');
  assert.equal(got().at(-1).body.p_project, null);
});

test('report — 입력이 틀리면 서버를 부르지 않고 1, 서버 거절은 사유 한 줄과 1', async () => {
  const root = await makeRoot();
  const got = since();
  for (const args of [['report', '--org', ORG, '--id', 'not-uuid', '--name', 'x'], ['report', '--org', ORG, '--id', SID, '--name', '   '],
    ['report', '--org', ORG, '--id', SID, '--name', 'x'.repeat(121)], ['report', '--org', 'bad', '--id', SID, '--name', 'x'], ['report', '--bogus']]) {
    const r = await argo(root, args);
    assert.equal(r.code, 1, `${args.join(' ')} → ${r.err}`);
  }
  assert.equal(got().length, 0, '입력 오류는 호출 0');
  handlers = { office_session_report: () => [400, { code: 'P0001', message: 'session_forbidden' }] };
  const r = await argo(root, ['report', '--org', ORG, '--id', SID, '--name', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.err, /권한이 없습니다/);
});

test('hold 새 일 — task.create(새 uuid, status hold, 사유, 출처 세션), 조직은 config.json에서', async () => {
  const root = await makeRoot({ org: ORG });
  handlers = { office_task_write: (b) => [200, { id: b.p_data.id, title: b.p_data.title, status: 'hold' }] };
  const got = since();
  const r = await argo(root, ['hold', '결제 화면 정리', '--reason', '로그인 버그부터', '--source-name', '맥가이버 - 정비사']);
  assert.equal(r.code, 0, r.err);
  const c = got();
  assert.equal(c.length, 1);
  assert.equal(c[0].fn, 'office_task_write');
  assert.equal(c[0].body.p_org, ORG);
  assert.equal(c[0].body.p_action, 'task.create');
  const d = c[0].body.p_data;
  assert.match(d.id, UUID);
  assert.deepEqual({ ...d, id: 'x' }, { id: 'x', title: '결제 화면 정리', status: 'hold', hold_reason: '로그인 버그부터', source: { kind: 'session', name: '맥가이버 - 정비사' } });
  assert.match(r.out, new RegExp(d.id), '만든 일의 id를 알려 준다');
  // --org가 config보다 먼저, 사유 없으면 호출 0
  const other = '22222222-3333-4444-8555-666666666666';
  await argo(root, ['hold', '다른 일', '--reason', 'r', '--org', other, '--source-name', '맥가이버 - 정비사']);
  assert.equal(got().at(-1).body.p_org, other);
  const k = got().length;
  const r3 = await argo(root, ['hold', '사유 없음', '--source-name', 'x']);
  assert.equal(r3.code, 1);
  assert.equal(got().length, k);
});

test('hold 새 일 — --source-name(세션 제목)이 없거나 비면 안내와 종료 1, 서버 호출 0', async () => {
  const root = await makeRoot({ org: ORG });
  handlers = { office_task_write: (b) => [200, { id: b.p_data.id }] };
  const got = since();
  for (const extra of [[], ['--source-name', '   ']]) {
    const r = await argo(root, ['hold', '결제 화면 정리', '--reason', '로그인 버그부터', ...extra]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /--source-name "<세션 제목>"을 꼭 넣어/);
  }
  assert.equal(got().length, 0, '출처 없는 보류 일은 만들지 않는다(에이전트 없이 맡긴 일로 잘못 분류된다)');
});

test('hold 있는 일 — 보류가 아닌 일은 task.status hold + 사유, 이미 보류인 일은 reason_only(사유만), 제목과 --task를 같이 주면 거절', async () => {
  const root = await makeRoot({ org: ORG });
  let status = 'doing';
  handlers = { office_task_list: () => [200, [{ id: TASK, title: '결제', status }, { id: SID, title: '딴 일', status: 'hold' }]], office_task_write: (b) => [200, { id: b.p_data.id, status: 'hold' }] };
  const got = since();
  const r = await argo(root, ['hold', '--task', TASK, '--reason', '디자인 확정 뒤에']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /보류로 바꿨습니다/);
  assert.deepEqual(got().map((c) => [c.fn, c.body]), [['office_task_list', { p_org: ORG }], ['office_task_write', { p_org: ORG, p_action: 'task.status', p_data: { id: TASK, status: 'hold', hold_reason: '디자인 확정 뒤에' } }]]);
  // 이미 보류 — 사유만 바꾸는 신호를 함께 보낸다(서버는 보류가 풀렸으면 상태를 바꾸지 않고 task_conflict)
  status = 'hold';
  const g2 = since();
  const ro = await argo(root, ['hold', '--task', TASK, '--reason', '디자인 확정 뒤에 — 시안 2개']);
  assert.equal(ro.code, 0, ro.err);
  assert.match(ro.out, /보류 사유를 고쳤습니다/);
  assert.deepEqual(g2().at(-1).body.p_data, { id: TASK, status: 'hold', hold_reason: '디자인 확정 뒤에 — 시안 2개', reason_only: true });
  // 목록을 본 뒤 누가 보류를 풀었다 — task_conflict를 받으면 보류로 바꾸는 요청을 한 번 더 보낸다
  handlers.office_task_write = (b) => (b.p_data.reason_only ? [400, { code: 'P0001', message: 'task_conflict' }] : [200, { id: b.p_data.id, status: 'hold' }]);
  const g3 = since();
  const rc = await argo(root, ['hold', '--task', TASK, '--reason', 'r2']);
  assert.equal(rc.code, 0, rc.err);
  assert.deepEqual(g3().filter((c) => c.fn === 'office_task_write').map((c) => c.body.p_data), [
    { id: TASK, status: 'hold', hold_reason: 'r2', reason_only: true }, { id: TASK, status: 'hold', hold_reason: 'r2' }]);
  // 목록에 없는 일(끝낸 일 등) — 보류 요청을 보내 서버가 사유를 말하게 한다
  handlers.office_task_write = (b) => [200, { id: b.p_data.id }];
  const g4 = since();
  const other = '33333333-4444-4555-8666-777777777777';
  await argo(root, ['hold', '--task', other, '--reason', 'x']);
  assert.deepEqual(g4().at(-1).body.p_data, { id: other, status: 'hold', hold_reason: 'x' });
  const k = calls.length;
  const r2 = await argo(root, ['hold', '제목', '--task', TASK, '--reason', 'x']);
  assert.equal(r2.code, 1);
  assert.equal(calls.length, k, '거절은 호출 0');
  handlers = { office_task_list: () => [200, []], office_task_write: () => [400, { code: 'P0001', message: 'task_not_found' }] };
  const r3 = await argo(root, ['hold', '--task', TASK, '--reason', 'x']);
  assert.equal(r3.code, 1);
  assert.match(r3.err, /argo office tasks/);
});

test('tasks — 끝내지 않은 일만 상태·기한·사유·id와 함께, --json은 행 그대로, 조직이 없으면 1', async () => {
  const root = await makeRoot({ org: ORG });
  const rows = [
    { id: TASK, title: '결제 화면 정리', status: 'hold', hold_reason: '로그인 버그부터', due_on: '2026-10-09', done_at: null },
    { id: SID, title: '로그인 버그', status: 'doing', done_at: null },
    { id: ORG, title: '끝낸 일', status: 'todo', done_at: '2026-10-07T00:00:00Z' },
  ];
  handlers = { office_task_list: () => [200, rows] };
  const got = since();
  const r = await argo(root, ['tasks']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(got().map((c) => [c.fn, c.body]), [['office_task_list', { p_org: ORG }]]);
  assert.match(r.out, /끝내지 않은 일 2건/);
  assert.match(r.out, /\[보류\] 결제 화면 정리 · 기한 2026-10-09 · 사유: 로그인 버그부터 · id=99999999/);
  assert.match(r.out, /\[진행 중\] 로그인 버그/);
  assert.doesNotMatch(r.out, /끝낸 일/);
  const j = await argo(root, ['tasks', '--json']);
  assert.deepEqual(JSON.parse(j.out).map((x) => x.id), [TASK, SID]);
  const noOrg = await makeRoot();
  const r2 = await argo(noOrg, ['tasks']);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /조직 id가 필요합니다/);
});

test('로그인 없음 — 안내 한 줄과 종료 코드 2, 서버 호출 0(세 명령 모두)', async () => {
  const root = await makeRoot({ session: null, org: ORG });
  const got = since(); const t0 = tokens.length;
  for (const args of [['report', '--org', ORG, '--id', SID, '--name', 'x'], ['hold', '일', '--reason', 'r', '--source-name', 's'], ['tasks']]) {
    const r = await argo(root, args);
    assert.equal(r.code, 2, `${args[0]} → ${r.err}`);
    assert.match(r.err, /argo login/);
    assert.equal(r.err.trim().split('\n').length, 1, '한 줄');
  }
  assert.equal(got().length, 0);
  assert.equal(tokens.length, t0);
});

test('만료 직전 세션 — 기기 세션 회전 경로로 한 번 갱신해 새 토큰으로 부르고, 회전 결과를 디스크에 남긴다', async () => {
  const root = await makeRoot({ session: 'expiring', org: ORG });
  handlers = { office_task_list: () => [200, []] };
  const got = since(); const t0 = tokens.length;
  const r = await argo(root, ['tasks']);
  assert.equal(r.code, 0, r.err);
  assert.equal(tokens.length - t0, 1, '회전 1회');
  assert.equal(tokens.at(-1), `rt-${n}`);
  assert.equal(got()[0].auth, `Bearer at-new-${tokens.length}`);
  const disk = JSON.parse(await readFile(join(root, '.device-session.json'), 'utf8'));
  assert.equal(disk.refresh_token, `rt-new-${tokens.length}`, '회전된 토큰이 저장돼 다음 실행이 옛 토큰을 다시 보내지 않는다');
  const r2 = await argo(root, ['tasks']);
  assert.equal(r2.code, 0);
  assert.equal(tokens.length - t0, 1, '다음 실행은 회전하지 않는다');
});

test('office는 cli.json 모드를 바꾸지 않는다 — 로컬 모드에서 훅 폴더 로그인이 있어도 안내 줄 없이 --json만, ARGO_ROOT가 없으면 훅 폴더(ARGO_CLI_HOME/office-hook)', async () => {
  const cliHome = join(base, 'cli-local'); await mkdir(cliHome, { recursive: true });
  const cfgFile = join(cliHome, 'cli.json');
  await writeFile(cfgFile, JSON.stringify({ mode: 'local', lang: 'ko' }));
  const root = await makeRoot({ org: ORG }); // 훅 폴더처럼 로그인이 있는 폴더
  handlers = { office_task_list: () => [200, [{ id: TASK, title: '결제', status: 'doing' }]] };
  const r = await argo(root, ['tasks', '--json'], { cliHome });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).map((x) => x.id), [TASK], '출력 앞에 안내 줄이 끼지 않는다');
  assert.equal(JSON.parse(await readFile(cfgFile, 'utf8')).mode, 'local', '로컬 모드가 그대로');
  // ARGO_ROOT 없이 — 앱 데이터 폴더(로컬 모드 기본) 대신 훅 폴더의 로그인으로 부른다
  const hook = join(cliHome, 'office-hook'); await mkdir(hook, { recursive: true });
  await writeFile(join(hook, '.device-session.json'), JSON.stringify({ url: URL_, anonKey: 'anon-test', access_token: 'at-hookdir', refresh_token: 'rt-hookdir', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'u1@example.test', nameAt: Date.now() } }), { mode: 0o600 });
  await writeFile(join(hook, 'config.json'), JSON.stringify({ org: ORG }));
  const got = since();
  const r2 = await argo(null, ['tasks', '--json'], { cliHome });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(got()[0].auth, 'Bearer at-hookdir');
  assert.equal(JSON.parse(await readFile(cfgFile, 'utf8')).mode, 'local');
});
