// argo CLI 회사 이름 ↔ 메신저 조직 이름(사용자 제보 2026-10-11: "서버에서 설정한 조직명과 메신저에서 로그인한 조직명이 다르게 나온다").
// 메신저로 먼저 가입해 조직을 만든 사용자가 서버에서 argo를 처음 실행하면 CLI가 조직을 모른 채 "새 회사 이름"을 따로 받았고,
// 상주(argo run)가 그 회사의 에이전트를 그 조직에 파견해 두 이름이 갈렸다. 잠그는 행동:
// ① 새 회사를 만들 때 내 메신저 조직 이름을 기본값으로(하나면 Enter, 여럿이면 번호, 직접 입력도 가능) — 조회 실패·조직 없음이면 종전 질문 그대로
// ② argo status가 회사 옆에 연결된 메신저 조직을 보여 주고, 이름이 다르면 argo rename을 안내
// ③ argo rename <새 이름>은 company.json 이름만 바꾼다(DB 쓰기 0)
// 가짜 Supabase(REST)를 띄워 요청 수·쓰기 0을 함께 센다. 격리 ARGO_CLI_HOME·ARGO_ROOT, 가짜 기기 세션.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const hasPy = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;
const base = await mkdtemp(join(tmpdir(), 'argo-cli-orgname-'));

/* ─── 가짜 Supabase REST — 조직 멤버십·에이전트 행을 돌려주고 요청을 기록한다 ─── */
const reqs = [];
let ORGS = [{ name: '메신저조직A', deleted_at: null }];
let LINKS = []; // [{ ws_id, org: { name, deleted_at } }]
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    reqs.push({ method: req.method, url: req.url });
    if (req.method === 'GET' && req.url.startsWith('/rest/v1/msgr_org_members') && !ORGS) { // 조회 실패(서버 오류)
      res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 'XX000', message: 'boom' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && req.url.startsWith('/rest/v1/msgr_org_members')) return res.end(JSON.stringify(ORGS.map((org) => ({ org }))));
    if (req.method === 'GET' && req.url.startsWith('/rest/v1/msgr_crews')) return res.end(JSON.stringify(LINKS));
    res.end(req.method === 'GET' ? '[]' : '{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => srv.close());
const SB = `http://127.0.0.1:${srv.address().port}`;

function envFor(name) {
  const home = join(base, name, 'home'), root = join(base, name, 'root'), cli = join(base, name, 'cli');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ARGO_CLI_HOME: cli, ARGO_ROOT: root, LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off',
    ARGO_NATIVE_RUNNERS: 'off', ARGO_SYNC: '0', ARGO_CLI_APP: '0', ARGO_NO_OPEN: '1', NO_COLOR: '1', NEXT_PUBLIC_SUPABASE_URL: SB, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fake' };
  for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'ARGO_TENANT_OWNER', 'ARGO_PREFER_LEADER', 'ARGO_NO_LEADER']) delete env[k];
  return { env, root, cli, home };
}
/** 데이터 폴더에 가짜 기기 세션(만료 1시간 뒤 — 갱신 요청이 나가지 않는다)과 회사(선택) */
async function seed({ env, home }, companies = []) {
  await mkdir(home, { recursive: true });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { saveDeviceSession } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/devicesession.mjs')).href)});
    const { createCompany } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/workspace.mjs')).href)});
    await saveDeviceSession({ url: ${JSON.stringify(SB)}, anonKey: 'anon-fake', session: { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-org', email: 'org@example.invalid' } } });
    for (const [id, name] of ${JSON.stringify(companies)}) await createCompany(id, name, 'captain', 'u-org', 'ko');`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
// 비동기 실행 — 가짜 Supabase가 같은 프로세스에 있어 spawnSync로 막으면 CLI의 요청에 답하지 못한다
const runCli = (env, args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [join(REPO, 'bin', 'argo.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (o += d));
  const t = setTimeout(() => c.kill('SIGKILL'), 60_000);
  c.on('close', (code) => { clearTimeout(t); resolve({ code, out: strip(o) }); });
});
const companiesIn = async (root) => {
  const out = [];
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try { out.push(JSON.parse(await readFile(join(root, e.name, 'company.json'), 'utf8'))); } catch { /* 회사 아님 */ }
  }
  return out;
};

// pty 운전기 — `until`이 보일 때까지 읽고 키를 보낸다. 결과는 JSON 한 줄.
const DRIVER = `
import pty, os, sys, time, select, json, re
steps = json.loads(sys.argv[2]); pid, fd = pty.fork()
if pid == 0: os.execvp(sys.argv[1], sys.argv[1:2] + [sys.argv[3]])
def rd(t, until=None):
    out=b''; end=time.time()+t
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try: out+=os.read(fd,65536)
            except OSError: break
        if until and until in re.sub(r'\\x1b\\[[0-9;?]*[A-Za-z]', '', out.decode(errors='replace')).replace('\\r', ''): break
    return out.decode(errors='replace')
res=[]
for s in steps:
    res.append({'label':s['label']+':before','out':rd(s.get('wait',60), s.get('until'))})
    try: os.write(fd, s['keys'].encode())
    except OSError: res.append({'label':s['label'],'out':'<<process gone>>'})
res.append({'label':'tail','out':rd(8, '\\u203a ')})
try: os.kill(pid, 9); os.waitpid(pid, 0)
except Exception: pass
print(json.dumps({'res':res}))
`;
const drive = (env, steps) => new Promise((resolve) => {
  const c = spawn('python3', ['-c', DRIVER, process.execPath, JSON.stringify(steps), join(REPO, 'bin', 'argo.mjs')], { env });
  let o = ''; let e = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d));
  c.on('close', () => {
    const line = o.trim().split('\n').pop() || '{}';
    try { resolve(Object.fromEntries(JSON.parse(line).res.map((x) => [x.label, strip(x.out)]))); } catch { resolve({ error: e.slice(-800) }); }
  });
});

/* ─── 순수 판정(모듈) ─── */
test('새 회사 이름 — 조직 하나면 Enter로 그 이름, 직접 치면 그 이름, 여럿이면 번호·직접 입력, 없으면 종전 질문', async () => {
  const { chooseNewCompanyName } = await import('../src/cli/company-name.mjs');
  const T = { newCompany: 'Q:', newCompanyDefault: (n) => `Q [${n}]:`, newCompanyPick: 'PICK', newCompanyOther: 'OTHER' };
  const asked = [];
  const ask = (answers) => async (q) => { asked.push(q); return answers.shift() ?? ''; };
  assert.equal(await chooseNewCompanyName({ orgs: ['메신저조직A'], ask: ask(['']), choose: null, T }), '메신저조직A', 'Enter = 조직 이름');
  assert.equal(asked.at(-1), 'Q [메신저조직A]:', '질문에 기본값을 보인다');
  assert.equal(await chooseNewCompanyName({ orgs: ['메신저조직A'], ask: ask(['다른 이름']), choose: null, T }), '다른 이름', '직접 친 이름이 이긴다');
  let shown;
  const choose = (i) => async (title, items) => { shown = { title, items }; return i; };
  assert.equal(await chooseNewCompanyName({ orgs: ['가', '나'], ask: ask([]), choose: choose(1), T }), '나', '번호로 고르기');
  assert.deepEqual(shown, { title: 'PICK', items: ['가', '나', 'OTHER'] }, '마지막 줄은 직접 입력');
  assert.equal(await chooseNewCompanyName({ orgs: ['가', '나'], ask: ask(['직접']), choose: choose(2), T }), '직접', '직접 입력을 고르면 묻는다');
  assert.equal(asked.at(-1), 'Q:');
  assert.equal(await chooseNewCompanyName({ orgs: ['가', '나'], ask: ask(['잘못']), choose: choose(-1), T }), '잘못', '잘못 친 번호도 직접 입력으로');
  assert.equal(await chooseNewCompanyName({ orgs: [], ask: ask(['그대로']), choose: null, T }), '그대로', '조직 없음 — 종전 질문');
  assert.equal(asked.at(-1), 'Q:');
});

test('조직 이름 조회 — 삭제 예정 조직 제외·같은 이름 하나로, 오류는 던진다(호출자가 종전 질문으로)', async () => {
  const { myOrgNames, linkedOrgNames } = await import('../src/cli/company-name.mjs');
  const calls = [];
  const q = (rows, error = null) => { const b = { select: (s) => (calls.push(['select', s]), b), eq: (k, v) => (calls.push(['eq', k, v]), b), is: (k, v) => (calls.push(['is', k, v]), b), in: (k, v) => (calls.push(['in', k, v]), b), not: (...a) => (calls.push(['not', ...a]), b), then: (r, j) => Promise.resolve({ data: rows, error }).then(r, j) }; return b; };
  const c = (rows, error) => ({ uid: 'u1', client: { from: (t) => (calls.push(['from', t]), q(rows, error)) } });
  assert.deepEqual(await myOrgNames(c([{ org: { name: ' 가 ', deleted_at: null } }, { org: { name: '가', deleted_at: null } }, { org: { name: '나', deleted_at: '2026-10-01' } }, { org: null }])), ['가']);
  assert.ok(calls.some((x) => x[0] === 'is' && x[1] === 'removed_at'), '나간 조직은 묻지 않는다');
  await assert.rejects(myOrgNames(c(null, { message: 'boom' })), /boom/);
  calls.length = 0;
  const links = await linkedOrgNames(c([{ ws_id: 'w1', org: { name: '가', deleted_at: null } }, { ws_id: 'w1', org: { name: '가', deleted_at: null } }, { ws_id: 'w1', org: { name: '다', deleted_at: '2026-10-01' } }, { ws_id: 'w2', org: { name: '나', deleted_at: null } }]), ['w1', 'w2']);
  assert.deepEqual(links, { w1: ['가'], w2: ['나'] });
  assert.deepEqual(calls.filter((x) => x[0] === 'from'), [['from', 'msgr_crews']], '읽기 1건');
  assert.ok(calls.some((x) => x[0] === 'in' && x[1] === 'status' && x[2].includes('active') && x[2].includes('paused') && !x[2].includes('detached') && !x[2].includes('available')), '해제한 행(detached·available)은 연결로 보지 않는다');
  calls.length = 0;
  assert.deepEqual(await linkedOrgNames(c([]), []), {}, '회사가 없으면 묻지 않는다');
  assert.equal(calls.length, 0);
});

test('안내 줄 — 연결 없으면 말하지 않고, 회사 하나면 조직 이름, 여럿이면 회사별, 이름이 다를 때만 rename 안내', async () => {
  const { orgNoticeLines } = await import('../src/cli/company-name.mjs');
  const T = { orgLinked: (s) => `ORG ${s}`, orgMismatch: 'DIFF' };
  assert.deepEqual(orgNoticeLines([{ id: 'w1', name: 'A' }], {}, T), []);
  assert.deepEqual(orgNoticeLines([{ id: 'w1', name: 'A' }], { w1: ['A'] }, T), ['ORG A']);
  assert.deepEqual(orgNoticeLines([{ id: 'w1', name: ' A ' }], { w1: ['A'] }, T), ['ORG A'], '앞뒤 공백은 같은 이름');
  assert.deepEqual(orgNoticeLines([{ id: 'w1', name: '서버회사B' }], { w1: ['메신저조직A'] }, T), ['ORG 메신저조직A', 'DIFF']);
  assert.deepEqual(orgNoticeLines([{ id: 'w1', name: 'A' }], { w1: ['B', 'A'] }, T), ['ORG B, A'], '여러 조직 중 하나라도 같으면 안내하지 않는다');
  assert.deepEqual(orgNoticeLines([{ id: 'w1', name: 'A' }, { id: 'w2', name: 'C' }], { w1: ['A'], w2: ['D'] }, T), ['ORG A → A · C → D', 'DIFF']);
});

test('이름 바꾸기 — 공백만이면 거절, 바꾸면 company.json 이름만(다른 값 보존)', async () => {
  const { renameCompany } = await import('../src/cli/company-name.mjs');
  let cur = { id: 'w1', name: '옛 이름', msgr: { enabled: true }, lang: 'ko' };
  const update = async (_ws, patch) => (cur = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) });
  await assert.rejects(renameCompany('w1', '   ', { update }), /empty/);
  assert.deepEqual(await renameCompany('w1', '  새 이름 ', { update }), { from: '옛 이름', to: '새 이름' });
  assert.deepEqual(cur, { id: 'w1', name: '새 이름', msgr: { enabled: true }, lang: 'ko' });
});

/* ─── 실제 명령 ─── */
test('argo 처음 실행 — 회사가 없으면 내 메신저 조직 이름이 기본값, Enter로 같은 이름 회사(조직 읽기 1건·쓰기 0)', { skip: !hasPy && 'python3 pty 필요(맥·리눅스)', timeout: 150_000 }, async () => {
  const e = envFor('first'); await seed(e);
  ORGS = [{ name: '메신저조직A', deleted_at: null }]; reqs.length = 0;
  const out = await drive(e.env, [{ label: 'name', until: '새 회사 이름', wait: 70, keys: '\r' }, { label: 'quit', until: '› ', wait: 30, keys: '/quit\r' }]);
  assert.match(out['name:before'] ?? JSON.stringify(out), /새 회사 이름 \[메신저조직A\]/, '기본값으로 조직 이름을 보인다');
  const cos = await companiesIn(e.root);
  assert.deepEqual(cos.map((c) => c.name), ['메신저조직A'], 'Enter = 메신저 조직과 같은 이름의 회사');
  assert.equal(reqs.filter((r) => r.url.startsWith('/rest/v1/msgr_org_members')).length, 1, '조직 읽기 1건');
  assert.deepEqual(reqs.filter((r) => r.method !== 'GET' && r.method !== 'HEAD'), [], '쓰기 0');
});

test('argo 처음 실행 — 조직 조회가 실패하면 종전 질문 그대로', { skip: !hasPy && 'python3 pty 필요(맥·리눅스)', timeout: 150_000 }, async () => {
  const e = envFor('fail'); await seed(e);
  const keep = ORGS; ORGS = null; // 가짜 서버가 500을 돌려준다
  try {
    const out = await drive(e.env, [{ label: 'name', until: '새 회사 이름', wait: 70, keys: '직접B\r' }, { label: 'quit', until: '› ', wait: 30, keys: '/quit\r' }]);
    assert.match(out['name:before'] ?? JSON.stringify(out), /새 회사 이름: $/m, '기본값 없는 종전 질문');
    assert.deepEqual((await companiesIn(e.root)).map((c) => c.name), ['직접B']);
  } finally { ORGS = keep; }
});

test('argo status — 회사 옆에 연결된 메신저 조직, 이름이 다르면 argo rename 안내 / argo rename은 company.json만(요청 0)', { timeout: 120_000 }, async () => {
  const e = envFor('status'); await seed(e, [['b-e70q', '서버회사B']]);
  LINKS = [{ ws_id: 'b-e70q', org: { name: '메신저조직A', deleted_at: null } }]; reqs.length = 0;
  const s1 = await runCli(e.env, ['status']);
  assert.equal(s1.code, 0, s1.out);
  assert.match(s1.out, /회사: 서버회사B \(b-e70q\)/);
  assert.match(s1.out, /메신저 조직: 메신저조직A/, '연결된 조직 이름');
  assert.match(s1.out, /이름이 다릅니다[^\n]*argo rename/, '다르면 맞추는 법');
  assert.equal(reqs.filter((r) => r.url.startsWith('/rest/v1/msgr_crews')).length, 1, '읽기 1건');
  assert.deepEqual(reqs.filter((r) => r.method !== 'GET' && r.method !== 'HEAD'), [], '쓰기 0');

  reqs.length = 0;
  const r = await runCli(e.env, ['rename', '메신저조직A']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /서버회사B → 메신저조직A/);
  const co = JSON.parse(await readFile(join(e.root, 'b-e70q', 'company.json'), 'utf8'));
  assert.equal(co.name, '메신저조직A');
  assert.equal(co.ownerId, 'u-org', '다른 값은 그대로');
  assert.deepEqual(reqs.filter((x) => x.method !== 'GET' && x.method !== 'HEAD'), [], 'rename은 DB에 쓰지 않는다');

  const s2 = await runCli(e.env, ['status']);
  assert.match(s2.out, /메신저 조직: 메신저조직A/);
  assert.doesNotMatch(s2.out, /이름이 다릅니다/, '맞춘 뒤에는 안내하지 않는다');
  const bad = await runCli(e.env, ['rename']);
  assert.equal(bad.code, 1, '이름 없이 부르면 사용법과 함께 실패');
  assert.match(bad.out, /argo rename <새 이름>/);
  LINKS = [];
});
