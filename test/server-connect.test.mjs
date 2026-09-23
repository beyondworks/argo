// VPS 서버 연결(유건 지시 2026-09-23) — 서버에서 도는 connect.py를 실제 python3로 실행해 끝까지 본다.
// 가짜 hermes·openclaw CLI + 엣지 함수 라우터(core.js handleLink)를 그대로 쓰는 로컬 HTTP 서버. DB 판정은 msgr-server-link-pg.test.mjs가 본다.
// 잠그는 것: ① 토큰 원문은 서버로 가지 않고 해시만 간다 ② 관리자가 고른 에이전트에만 설치한다 ③ 로컬 연결(agents.rs)과 같은 단계를 밟는다
// ④ 배포본(connect-bundle.js)이 원본과 어긋나지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { handleLink, parseLinkPath, connectScript } from '../supabase/functions/msgr-bot/core.js';
import { CONNECT_PY } from '../supabase/functions/msgr-bot/connect-bundle.js';
import { buildConnectScript } from '../scripts/build-server-connect.mjs';

const skip = process.platform === 'win32' && '서버 스크립트는 리눅스·맥 VPS용(가짜 CLI가 sh)';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const CODE = `argo_link_${'ab'.repeat(24)}`;

test('배포본 connect-bundle.js가 원본(connect.py + 플러그인)과 같다 — 다르면 node scripts/build-server-connect.mjs', async () => {
  assert.equal(await readFile(new URL('../supabase/functions/msgr-bot/connect-bundle.js', import.meta.url), 'utf8'), buildConnectScript());
  assert.match(CONNECT_PY, /"adapter\.py"/, '헤르메스 플러그인이 들어 있다');
  assert.match(CONNECT_PY, /"src\/channel\.ts"/, '오픈클로 플러그인이 들어 있다');
});

test('handleLink: 코드 형식·경로·RPC 오류를 사람이 읽을 안내로 옮긴다', async () => {
  assert.equal(parseLinkPath('https://x.supabase.co/functions/v1/msgr-bot/link/report'), 'report');
  assert.equal(parseLinkPath('https://x.supabase.co/functions/v1/msgr-bot/botargo_bot_x/getMe'), null);
  assert.equal((await handleLink('report', { code: 'nope' }, async () => {})).status, 400);
  assert.equal((await handleLink('drop', { code: CODE }, async () => {})).status, 404);
  const boom = (m) => async () => { throw new Error(m); };
  assert.equal((await handleLink('status', { code: CODE }, boom('msgr_link_invalid'))).status, 404);
  assert.match((await handleLink('status', { code: CODE }, boom('msgr_link_used'))).body.description, /already used/);
  assert.equal(connectScript('B = "__ARGO_MSGR_URL__"', 'http://kong:8000/functions/v1/msgr-bot'), 'B = "__ARGO_MSGR_URL__"', '공개 https 주소가 아니면 넣지 않는다');
  assert.equal(connectScript('B = "__ARGO_MSGR_URL__"', 'https://p.supabase.co/functions/v1/msgr-bot'), 'B = "https://p.supabase.co/functions/v1/msgr-bot"');
});

test('connect.py: 에이전트를 찾아 해시만 보고하고, 승인된 에이전트에만 플러그인·.env·게이트웨이를 설정한다', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-vps-'));
  const home = join(dir, 'home'); const bin = join(dir, 'bin'); const log = join(dir, 'cli.log');
  await mkdir(home, { recursive: true }); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'hermes'), `#!/bin/sh
echo "hermes $* HH=$HERMES_HOME" >> "$ARGO_TEST_LOG"
case "$1 $2" in
"profile list") printf ' Profile          Model      Gateway\\n ───────  ────  ────\\n ◆default         claude-opus-5   running\\n  research        gpt-6-astra   stopped\\n' ;;
"profile show") if [ "$3" = default ]; then echo "Path: $HOME/.hermes"; else echo "Path: $HOME/.hermes/profiles/$3"; fi ;;
"gateway status") echo "Gateway is not installed" ;;
esac
exit 0
`);
  await writeFile(join(bin, 'openclaw'), `#!/bin/sh
echo "openclaw $*" >> "$ARGO_TEST_LOG"
case "$1 $2" in
"agents list") printf 'Agents:\\n- main (default)\\n  Workspace: ~/.openclaw/workspace\\n' ;;
"config get") echo "Config path not found: bindings"; exit 1 ;;
esac
exit 0
`);
  await chmod(join(bin, 'hermes'), 0o755); await chmod(join(bin, 'openclaw'), 0o755);

  // 엣지 함수 흉내: 라우터는 실물(handleLink), DB는 상태 기계 한 벌. 보고가 오면 관리자가 hermes default + openclaw main만 고른 것으로 둔다.
  const st = { agents: null, host: null, approved: null, results: null };
  const rpc = async (fn, a) => {
    if (a.code !== CODE) throw new Error('msgr_link_invalid');
    if (fn === 'msgr_server_link_report') { st.agents = a.agents; st.host = a.host; st.approved = [{ kind: 'hermes', id: 'default' }, { kind: 'openclaw', id: 'main' }]; return null; }
    if (fn === 'msgr_server_link_status') return { status: st.approved ? 'approved' : 'waiting', approved: st.approved ?? [] };
    if (fn === 'msgr_server_link_done') { st.results = a.results; return null; }
    throw new Error(`unexpected ${fn}`);
  };
  const bodies = [];
  const srv = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c; bodies.push(raw);
    const { status, body } = await handleLink(parseLinkPath(`http://x${req.url}`), JSON.parse(raw || '{}'), rpc);
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/functions/v1/msgr-bot`;
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn('python3', ['-', CODE, base], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ARGO_TEST_LOG: log, LANG: 'C.UTF-8' } });
      let so = ''; p.stdout.on('data', (d) => { so += d; }); p.stderr.on('data', (d) => { so += d; });
      p.on('error', reject); p.on('close', (c) => resolve({ code: c, so }));
      p.stdin.end(connectScript(CONNECT_PY, 'http://kong:8000/functions/v1/msgr-bot')); // 배포본 그대로(주소는 인자가 정본)
    });
    assert.equal(out.code, 0, out.so);
    assert.doesNotMatch(out.so, /argo_bot_[0-9a-f]/, '화면에 토큰 원문이 없다');
    assert.ok(bodies.every((b) => !/argo_bot_[0-9a-f]{4}/.test(b)), '네트워크로 토큰 원문이 나가지 않는다(힌트 12자만)');

    assert.deepEqual(st.agents.map((a) => `${a.kind}:${a.id}:${a.name}:${a.default}`), ['hermes:default:Hermes:true', 'hermes:research:research:false', 'openclaw:main:OpenClaw:true']);
    const hashOf = (kind, id) => st.agents.find((a) => a.kind === kind && a.id === id).token_hash;

    // 헤르메스 default: 플러그인·.env(0600, 보고한 해시와 맞는 토큰)·enable·install+start(HERMES_HOME)
    const env = await readFile(join(home, '.hermes/.env'), 'utf8');
    assert.match(env, new RegExp(`^ARGO_MSGR_URL=${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    const tok = env.match(/^ARGO_MSGR_BOT_TOKEN=(argo_bot_[0-9a-f]{48})$/m)?.[1];
    assert.ok(tok); assert.equal(sha(tok), hashOf('hermes', 'default'));
    assert.equal((await stat(join(home, '.hermes/.env'))).mode & 0o777, 0o600);
    assert.ok(existsSync(join(home, '.hermes/plugins/argo-msgr/adapter.py')));
    assert.equal(existsSync(join(home, '.hermes/profiles/research/.env')), false, '고르지 않은 에이전트는 건드리지 않는다');

    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    const hh = `HH=${join(home, '.hermes')}`;
    for (const c of ['plugins enable argo-msgr-platform --no-allow-tool-override', 'gateway install', 'gateway start']) assert.ok(calls.includes(`hermes ${c} ${hh}`), `hermes ${c}`);
    assert.ok(!calls.some((c) => c.includes('research') && !c.startsWith('hermes profile show')), 'research에는 설치 명령이 없다');

    // 오픈클로 main: 플러그인·계정(해시 일치 토큰)·바인딩·게이트웨이 재시작
    assert.ok(existsSync(join(home, '.openclaw/extensions/openclaw-argo-msgr/src/channel.ts')));
    const set = (k) => calls.find((c) => c.startsWith(`openclaw config set channels.argo-msgr.accounts[main].${k} `))?.split(' ').pop();
    assert.equal(set('url'), base); assert.equal(set('enabled'), 'true'); assert.equal(sha(set('token')), hashOf('openclaw', 'main'));
    assert.ok(calls.includes('openclaw config set bindings [{"match": {"channel": "argo-msgr", "accountId": "main"}, "agentId": "main"}]'));
    assert.ok(calls.includes('openclaw gateway restart'));

    assert.deepEqual(st.results.map((r) => `${r.kind}:${r.id}:${r.ok}`), ['hermes:default:true', 'openclaw:main:true']);
    assert.equal(st.host.length > 0, true);
  } finally { srv.close(); }
});

test('connect.py: 게이트웨이가 없으면 보고하지 않고 안내만 한다', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-vps-none-'));
  const out = await new Promise((resolve) => {
    const p = spawn('python3', ['-', CODE, 'https://p.supabase.co/functions/v1/msgr-bot'], { env: { PATH: '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' } });
    let so = ''; p.stdout.on('data', (d) => { so += d; }); p.on('close', (c) => resolve({ code: c, so }));
    p.stdin.end(CONNECT_PY);
  });
  assert.equal(out.code, 3); assert.match(out.so, /찾지 못했습니다/);
});
