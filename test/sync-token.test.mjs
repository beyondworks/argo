// 외부 동기화 통로 토큰(src/sync-token.mjs) — 방지턱 ⑥ orphan-cli만, 범위 안 요청만 통과하고 나머지 판정은 그대로인지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { denyAgentPeer } from '../src/agent-peer.mjs';
import { matchSyncToken, syncTokenAllows, tokenHash, SYNC_TOKEN_HEADER } from '../src/sync-token.mjs';

const TOKEN = `argo_sync_${'A'.repeat(43)}`;
const WS = 'lean-ax-wqou';
const TABLE = [{ name: 'hyoil-sync', ws: WS, scope: 'vault-notes', sha256: tokenHash(TOKEN) }];

const req = (method, url, token) => ({
  method, url, headers: token === undefined ? {} : { [SYNC_TOKEN_HEADER]: token },
  socket: { remoteAddress: '127.0.0.1', remotePort: 52000 + Math.floor(Math.random() * 1000), localAddress: '127.0.0.1', localPort: 3001 }, resume() {},
});
const res = () => { const r = { status: 0, body: '' }; r.writeHead = (s) => { r.status = s; }; r.end = (b) => { r.body = String(b); }; return r; };
const as = (reason, agent = true) => async () => ({ agent, reason, pid: 4242 });
const tok = (tokens = TABLE) => (r) => syncTokenAllows(r, { load: async () => tokens });
const run = (method, url, token, { reason = 'orphan-cli', agent = true, tokens } = {}) => {
  const r = res();
  return denyAgentPeer(req(method, url, token), r, { platform: 'darwin', classify: as(reason, agent), syncToken: tok(tokens) }).then((denied) => ({ denied, r }));
};
const VAULT = `/api/companies/${WS}/vault`;

test('통과 칸 — orphan-cli + 맞는 토큰 + POST·PUT /api/companies/<ws>/vault(쿼리 붙어도)', async () => {
  for (const [m, u] of [['POST', VAULT], ['PUT', VAULT], ['PUT', `${VAULT}?x=1`]]) {
    const { denied } = await run(m, u, TOKEN);
    assert.equal(denied, false, `${m} ${u}`);
  }
});

test('거절 유지 — 범위 밖 메서드·경로·회사, 틀린·빈·여러 토큰', async () => {
  const cases = [
    ['DELETE', `${VAULT}?rel=notes/a.md`, TOKEN, '삭제는 범위 밖'],
    ['PATCH', VAULT, TOKEN, 'PATCH'],
    ['POST', `${VAULT}/consolidate`, TOKEN, 'consolidate'],
    ['POST', `/api/companies/${WS}/approvals`, TOKEN, '결재'],
    ['POST', `/api/companies/${WS}/chat`, TOKEN, '대화 시작'],
    ['PUT', `/api/companies/other-ws/vault`, TOKEN, '다른 회사'],
    ['PUT', `/api/companies/${WS}/vault/../approvals`, TOKEN, '경로 탈출 원문'],
    ['PUT', `//api/companies/${WS}/vault`, TOKEN, '이중 슬래시'],
    ['PUT', `/api/companies/${WS}/vault/`, TOKEN, '끝 슬래시'],
    ['PUT', VAULT, `argo_sync_${'B'.repeat(43)}`, '틀린 토큰'],
    ['PUT', VAULT, '', '빈 토큰'],
    ['PUT', VAULT, undefined, '토큰 없음(지금 사고 그대로)'],
    ['PUT', VAULT, [TOKEN, TOKEN], '같은 헤더 여러 개'],
    ['PUT', VAULT, 'short', '짧은 토큰'],
  ];
  for (const [m, u, t, why] of cases) {
    const { denied, r } = await run(m, u, t);
    assert.equal(denied, true, why);
    assert.equal(r.status, 403, why);
    assert.equal(JSON.parse(r.body).errorCode, 'agent_loopback', why);
  }
});

test('거절 유지 — 자손·표지·에이전트 묶음은 맞는 토큰이 있어도 403(Argo 에이전트가 토큰을 읽어도 못 쓴다)', async () => {
  for (const reason of ['descendant', 'marked', 'agent-group', 'image:python.exe']) {
    const { denied, r } = await run('PUT', VAULT, TOKEN, { reason });
    assert.equal(denied, true, reason);
    assert.equal(JSON.parse(r.body).errorCode, 'agent_loopback', reason);
  }
});

test('판정 실패(fail-closed)는 토큰이 있어도 403 agent_check_failed, 사람 판정은 토큰 없이 통과(종전 그대로)', async () => {
  const r = res();
  const boom = async () => { throw Object.assign(new Error('x'), { code: 'PEER_UNKNOWN' }); };
  assert.equal(await denyAgentPeer(req('PUT', VAULT, TOKEN), r, { platform: 'darwin', classify: boom, syncToken: tok() }), true);
  assert.equal(JSON.parse(r.body).errorCode, 'agent_check_failed');
  assert.equal((await run('PUT', VAULT, undefined, { reason: 'human', agent: false })).denied, false, '사람');
  assert.equal((await run('POST', `/api/companies/${WS}/approvals`, undefined, { reason: 'human', agent: false })).denied, false, '사람의 다른 변경');
});

test('토큰 판정 자체가 던지면 거절(통과로 새지 않는다), 표가 비었거나 깨졌으면 거절', async () => {
  const r = res();
  assert.equal(await denyAgentPeer(req('PUT', VAULT, TOKEN), r, { platform: 'darwin', classify: as('orphan-cli'), syncToken: async () => { throw new Error('boom'); } }), true);
  assert.equal((await run('PUT', VAULT, TOKEN, { tokens: [] })).denied, true, '빈 표');
  assert.equal((await run('PUT', VAULT, TOKEN, { tokens: [{ name: 'x', ws: WS, scope: 'nope', sha256: tokenHash(TOKEN) }] })).denied, true, '없는 범위');
  assert.equal((await run('PUT', VAULT, TOKEN, { tokens: [{ name: 'x', ws: '', scope: 'vault-notes', sha256: tokenHash(TOKEN) }] })).denied, true, '빈 회사');
  assert.equal((await run('PUT', VAULT, TOKEN, { tokens: [null, { name: 'x' }] })).denied, true, '깨진 행');
});

test('읽기(GET)는 토큰과 무관하게 종전 읽기 경로', async () => {
  const r = res();
  const denied = await denyAgentPeer(req('GET', VAULT, TOKEN), r, { platform: 'darwin', classify: async () => { throw new Error('GET은 classify를 안 쓴다'); }, descendant: async () => 0, syncToken: tok() });
  assert.equal(denied, false);
});

test('matchSyncToken(순수) — 맞는 이름을 돌려준다', () => {
  assert.equal(matchSyncToken({ token: TOKEN, method: 'put', path: VAULT, tokens: TABLE }), 'hyoil-sync');
  assert.equal(matchSyncToken({ token: TOKEN, method: 'GET', path: VAULT, tokens: TABLE }), null);
});

test('발급 스크립트 → 실제 파일 판정 → 회수하면 다음 요청부터 거절(캐시 없음), 평문은 출력에 없다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-sync-token-'));
  const out = join(root, 'secrets', 'hyoil-sync.token');
  const script = fileURLToPath(new URL('../scripts/sync-token.mjs', import.meta.url));
  const env = { ...process.env, ARGO_ROOT: root };
  const sh = (...args) => new Promise((ok, no) => execFile(process.execPath, [script, ...args], { env }, (e, so, se) => (e ? no(Object.assign(e, { so, se })) : ok(so + se))));
  const prev = process.env.ARGO_ROOT;
  try {
    const printed = await sh('issue', 'hyoil-sync', '--ws', WS, '--out', out);
    const token = (await readFile(out, 'utf8')).trim();
    assert.match(token, /^argo_sync_[A-Za-z0-9_-]{43}$/);
    assert.ok(!printed.includes(token), '평문 토큰이 출력되면 안 된다');
    if (process.platform !== 'win32') { // Windows는 유닉스 권한 비트가 없다(stat이 438=0o666을 준다) — 권한은 맥·리눅스에서만 본다
      assert.equal((await stat(out)).mode & 0o777, 0o600, '토큰 파일 600');
      assert.equal((await stat(join(root, '.sync-tokens.json'))).mode & 0o777, 0o600, '서버 표 600');
    }
    assert.ok(!(await readFile(join(root, '.sync-tokens.json'), 'utf8')).includes(token), '서버 표에는 해시만');
    await assert.rejects(sh('issue', 'hyoil-sync', '--ws', WS, '--out', out), '이미 있으면 --rotate 없이 거절');

    process.env.ARGO_ROOT = root;
    const live = (t) => { const r = res(); return denyAgentPeer(req('PUT', VAULT, t), r, { platform: 'darwin', classify: as('orphan-cli') }); };
    assert.equal(await live(token), false, '실제 표로 통과');
    await sh('revoke', 'hyoil-sync');
    assert.equal(await live(token), true, '회수 뒤 바로 거절');
  } finally {
    if (prev === undefined) delete process.env.ARGO_ROOT; else process.env.ARGO_ROOT = prev;
    await rm(root, { recursive: true, force: true });
  }
});
