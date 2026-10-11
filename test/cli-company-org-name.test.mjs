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
import { mkdir, readFile, readdir, writeFile, stat, chmod } from 'node:fs/promises';
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
  c.on('close', (code) => { clearTimeout(t); resolve({ code, out: strip(o), raw: o }); });
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
    if s.get('chmod'): os.chmod(s['chmod'][0], int(s['chmod'][1], 8))
    try: os.write(fd, s['keys'].encode())
    except OSError: res.append({'label':s['label'],'out':'<<process gone>>'})
res.append({'label':'tail','out':rd(8, '\\u203a ')})
try: os.kill(pid, 9)
except Exception: pass
try: os.close(fd)  # 단말을 먼저 닫는다 — 읽지 않은 출력이 남으면 macOS에서 자식 종료가 단말 비우기를 기다리며 멈춘다(실측)
except Exception: pass
try: os.waitpid(pid, 0)
except Exception: pass
print(json.dumps({'res':res}))
`;
const drive = (env, steps) => new Promise((resolve) => {
  const c = spawn('python3', ['-c', DRIVER, process.execPath, JSON.stringify(steps), join(REPO, 'bin', 'argo.mjs')], { env });
  let o = ''; let e = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d));
  c.on('close', () => {
    const line = o.trim().split('\n').pop() || '{}';
    try { const res = JSON.parse(line).res; resolve({ ...Object.fromEntries(res.map((x) => [x.label, strip(x.out)])), raw: res.map((x) => x.out).join('') }); } catch { resolve({ error: e.slice(-800) }); }
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
  assert.deepEqual(await myOrgNames(c([{ role: 'owner', org: { name: ' 가 ', deleted_at: null } }, { role: 'member', org: { name: '가', deleted_at: null } }, { role: 'admin', org: { name: '나', deleted_at: '2026-10-01' } }, { role: 'member', org: null },
    { role: 'guest', org: { name: '남의 조직', deleted_at: null } }])), ['가'], '손님으로 든 조직은 내 회사 이름 후보가 아니다');
  assert.ok(calls.some((x) => x[0] === 'is' && x[1] === 'removed_at'), '나간 조직은 묻지 않는다');
  assert.ok(calls.some((x) => x[0] === 'eq' && x[1] === 'user_id' && x[2] === 'u1'), '내 멤버십만');
  await assert.rejects(myOrgNames(c(null, { message: 'boom' })), /boom/);
  calls.length = 0;
  const links = await linkedOrgNames(c([{ ws_id: 'w1', org: { name: '가', deleted_at: null } }, { ws_id: 'w1', org: { name: '가', deleted_at: null } }, { ws_id: 'w1', org: { name: '다', deleted_at: '2026-10-01' } }, { ws_id: 'w2', org: { name: '나', deleted_at: null } }]), ['w1', 'w2']);
  assert.deepEqual(links, { w1: ['가'], w2: ['나'] });
  assert.deepEqual(calls.filter((x) => x[0] === 'from'), [['from', 'msgr_crews']], '읽기 1건');
  assert.ok(calls.some((x) => x[0] === 'eq' && x[1] === 'owner_user_id' && x[2] === 'u1'), '내 에이전트 행만(남이 같은 회사 id를 써도 섞이지 않게)');
  assert.ok(calls.some((x) => x[0] === 'not' && x[1] === 'org_id' && x[2] === 'is' && x[3] === null), '개인 공간 행(org NULL)은 조직이 아니다');
  assert.ok(calls.some((x) => x[0] === 'in' && x[1] === 'ws_id' && x[2].join() === 'w1,w2'), '물은 회사만');
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
  let writes = 0;
  const update = async (_ws, patch) => { writes++; cur = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) }; return cur; };
  const load = async () => cur;
  await assert.rejects(renameCompany('w1', '   ', { update, load }), /empty/);
  assert.deepEqual(await renameCompany('w1', '  새 이름 ', { update, load }), { from: '옛 이름', to: '새 이름', changed: true });
  assert.deepEqual(cur, { id: 'w1', name: '새 이름', msgr: { enabled: true }, lang: 'ko' });
  assert.equal(writes, 1);
  assert.deepEqual(await renameCompany('w1', '새 이름', { update, load }), { from: '새 이름', to: '새 이름', changed: false }, '같은 이름');
  assert.equal(writes, 1, '같은 이름이면 쓰지 않는다(mtime 그대로 — 동기화 업로드 없음)');
  for (const bad of ['줄\n바꿈', '탭\t이름', '캐리지\r', '종\x07', 'del\x7f', 'c1\x9b']) await assert.rejects(renameCompany('w1', bad, { update, load }), (e) => e.code === 'invalid', `거절: ${JSON.stringify(bad)}`);
  await assert.rejects(renameCompany('w1', '가'.repeat(81), { update, load }), (e) => e.code === 'long', '80자 넘으면 거절');
  assert.equal((await renameCompany('w1', '가'.repeat(80), { update, load })).changed, true, '80자는 된다');
  assert.equal(writes, 2, '거절한 입력은 쓰지 않는다');
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
  const before = (await stat(join(e.root, 'b-e70q', 'company.json'))).mtimeMs;
  const same = await runCli(e.env, ['rename', '메신저조직A']);
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /이미 같은 이름입니다: 메신저조직A/);
  assert.equal((await stat(join(e.root, 'b-e70q', 'company.json'))).mtimeMs, before, '같은 이름이면 company.json을 쓰지 않는다');
  const bad = await runCli(e.env, ['rename']);
  assert.equal(bad.code, 1, '이름 없이 부르면 사용법과 함께 실패');
  assert.match(bad.out, /argo rename <새 이름>/);
  const long = await runCli(e.env, ['rename', '가'.repeat(81)]);
  assert.equal(long.code, 1); assert.match(long.out, /80자까지/);
  LINKS = [];
});

/* ─── 터미널 제어 문자 — 조직 이름은 그 조직의 다른 관리자가, 회사 이름은 다른 기기·Storage에서 정할 수 있는 값이다(보안 점검 #952) ─── */
// 화면 지우기(CSI 2J)·커서 이동·링크(OSC 8)·창 제목(OSC 0, BEL 끝)·CR·백스페이스·DEL·C1 CSI(0x9b)·방향 바꾸기(U+202E)
const EVIL = '악\x1b[2J\x1b[H성\x1b]8;;https://evil.example\x1b\\링크\x1b]8;;\x1b\\\x1b]0;제목\x07\r덮기\b\x7f\x9b31m‮조직\t끝';
const CLEAN = '악성링크덮기31m조직\t끝';
const CTRL_RE = /[\x00-\x08\x0a-\x1f\x7f-\x9f‪-‮⁦-⁩]/;

test('termSafe — ESC 시퀀스 전체(CSI·OSC·ST/BEL 끝)와 C0(탭 제외)·DEL·C1·방향 제어를 지우고 보이는 글자는 남긴다', async () => {
  const { termSafe } = await import('../src/cli/company-name.mjs');
  assert.equal(termSafe(EVIL), CLEAN);
  assert.equal(termSafe('평범한 회사 (주)'), '평범한 회사 (주)');
  assert.equal(termSafe('\x1b]0;끝나지 않는 제목'), '', '끝 표시 없는 OSC는 끝까지 지운다');
  assert.equal(termSafe(null), '');
});

test('조직·회사 이름 정리 — 조회 결과·기본값·안내 줄·rename 입력과 결과 모두 제어 문자 없음, 다 지우면 빈 이름으로 거절', async () => {
  const { myOrgNames, linkedOrgNames, chooseNewCompanyName, orgNoticeLines, renameCompany } = await import('../src/cli/company-name.mjs');
  const q = (rows) => { const b = { select: () => b, eq: () => b, is: () => b, in: () => b, not: () => b, then: (r, j) => Promise.resolve({ data: rows, error: null }).then(r, j) }; return b; };
  const c = (rows) => ({ uid: 'u1', client: { from: () => q(rows) } });
  const names = await myOrgNames(c([{ org: { name: EVIL, deleted_at: null } }]));
  assert.deepEqual(names, [CLEAN]);
  assert.deepEqual(await linkedOrgNames(c([{ ws_id: 'w1', org: { name: EVIL, deleted_at: null } }]), ['w1']), { w1: [CLEAN] });
  const T = { newCompany: 'Q:', newCompanyDefault: (n) => `Q [${n}]:`, newCompanyPick: 'P', newCompanyOther: 'O', orgLinked: (s) => `ORG ${s}`, orgMismatch: 'DIFF' };
  assert.equal(await chooseNewCompanyName({ orgs: [EVIL], ask: async () => '', choose: null, T }), CLEAN, '기본값도 정리한 값');
  assert.equal(await chooseNewCompanyName({ orgs: [], ask: async () => `직접\x1b[2J입력`, choose: null, T }), '직접입력', '직접 친 이름도 정리');
  const lines = orgNoticeLines([{ id: 'w1', name: EVIL }, { id: 'w2', name: 'x' }], { w1: [EVIL], w2: ['y'] }, T);
  assert.ok(lines.every((l) => !CTRL_RE.test(l.replace(/\t/g, '')) && !l.includes('\x1b')), JSON.stringify(lines));
  let cur = { id: 'w1', name: EVIL };
  const update = async (_ws, patch) => (cur = { ...cur, ...patch(cur) });
  const load = async () => cur;
  await assert.rejects(renameCompany('w1', `새\x1b]0;x\x07이름`, { update, load }), (e) => e.code === 'invalid', '제어 문자가 든 입력은 거절');
  assert.equal(cur.name, EVIL, '거절하면 그대로');
  const r = await renameCompany('w1', '새이름', { update, load });
  assert.deepEqual(r, { from: CLEAN, to: '새이름', changed: true }, '이전 이름(다른 기기에서 온 값)도 정리해 돌려준다');
  assert.equal(cur.name, '새이름');
});

test('실제 명령 — 조직·회사 이름에 제어 문자가 있어도 status·rename 출력에 ESC·BEL·CR이 없다', { timeout: 120_000 }, async () => {
  const e = envFor('evil'); await seed(e, [['evil-co', EVIL]]);
  LINKS = [{ ws_id: 'evil-co', org: { name: EVIL, deleted_at: null } }];
  try {
    const s1 = await runCli(e.env, ['status']);
    assert.equal(s1.code, 0, s1.out);
    assert.match(s1.raw, /메신저 조직: 악성링크덮기31m조직/);
    assert.ok(!/[\x1b\x07\r\b\x7f\x9b]/.test(s1.raw), `status 출력에 제어 문자: ${JSON.stringify(s1.raw)}`);
    const bad = await runCli(e.env, ['rename', `새\x1b[2J이름`]);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.raw, /제어 문자·줄바꿈은 쓸 수 없습니다/);
    assert.ok(!/[\x1b\x07\r\b\x7f\x9b]/.test(bad.raw), '거절 안내에도 입력을 되울리지 않는다');
    const r = await runCli(e.env, ['rename', '새이름']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!/[\x1b\x07\r\b\x7f\x9b]/.test(r.raw), `rename 출력에 제어 문자: ${JSON.stringify(r.raw)}`);
    assert.match(r.raw, /악성링크덮기31m조직\t끝 → 새이름/);
    assert.equal(JSON.parse(await readFile(join(e.root, 'evil-co', 'company.json'), 'utf8')).name, '새이름');
  } finally { LINKS = []; }
});

test('실제 명령 — 첫 실행 기본값 프롬프트에 조직 이름의 제어 문자가 나가지 않고 회사 이름도 정리된 값', { skip: !hasPy && 'python3 pty 필요(맥·리눅스)', timeout: 150_000 }, async () => {
  const e = envFor('evil-first'); await seed(e);
  const keep = ORGS; ORGS = [{ name: EVIL, deleted_at: null }];
  try {
    const out = await drive(e.env, [{ label: 'name', until: '새 회사 이름', wait: 70, keys: '\r' }, { label: 'quit', until: '› ', wait: 30, keys: '/quit\r' }]);
    assert.match(out['name:before'] ?? JSON.stringify(out), /새 회사 이름 \[악성링크덮기31m조직\t끝\]/);
    for (const bad of ['\x1b[2J', '\x1b]8;;', '\x1b]0;', '\x07', '\x9b', '‮']) assert.ok(!out.raw.includes(bad), `프롬프트 출력에 ${JSON.stringify(bad)}`);
    assert.deepEqual((await companiesIn(e.root)).map((c) => c.name), [CLEAN]);
  } finally { ORGS = keep; }
});

test('조회 상한·세션 — 응답이 없으면 상한 뒤 오류(요청은 abortSignal로 끊음), 만료가 1분 안이면 세션 없음(회전하지 않음)', { timeout: 15_000 }, async () => {
  const { myOrgNames, linkedOrgNames, readerSession, ORG_READ_TIMEOUT_MS } = await import('../src/cli/company-name.mjs');
  assert.equal(ORG_READ_TIMEOUT_MS, 3000);
  let aborted = null;
  const hang = { select: () => hang, eq: () => hang, is: () => hang, in: () => hang, not: () => hang, abortSignal: (sig) => { aborted = sig; return hang; }, then: () => {} };
  const c = { uid: 'u1', client: { from: () => hang } };
  const t0 = Date.now();
  await assert.rejects(myOrgNames(c, { timeoutMs: 50 }), /timeout/);
  await assert.rejects(linkedOrgNames(c, ['w1'], { timeoutMs: 50 }), /timeout/);
  assert.ok(Date.now() - t0 < 2000, `상한 안에 끝난다(${Date.now() - t0}ms)`);
  assert.ok(aborted instanceof AbortSignal, '요청에 끊기 신호를 단다');
  const mk = (_url, _key, opts) => ({ auth: opts.global.headers.Authorization });
  const now = () => 1_800_000_000_000;
  const sess = (exp) => () => ({ url: 'u', anonKey: 'k', access_token: 'tok', refresh_token: 'r', expires_at: exp, user: { id: 'u1' } });
  assert.equal(await readerSession({ load: sess(now() / 1000 + 30), mk, now }), null, '만료 1분 안 — 회전하지 않고 생략');
  assert.equal(await readerSession({ load: sess(now() / 1000 - 30), mk, now }), null, '만료됨');
  assert.equal(await readerSession({ load: () => null, mk, now }), null, '로그인 없음');
  const ok = await readerSession({ load: sess(now() / 1000 + 3600), mk, now });
  assert.equal(ok.uid, 'u1'); assert.equal(ok.client.auth, 'Bearer tok');
});

/** 답하지 않는 서버 + 그 서버를 가리키는 기기 세션 → { env, root, close } */
async function hangingSetup(name, companies) {
  const sockets = new Set();
  const hang = http.createServer(() => { /* 답하지 않는다 */ });
  hang.on('connection', (sk) => { sockets.add(sk); sk.on('close', () => sockets.delete(sk)); });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const e = envFor(name); await seed(e, companies);
  const f = join(e.root, '.device-session.json');
  const d = JSON.parse(await readFile(f, 'utf8')); d.url = `http://127.0.0.1:${hang.address().port}`; await writeFile(f, JSON.stringify(d));
  return { env: { ...e.env, NEXT_PUBLIC_SUPABASE_URL: d.url }, root: e.root, close: () => { for (const sk of sockets) sk.destroy(); hang.close(); } };
}

test('argo run — 조직 조회를 기다리지 않고 종료 처리를 먼저 건다(응답 없는 서버에서도 시작 직후 SIGTERM으로 정상 종료)', { skip: process.platform === 'win32' && 'POSIX 신호', timeout: 90_000 }, async () => {
  const h = await hangingSetup('hang-run', [['run-co', '상주 회사']]);
  try {
    const c = spawn(process.execPath, [join(REPO, 'bin', 'argo.mjs'), 'run'], { env: h.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; let sent = false;
    const done = new Promise((resolve) => c.on('close', (code, signal) => resolve({ code, signal })));
    const onData = (d) => { o += d; if (!sent && /회사: 상주 회사/.test(o)) { sent = true; setTimeout(() => c.kill('SIGTERM'), 700); } };
    c.stdout.on('data', onData); c.stderr.on('data', onData);
    const kill = setTimeout(() => c.kill('SIGKILL'), 60_000);
    const r = await done; clearTimeout(kill);
    assert.ok(sent, `시작 줄이 안 나왔다: ${strip(o).slice(-600)}`);
    assert.deepEqual(r, { code: 0, signal: null }, `상주의 종료 처리(stop)로 끝나야 한다 — 조회를 기다리면 처리 등록 전이라 신호로 죽는다: ${strip(o).slice(-400)}`);
  } finally { h.close(); }
});

test('argo status — 메신저 서버가 응답하지 않아도 3초 남짓에 끝난다(업그레이드 때 install.sh·install.ps1이 부른다)', { timeout: 90_000 }, async () => {
  const h = await hangingSetup('hang', [['hang-co', '응답없음 회사']]);
  try {
    const t0 = Date.now();
    const r = await runCli(h.env, ['status']);
    const ms = Date.now() - t0;
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /회사: 응답없음 회사 \(hang-co\)/);
    assert.doesNotMatch(r.out, /메신저 조직/, '못 읽으면 줄을 생략');
    assert.ok(ms < 12_000, `status ${ms}ms — 조회 상한(3초) 안에 포기해야 한다`);
  } finally { h.close(); }
});

test('argo rename — 회사가 여럿이고 고른 회사가 없으면(비대화형) 어느 회사인지 고를 수 없다고 안내', { timeout: 60_000 }, async () => {
  const e = envFor('multi'); await seed(e, [['m1-co', '회사1'], ['m2-co', '회사2']]);
  const r = await runCli(e.env, ['rename', '새이름']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /회사가 여러 개라 어느 회사의 이름을 바꿀지 고를 수 없습니다/);
  assert.doesNotMatch(r.out, /이 계정의 회사가 없습니다/);
  assert.deepEqual((await companiesIn(e.root)).map((c) => c.name).sort(), ['회사1', '회사2'], '아무것도 바꾸지 않는다');
});

test('대화 중 /rename이 실패해도 오류를 보이고 대화를 이어 간다', { skip: !hasPy && 'python3 pty 필요(맥·리눅스)', timeout: 200_000 }, async () => {
  const e = envFor('chat-fail'); await seed(e, [['ro-co', '읽기전용 회사']]);
  const dir = join(e.root, 'ro-co');
  try {
    const out = await drive(e.env, [
      { label: 'rename', until: '› ', wait: 60, keys: '/rename 바뀐이름\r', chmod: [dir, '555'] },
      { label: 'status', until: '실패', wait: 20, keys: '/status\r' },
      { label: 'quit', until: '계정:', wait: 20, keys: '/quit\r' },
    ]);
    if (process.env.ORGNAME_DUMP) console.log(JSON.stringify(out, null, 1));
    assert.match(out['status:before'] ?? JSON.stringify(out), /실패:/, '오류를 보인다');
    assert.match(out['quit:before'] ?? JSON.stringify(out), /계정: org@example\.invalid/, '대화가 이어져 다음 명령을 받는다');
  } finally { await chmod(dir, 0o755); }
  assert.equal(JSON.parse(await readFile(join(dir, 'company.json'), 'utf8')).name, '읽기전용 회사');
});
