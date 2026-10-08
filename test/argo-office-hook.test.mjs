// Claude Code 훅 두 개(integrations/claude-code) — 실제 훅 파일을 자식 프로세스로 실행해 행동을 잠근다.
// 보고 훅(Stop·UserPromptSubmit·PostToolUse): 대화 기록의 마지막 세션 제목을 읽어 office_session_report를 부른다. 제목이 없으면 호출 0.
//   같은 값이고 4분 안이면 호출 0(이벤트가 달라도), 값이 바뀌면 바로 부른다, 네트워크 실패·서버 멈춤에도 종료 코드 0이고 3초 남짓에 끝난다,
//   영구 거절은 값·조직이 바뀌거나 6시간이 지날 때까지 쉰다, 출력 0바이트, 대화 내용은 보내지 않는다, 상태 파일은 잠금 안에서 자기 항목만 고친다.
// 보류 안내 훅: 태그 블록(<task-notification> 등)을 걷어 낸 사람 입력에 보류 표현이 있을 때만 argo office hold 안내를 넣고, 평범한 입력은 0바이트.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';
import { shouldReport, scanTitle, updateState, readState, sentKey, REPORT_EVERY_MS, FAIL_PAUSE_MS, DENY_PAUSE_MS } from '../src/office-cli.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(REPO, 'integrations', 'claude-code', 'argo-office-hook.mjs');
const HOLD = join(REPO, 'integrations', 'claude-code', 'argo-office-hold-hook.mjs');
const base = await mkdtemp(join(tmpdir(), 'argo-office-hook-'));
const ORG = '11111111-2222-4333-8444-555555555555';
const TASK = '99999999-8888-4777-8666-555555555555';

const calls = []; let mode = 'ok';
let hold = null; // 다음 office_session_report 응답을 이 Promise가 풀릴 때까지 붙잡는다(경쟁 시험)
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/rest/v1/rpc/office_session_report') {
      calls.push({ body: JSON.parse(b || '{}'), auth: req.headers.authorization ?? null, raw: b });
      if (mode === 'hang') return; // 응답하지 않는다 — 훅이 3초 제한으로 끝나야 한다
      if (mode === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"message":"boom"}'); }
      if (mode === 'deny') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"code":"P0001","message":"session_forbidden"}'); }
      if (mode === 'drop') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"written":true,"task":false}'); }
      if (hold) { const h = hold; hold = null; return h.then(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"written":true}'); }); }
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"written":true}');
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => { srv.closeAllConnections?.(); srv.close(); });
const URL_ = `http://127.0.0.1:${srv.address().port}`;

let n = 0;
/** 격리 HOME — ~/.argo/office-hook에 기기 세션·config.json을 둔다 */
async function makeHome({ session = true, org = ORG, url = URL_ } = {}) {
  const home = join(base, `home-${++n}`); const root = join(home, '.argo', 'office-hook');
  await mkdir(root, { recursive: true });
  if (session) await writeFile(join(root, '.device-session.json'), JSON.stringify({ url, anonKey: 'anon-test', access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: '', nameAt: Date.now() } }));
  if (org) await writeFile(join(root, 'config.json'), JSON.stringify({ org }));
  return { home, root };
}
function run(file, home, input) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [file], { env: { PATH: process.env.PATH, HOME: home, LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
const since = () => { const k = calls.length; return () => calls.slice(k); };
const SECRET = '비밀 프롬프트 내용 — 서버로 가면 안 된다';
async function transcript(name, lines) {
  const f = join(base, `${name}.jsonl`);
  await writeFile(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const sid = (i) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, '0')}`;

test('판정 shouldReport — 같은 값은 4분 경계 직전까지 0, 경계부터 호출, 값이 바뀌면 바로, 실패 뒤 1분은 쉼', () => {
  const sent = { org: ORG, name: '제목', project: 'p', task: null };
  const at = 1_000_000_000;
  assert.equal(shouldReport({}, sent, at), true, '처음은 부른다');
  assert.equal(shouldReport({ sent, at }, { ...sent }, at + REPORT_EVERY_MS - 1), false, '4분 1ms 전 — 호출 0');
  assert.equal(shouldReport({ sent, at }, { ...sent }, at + REPORT_EVERY_MS), true, '정확히 4분 — 부른다');
  for (const k of ['org', 'name', 'project', 'task']) assert.equal(shouldReport({ sent, at }, { ...sent, [k]: 'other' }, at + 1), true, `${k}가 바뀌면 바로`);
  assert.equal(shouldReport({ sent, at, failAt: at }, { ...sent, name: 'x' }, at + FAIL_PAUSE_MS - 1), false, '실패 1분 안은 값이 바뀌어도 쉰다');
  assert.equal(shouldReport({ sent, at, failAt: at }, { ...sent, name: 'x' }, at + FAIL_PAUSE_MS), true);
  // 영구 거절 — 같은 값이면 6시간 쉼, 값(조직 포함)이 바뀌면 바로, 6시간이 지나면 다시
  const deny = { sent, at, denyAt: at, denyKey: sentKey({ ...sent, name: '거절된 제목' }) };
  assert.equal(shouldReport(deny, { ...sent, name: '거절된 제목' }, at + FAIL_PAUSE_MS * 10), false, '같은 값 — 1분이 지나도 쉰다');
  assert.equal(shouldReport(deny, { ...sent, name: '거절된 제목' }, at + DENY_PAUSE_MS - 1), false);
  assert.equal(shouldReport(deny, { ...sent, name: '거절된 제목' }, at + DENY_PAUSE_MS), true, '6시간 경계부터 다시');
  assert.equal(shouldReport(deny, { ...sent, name: '거절된 제목', org: 'other-org' }, at + 1), true, 'config org가 바뀌면 바로');
  assert.equal(shouldReport(deny, { ...sent, name: '새 제목' }, at + 1), true, '보낼 값이 바뀌면 바로');
});

test('제목 읽기 scanTitle — 마지막 custom-title, 긴 줄 건너뛰기, 지난번 위치부터 이어 읽기, 파일이 줄면 처음부터', async () => {
  const f = await transcript('scan', [
    { type: 'user', message: { content: SECRET } },
    { type: 'custom-title', customTitle: '첫 제목', sessionId: 'x' },
    { type: 'custom-title', customTitle: '  맥가이버 -   정비사 ', sessionId: 'x' },
    { type: 'custom-title', customTitle: '64KB 넘는 줄', pad: 'x'.repeat(200_000) }, // 64KB가 넘는 줄은 담지 않고 건너뛴다(그림·도구 결과 줄로 메모리를 쓰지 않게) — 제목은 앞의 것
    { type: 'assistant', message: { content: 'x'.repeat(3_000_000) } }, // 읽기 단위(1MB)를 넘는 줄도 다음 줄 경계를 잃지 않는다
  ]);
  const a = await scanTitle(f);
  assert.equal(a.title, '맥가이버 - 정비사');
  assert.equal(a.offset, (await readFile(f)).length, '완성된 줄 끝까지 읽음');
  await appendFile(f, `${JSON.stringify({ type: 'custom-title', customTitle: '새 제목' })}\n{"type":"custom-title","customTitle":"덜 쓴 줄`);
  const b = await scanTitle(f, { from: a.offset, title: a.title });
  assert.equal(b.title, '새 제목', '이어 읽기 — 덜 쓴 마지막 줄은 아직 보지 않는다');
  await appendFile(f, '"}\n');
  assert.equal((await scanTitle(f, { from: b.offset, title: b.title })).title, '덜 쓴 줄', '줄이 완성되면 다음에 읽는다');
  const g = await transcript('scan-short', [{ type: 'custom-title', customTitle: '다시 쓴 기록' }]);
  assert.equal((await scanTitle(g, { from: 10_000_000, title: '옛 제목' })).title, '다시 쓴 기록', '파일이 줄었으면 처음부터');
  assert.equal((await scanTitle(join(base, 'none.jsonl'), { title: null })).title, null);
});

test('Stop 훅 — 마지막 세션 제목·폴더 이름을 보낸다, 대화 내용은 보내지 않는다, 출력 0바이트·종료 0, 같은 값은 4분 안에 다시 부르지 않는다', async () => {
  const { home, root } = await makeHome();
  const f = await transcript('t1', [{ type: 'user', message: { content: SECRET } }, { type: 'custom-title', customTitle: '옛 제목' }, { type: 'custom-title', customTitle: '맥가이버 - 정비사' }]);
  mode = 'ok';
  const got = since();
  const r = await run(HOOK, home, { session_id: sid(1), transcript_path: f, cwd: '/Users/x/lean-projects/saas/argo' });
  assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, '');
  const c = got();
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].body, { p_id: sid(1), p_org: ORG, p_name: '맥가이버 - 정비사', p_project: 'argo', p_task: null });
  assert.equal(c[0].auth, `Bearer at-${n}`);
  assert.ok(!c[0].raw.includes('비밀'), '대화 내용은 서버로 가지 않는다');
  // 바로 다시(같은 값, 4분 안) — 호출 0
  const r2 = await run(HOOK, home, { session_id: sid(1), transcript_path: f, cwd: '/Users/x/lean-projects/saas/argo' });
  assert.equal(r2.code, 0); assert.equal(got().length, 1, '같은 값·4분 안 — 호출 0');
  // 상태 파일의 보낸 시각을 4분 1초 전으로 — 다시 부른다(경계 넘음). 3분 59초 전이면 0
  const st = JSON.parse(await readFile(join(root, 'sessions.json'), 'utf8'));
  st[sid(1)].at = Date.now() - (REPORT_EVERY_MS - 1000); await writeFile(join(root, 'sessions.json'), JSON.stringify(st));
  await run(HOOK, home, { session_id: sid(1), transcript_path: f, cwd: '/Users/x/lean-projects/saas/argo' });
  assert.equal(got().length, 1, '3분 59초 — 호출 0');
  st[sid(1)].at = Date.now() - (REPORT_EVERY_MS + 1000); await writeFile(join(root, 'sessions.json'), JSON.stringify(st));
  await run(HOOK, home, { session_id: sid(1), transcript_path: f, cwd: '/Users/x/lean-projects/saas/argo' });
  assert.equal(got().length, 2, '4분 1초 — 다시 부른다');
  // 제목이 바뀌면 4분 안이어도 바로
  await appendFile(f, `${JSON.stringify({ type: 'custom-title', customTitle: '맥가이버 - 결제 정리' })}\n`);
  await run(HOOK, home, { session_id: sid(1), transcript_path: f, cwd: '/Users/x/lean-projects/saas/argo' });
  assert.equal(got().length, 3);
  assert.equal(got().at(-1).body.p_name, '맥가이버 - 결제 정리');
});

test('보고 훅 — 이름(custom-title)이 없는 세션은 부르지 않는다(폴더 이름으로 대신하지 않는다), 이름이 생기면 argo office report --task로 정한 할 일과 함께 보낸다', async () => {
  const { home, root } = await makeHome();
  const f = await transcript('t2', [{ type: 'user', message: { content: 'hi' } }]);
  await writeFile(join(root, 'sessions.json'), JSON.stringify({ [sid(2)]: { task: TASK } }));
  const got = since(); mode = 'ok';
  for (const ev of ['Stop', 'UserPromptSubmit', 'PostToolUse']) {
    const r = await run(HOOK, home, { session_id: sid(2), transcript_path: f, cwd: '/Users/x/work/kakao-bot', hook_event_name: ev });
    assert.equal(r.code, 0); assert.equal(r.out, '');
  }
  assert.equal(got().length, 0, '이름 없는 세션(헤드리스 자동 실행 등) — 호출 0');
  const st = JSON.parse(await readFile(join(root, 'sessions.json'), 'utf8'));
  assert.equal(st[sid(2)].task, TASK, '맡은 할 일은 지우지 않는다');
  assert.ok(st[sid(2)].offset > 0, '읽은 위치는 남긴다(다음에 처음부터 읽지 않게)');
  await appendFile(f, `${JSON.stringify({ type: 'custom-title', customTitle: '카카오 - 봇' })}\n`);
  await run(HOOK, home, { session_id: sid(2), transcript_path: f, cwd: '/Users/x/work/kakao-bot', hook_event_name: 'Stop' });
  assert.deepEqual(got().map((c) => c.body), [{ p_id: sid(2), p_org: ORG, p_name: '카카오 - 봇', p_project: 'kakao-bot', p_task: TASK }]);
});

// 재검증 10/8: 관리자가 그 일을 남에게 다시 맡기면 낡은 task id 때문에 보고가 영영 실패해 '끊김'으로 굳었다 → 서버는 id만 버리고(task=false) 훅은 그 id를 지운다
test('보고 훅 — 서버가 할 일을 붙이지 않으면(task=false) 들고 있던 할 일 id를 지우고, 다음 보고부터 보내지 않는다', async () => {
  const { home, root } = await makeHome();
  const f = await transcript('t-drop', [{ type: 'custom-title', customTitle: '맥가이버 - 정비사' }]);
  await writeFile(join(root, 'sessions.json'), JSON.stringify({ [sid(30)]: { task: TASK } }));
  const got = since(); mode = 'drop';
  await run(HOOK, home, { session_id: sid(30), transcript_path: f, cwd: '/a/argo', hook_event_name: 'Stop' });
  assert.equal(got()[0].body.p_task, TASK);
  let st = JSON.parse(await readFile(join(root, 'sessions.json'), 'utf8'));
  assert.equal(st[sid(30)].task, null); assert.equal(st[sid(30)].sent.task, null);
  assert.ok(!st[sid(30)].denyAt, '거절로 적지 않는다(연결 보고는 계속)');
  mode = 'ok';
  st[sid(30)].at = Date.now() - (REPORT_EVERY_MS + 1000); await writeFile(join(root, 'sessions.json'), JSON.stringify(st));
  await run(HOOK, home, { session_id: sid(30), transcript_path: f, cwd: '/a/argo', hook_event_name: 'Stop' });
  assert.equal(got().length, 2); assert.equal(got()[1].body.p_task, null, '낡은 할 일 id는 다시 보내지 않는다');
});

// 재검증 10/8: PostToolUse에도 걸리면서 세션이 cd로 폴더를 오갈 때마다 값이 바뀌어 4분 판정을 건너뛰었다(한 세션 cwd 8~14개) → 처음 본 폴더로 고정
test('보고 훅 — 프로젝트 폴더는 처음 본 cwd로 고정한다(폴더를 오가도 4분 안에는 다시 부르지 않는다)', async () => {
  const { home } = await makeHome();
  const f = await transcript('t-cwd', [{ type: 'custom-title', customTitle: '슈리 - 개발' }]);
  const got = since(); mode = 'ok';
  for (const cwd of ['/Users/x/lean-projects/AI-Native', '/Users/x/lean-projects/_worktrees/ai-native-work-status', '/tmp', '/Users/x/lean-projects/AI-Native'])
    await run(HOOK, home, { session_id: sid(31), transcript_path: f, cwd, hook_event_name: 'PostToolUse' });
  assert.equal(got().length, 1, '폴더만 오가면 호출 1번');
  assert.equal(got()[0].body.p_project, 'AI-Native');
});

test('보고 훅 — Stop·UserPromptSubmit·PostToolUse 어느 이벤트로 불려도 같은 판정(4분에 한 번), 출력 0바이트, 프롬프트·도구 결과는 보내지 않는다', async () => {
  const { home } = await makeHome();
  const f = await transcript('t-ev', [{ type: 'custom-title', customTitle: '페퍼 - 총괄' }]);
  const got = since(); mode = 'ok';
  const cwd = '/Users/x/lean-projects/saas/argo';
  const inputs = [
    { session_id: sid(20), transcript_path: f, cwd, hook_event_name: 'UserPromptSubmit', permission_mode: 'default', prompt: SECRET },
    { session_id: sid(20), transcript_path: f, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: SECRET }, tool_response: { stdout: 'x'.repeat(2_000_000) + SECRET } },
    { session_id: sid(20), transcript_path: f, cwd, hook_event_name: 'Stop', stop_hook_active: false },
    { session_id: sid(20), transcript_path: f, cwd, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: {} },
  ];
  for (const input of inputs) {
    const r = await run(HOOK, home, input);
    assert.equal(r.code, 0); assert.equal(r.out, '', `${input.hook_event_name} — 출력 0바이트(UserPromptSubmit 출력은 대화에 들어간다)`); assert.equal(r.err, '');
  }
  const c = got();
  assert.equal(c.length, 1, '첫 이벤트에서 한 번, 나머지는 같은 값·4분 안이라 호출 0');
  assert.deepEqual(c[0].body, { p_id: sid(20), p_org: ORG, p_name: '페퍼 - 총괄', p_project: 'argo', p_task: null });
  assert.ok(!c[0].raw.includes('비밀'), '프롬프트·도구 입력·결과는 서버로 가지 않는다');
});

test('보고 훅 — 영구 거절(session_forbidden)은 같은 값으로 1분 뒤에도 다시 부르지 않는다, 값·config 조직이 바뀌거나 6시간이 지나면 다시', async () => {
  const { home, root } = await makeHome();
  const f = await transcript('t-deny', [{ type: 'custom-title', customTitle: '나간 조직 세션' }]);
  const got = since(); mode = 'deny';
  const go = () => run(HOOK, home, { session_id: sid(21), transcript_path: f, cwd: '/a/b', hook_event_name: 'PostToolUse' });
  assert.equal((await go()).code, 0);
  assert.equal(got().length, 1);
  const file = join(root, 'sessions.json');
  const back = async (ms) => { const st = JSON.parse(await readFile(file, 'utf8')); st[sid(21)].denyAt -= ms; await writeFile(file, JSON.stringify(st)); };
  await back(FAIL_PAUSE_MS * 5); // 5분 전 거절 — 1분 쉬기만 있었다면 다시 불렀다
  await go(); assert.equal(got().length, 1, '영구 거절은 1분 뒤에도 같은 값이면 호출 0');
  // config 조직이 바뀌면 바로 다시
  const ORG2 = '22222222-3333-4444-8555-666666666666';
  await writeFile(join(root, 'config.json'), JSON.stringify({ org: ORG2 }));
  await go(); assert.equal(got().length, 2); assert.equal(got().at(-1).body.p_org, ORG2);
  // 제목이 바뀌어도 바로
  await appendFile(f, `${JSON.stringify({ type: 'custom-title', customTitle: '새 이름' })}\n`);
  await go(); assert.equal(got().length, 3);
  // 6시간이 지나면 같은 값이어도 다시
  await back(DENY_PAUSE_MS);
  mode = 'ok';
  await go(); assert.equal(got().length, 4);
  const st = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(!st[sid(21)].denyAt && st[sid(21)].sent?.name === '새 이름', '성공하면 거절 표시를 지운다');
});

test('상태 파일 — updateState는 잠금 안에서 다시 읽어 고친다(같은 프로세스에서 20개를 동시에 고쳐도 하나도 잃지 않는다)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-office-state-'));
  await Promise.all(Array.from({ length: 20 }, (_, i) => updateState(root, (st) => { st[sid(100 + i)] = { seen: Date.now(), i }; })));
  const st = await readState(root);
  assert.equal(Object.keys(st).length, 20);
});

test('상태 파일 — 훅과 argo office report --task가 번갈아·동시에 써도 맡은 할 일(task)이 남는다', async () => {
  const { home, root } = await makeHome();
  const f = await transcript('t-race', [{ type: 'custom-title', customTitle: '경쟁 시험' }]);
  mode = 'ok';
  const report = () => new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: home, ARGO_ROOT: root, ARGO_CLI_HOME: join(home, '.argo'), LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', ARGO_SYNC: '0' };
    const p = spawn(process.execPath, [join(REPO, 'bin', 'argo.mjs'), 'office', 'report', '--id', sid(22), '--name', '경쟁 시험', '--task', TASK], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, err }));
  });
  for (let round = 0; round < 3; round++) {
    // 매 판: 상태를 지워 훅이 부르게 한다(task 없음으로 읽음). 훅의 서버 호출을 붙잡아 둔 사이에 report --task가 끝까지 쓰고, 그 뒤에 훅 응답을 푼다
    await writeFile(join(root, 'sessions.json'), JSON.stringify({}));
    let release; hold = new Promise((r) => { release = r; });
    const k = calls.length;
    const hook = run(HOOK, home, { session_id: sid(22), transcript_path: f, cwd: '/a/argo', hook_event_name: 'PostToolUse' });
    for (let i = 0; i < 200 && calls.length === k; i++) await new Promise((r) => setTimeout(r, 10)); // 훅의 요청이 서버에 닿을 때까지
    assert.equal(calls.length, k + 1, '훅이 부르는 중');
    const rep = await report();
    release();
    await hook;
    assert.equal(rep.code, 0, rep.err);
    const st = JSON.parse(await readFile(join(root, 'sessions.json'), 'utf8'));
    assert.equal(st[sid(22)].task, TASK, `${round}판 — 훅이 report --task가 남긴 할 일을 지우지 않는다`);
  }
  mode = 'ok';
});

test('Stop 훅 — 로그인·조직 설정이 없거나 입력이 이상하면 호출 0, 종료 0', async () => {
  const got = since(); mode = 'ok';
  const f = await transcript('t3', [{ type: 'custom-title', customTitle: 'x' }]);
  const noSess = await makeHome({ session: false });
  const noOrg = await makeHome({ org: null });
  const ok = await makeHome();
  for (const [home, input] of [[noSess.home, { session_id: sid(3), transcript_path: f, cwd: '/a/b' }], [noOrg.home, { session_id: sid(3), transcript_path: f, cwd: '/a/b' }],
    [ok.home, { session_id: 'not-a-uuid', transcript_path: f }], [ok.home, 'not json {']]) {
    const r = await run(HOOK, home, input);
    assert.equal(r.code, 0); assert.equal(r.out, '');
  }
  assert.equal(got().length, 0);
});

test('Stop 훅 — 서버 오류·연결 실패·응답 없음에도 종료 0, 응답 없음은 3초 남짓에 끝난다, 실패 뒤 1분은 다시 부르지 않는다', async () => {
  const f = await transcript('t4', [{ type: 'custom-title', customTitle: '실패 시험' }]);
  const got = since();
  mode = 'fail';
  const a = await makeHome();
  const r1 = await run(HOOK, a.home, { session_id: sid(4), transcript_path: f, cwd: '/a/b' });
  assert.equal(r1.code, 0); assert.equal(r1.out, '');
  assert.equal(got().length, 1);
  const again = await run(HOOK, a.home, { session_id: sid(4), transcript_path: f, cwd: '/a/b' });
  assert.equal(again.code, 0); assert.equal(got().length, 1, '실패 뒤 1분 — 호출 0(턴마다 기다리지 않게)');
  // 닫힌 포트 — 연결 실패
  const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r)); const port = dead.address().port; await new Promise((r) => dead.close(r));
  const b = await makeHome({ url: `http://127.0.0.1:${port}` });
  const r2 = await run(HOOK, b.home, { session_id: sid(5), transcript_path: f, cwd: '/a/b' });
  assert.equal(r2.code, 0); assert.equal(r2.out, '');
  // 응답하지 않는 서버 — 3초 제한
  mode = 'hang';
  const c = await makeHome();
  const r3 = await run(HOOK, c.home, { session_id: sid(6), transcript_path: f, cwd: '/a/b' });
  assert.equal(r3.code, 0); assert.equal(r3.out, '');
  assert.ok(r3.ms >= 2900 && r3.ms < 6000, `3초 제한으로 끝난다 (${r3.ms}ms)`);
  const st = JSON.parse(await readFile(join(c.root, 'sessions.json'), 'utf8'));
  assert.ok(st[sid(6)].failAt > 0 && !st[sid(6)].sent, '끊긴 호출은 실패로 남는다 — 보낸 것으로 치지 않는다');
  mode = 'ok';
});

test('보류 안내 훅 — 사람 입력의 보류 표현에만 argo office hold 안내, 태그 블록 안의 낱말·평범한 입력은 0바이트, 호출 0', async () => {
  const { home } = await makeHome();
  const got = since();
  const hint = async (prompt) => run(HOLD, home, { session_id: sid(7), prompt });
  for (const p of ['이건 보류하자', '결제는 나중에 하자', '로그인 버그 이것부터 해줘', '잠깐 멈추고 이거 봐', '그건 킵해 둬', '먼저 하자 이거',
    '<system-reminder>시스템 글</system-reminder>\n그럼 이거부터 해']) {
    const r = await hint(p);
    assert.equal(r.code, 0);
    const o = JSON.parse(r.out);
    assert.equal(o.hookSpecificOutput.hookEventName, 'UserPromptSubmit', p);
    assert.match(o.hookSpecificOutput.additionalContext, /argo office hold "/);
    assert.match(o.hookSpecificOutput.additionalContext, /--reason/);
    assert.match(o.hookSpecificOutput.additionalContext, /ARGO_ROOT=~\/\.argo\/office-hook/);
    const ctx = o.hookSpecificOutput.additionalContext;
    const cmds = ctx.match(/(\S+\s+)?argo office \w+/g);
    assert.ok(cmds.length >= 3, ctx);
    for (const c of cmds) assert.match(c, /^ARGO_ROOT=~\/\.argo\/office-hook argo office/, `모든 argo office 명령은 훅 폴더로: ${c}`);
    assert.match(ctx, /--source-name "<이 세션 제목>"/);
    assert.match(ctx, /꼭 넣는다/);
  }
  for (const p of ['로그인 버그 고쳐줘', '',
    '<task-notification>\n<summary>작업 보류 사유 정리 완료</summary>\n</task-notification>',
    '<task-notification><result>이것부터 처리했습니다</result></task-notification> 다음 단계 진행해',
    '<cross-session-message from="x">나중에 하자고 했음</cross-session-message>',
    '<system-reminder>보류 중인 일이 있습니다', // 닫히지 않은 알림 블록
  ]) {
    const r = await hint(p);
    assert.equal(r.code, 0); assert.equal(r.out.length, 0, `0바이트여야 한다: ${p}`);
  }
  // 대화 기록에 세션 제목이 있으면 그 제목을 셸 작은따옴표로 명령에 넣는다
  const tf = await transcript('hold-title', [{ type: 'custom-title', customTitle: "맥가이버 - 정비사 '결제' $HOME" }]);
  const withTitle = await run(HOLD, home, { session_id: sid(8), transcript_path: tf, prompt: '이건 보류하자' });
  const ctx = JSON.parse(withTitle.out).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(`--source-name '맥가이버 - 정비사 '\\''결제'\\'' $HOME'`), ctx);
  assert.doesNotMatch(ctx, /<이 세션 제목>/);
  const bad = await run(HOLD, home, 'not json');
  assert.equal(bad.code, 0); assert.equal(bad.out.length, 0);
  assert.equal(got().length, 0, '안내 훅은 서버를 부르지 않는다');
});
