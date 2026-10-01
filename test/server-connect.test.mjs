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
  // 예전 CLI 형식(텍스트 목록만, 바인딩이 없으면 "Config path not found") — 최신 형식은 아래 오픈클로 전용 테스트가 본다
  await writeFile(join(bin, 'openclaw'), `#!/bin/sh
echo "openclaw $*" >> "$ARGO_TEST_LOG"
case "$1 $2" in
"--version ") echo "OpenClaw 2026.8.1 (abc1234)" ;;
"agents list") [ "$3" = "--json" ] && { echo "error: unknown option '--json'" >&2; exit 1; }; printf 'Agents:\\n- main (default)\\n  Workspace: ~/.openclaw/workspace\\n' ;;
"config get") echo "Config path not found: bindings"; exit 1 ;;
"plugins inspect") echo '{"plugin":{"id":"openclaw-argo-msgr","status":"loaded","error":null},"diagnostics":[]}' ;;
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
    for (const c of ['plugins enable argo-msgr-platform --no-allow-tool-override', 'config set approvals.mode manual', 'gateway install', 'gateway start']) assert.ok(calls.includes(`hermes ${c} ${hh}`), `hermes ${c}`);
    assert.ok(!calls.some((c) => c.includes('research') && !c.startsWith('hermes profile show')), 'research에는 설치 명령이 없다');

    // 오픈클로 main: 플러그인·계정(해시 일치 토큰)·바인딩·게이트웨이 재시작
    assert.ok(existsSync(join(home, '.openclaw/extensions/openclaw-argo-msgr/src/channel.ts')));
    const set = (k) => calls.find((c) => c.startsWith(`openclaw config set channels.argo-msgr.accounts[main].${k} `))?.split(' ').pop();
    assert.equal(set('url'), base); assert.equal(set('enabled'), 'true'); assert.equal(sha(set('token')), hashOf('openclaw', 'main'));
    assert.ok(calls.includes('openclaw config set bindings [{"match": {"channel": "argo-msgr", "accountId": "main"}, "agentId": "main"}]'));
    assert.ok(calls.includes('openclaw gateway restart'));
    assert.ok(calls.indexOf('openclaw config set tools.exec.mode ask') >= 0 && calls.indexOf('openclaw config set tools.exec.mode ask') < calls.indexOf('openclaw gateway restart'), '실행 승인 기본값 ask는 재시작 전에');

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

// 실서버 사례(2026-09-23 Hostinger VPS): 게이트웨이가 systemd 시스템 서비스(com.ai-native.hermes-gateway@<프로필>)로 돈다.
// 헤르메스는 이를 "Running manually"로 보고 `gateway restart`로 못 건드리고, `gateway install`을 부르면 게이트웨이가 둘이 된다 → 서비스를 재시작해야 한다.
async function runConnect({ statusOut, extraBin = {}, approve }) {
  const dir = await mkdtemp(join(tmpdir(), 'argo-vps-unit-'));
  const home = join(dir, 'home'); const bin = join(dir, 'bin'); const log = join(dir, 'cli.log');
  await mkdir(home, { recursive: true }); await mkdir(bin, { recursive: true });
  const files = {
    hermes: `#!/bin/sh\necho "hermes $* HH=$HERMES_HOME" >> "$ARGO_TEST_LOG"\ncase "$1 $2" in\n"profile list") printf ' Profile   Model   Gateway\\n ◆default  m  running\\n' ;;\n"profile show") echo "Path: $HOME/.hermes" ;;\n"gateway status") printf '${statusOut}' ;;\nesac\nexit 0\n`,
    ps: `#!/bin/sh\necho "ps $*" >> "$ARGO_TEST_LOG"\n[ "$4" = 4242 ] && echo "com.ai-native.hermes-gateway@default.service"\nexit 0\n`,
    ...extraBin,
  };
  for (const [n, body] of Object.entries(files)) { await writeFile(join(bin, n), body); await chmod(join(bin, n), 0o755); }
  const st = { results: null };
  const rpc = async (fn, a) => {
    if (fn === 'msgr_server_link_report') { st.approved = approve(a.agents); return null; }
    if (fn === 'msgr_server_link_status') return { status: 'approved', approved: st.approved };
    if (fn === 'msgr_server_link_done') { st.results = a.results; return null; }
  };
  const srv = createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c;
    const { status, body } = await handleLink(parseLinkPath(`http://x${req.url}`), JSON.parse(raw || '{}'), rpc);
    res.writeHead(status); res.end(JSON.stringify(body)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/functions/v1/msgr-bot`;
  try {
    const out = await new Promise((resolve) => {
      const p = spawn('python3', ['-', CODE, base], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ARGO_TEST_LOG: log, LANG: 'C.UTF-8' } });
      let so = ''; p.stdout.on('data', (d) => { so += d; }); p.stderr.on('data', (d) => { so += d; });
      p.on('close', (c) => resolve({ code: c, so })); p.stdin.end(CONNECT_PY);
    });
    return { ...out, calls: (await readFile(log, 'utf8')).trim().split('\n'), st };
  } finally { srv.close(); }
}
const pickAll = (agents) => agents.map((a) => ({ kind: a.kind, id: a.id }));

test('connect.py: 시스템 서비스로 도는 게이트웨이는 그 서비스를 재시작한다(gateway restart·install 금지)', { skip }, async () => {
  const r = await runConnect({ statusOut: '✓ Gateway is running (PID: 4242)\\n  (Running manually, not as a system service)\\n', approve: pickAll,
    extraBin: { sudo: '#!/bin/sh\necho "sudo $*" >> "$ARGO_TEST_LOG"\nexit 0\n' } });
  assert.equal(r.code, 0, r.so);
  assert.ok(r.calls.includes('sudo -n systemctl restart com.ai-native.hermes-gateway@default.service'), r.calls.join('\n'));
  assert.ok(!r.calls.some((c) => /hermes gateway (restart|install|start)/.test(c)), '헤르메스 자체 재시작·설치를 부르지 않는다');
  assert.deepEqual(r.st.results.map((x) => x.ok), [true]);
});

test('connect.py: 서비스 재시작 권한이 없으면 실패로 보고하고 root로 다시 실행하라고 안내한다', { skip }, async () => {
  const r = await runConnect({ statusOut: '✓ Gateway is running (PID: 4242)\\n', approve: pickAll,
    extraBin: { sudo: '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n' } });
  assert.equal(r.code, 7);
  assert.equal(r.st.results[0].ok, false);
  assert.match(r.st.results[0].detail, /root/);
});

test('connect.py: 서비스가 아닌 게이트웨이는 종전대로 hermes gateway restart', { skip }, async () => {
  const r = await runConnect({ statusOut: '✓ Gateway is running (PID: 777)\\n', approve: pickAll });
  assert.equal(r.code, 0, r.so);
  assert.ok(r.calls.some((c) => c.startsWith('hermes gateway restart')));
});

// root로 붙여넣었을 때(Hostinger 브라우저 터미널 기본): 에이전트 계정으로 넘겨 돌리고, 서비스 재시작은 root가 한다.
test('connect.py: root이고 에이전트가 다른 계정에 있으면 그 계정으로 넘기고 서비스 재시작은 root가 맡는다', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-vps-root-'));
  const crewHome = join(dir, 'crew'); await mkdir(join(crewHome, '.hermes'), { recursive: true });
  const py = `
import json, os, sys, types, pwd, subprocess, urllib.request
src = sys.stdin.read()
m = types.ModuleType("c"); m.__dict__["__name__"] = "c"; exec(compile(src, "connect.py", "exec"), m.__dict__)
calls = []
m.os.geteuid = lambda: 0
m.pwd.getpwall = lambda: [pwd.struct_passwd(("root","x",0,0,"","/root","/bin/sh")), pwd.struct_passwd(("crew","x",1000,1000,"",${JSON.stringify(crewHome)},"/bin/sh"))]
m.os.chown = lambda *a: None
m.list_agents = lambda: ([{"kind": "hermes", "id": "default", "name": "Hermes", "default": True, "home": "/root/.hermes"}], {"hermes": "/usr/local/bin/hermes"})  # 실서버: root에도 빈 기본 프로필이 있다 — 그래도 crew로 넘겨야 한다
class R:
    def __init__(s): pass
    def read(s): return b"print('child')"
    def __enter__(s): return s
    def __exit__(s, *a): pass
m.urllib.request.urlopen = lambda *a, **k: R()
def fake_call(cmd):
    calls.append(cmd)
    if cmd[0] == "runuser":
        res = [x for x in cmd[-1].split() if x.startswith("ARGO_CONNECT_DEFER=")][0].split("=", 1)[1]
        json.dump({"results": [{"kind": "hermes", "id": "aesop", "ok": True, "detail": "", "unit": "com.ai-native.hermes-gateway@aesop.service"}], "names": {"hermes:aesop": "aesop"}}, open(res, "w"))
    return 0
m.subprocess.call = fake_call
m.run = lambda cli, args, env=None: (calls.append([cli] + args) or (True, "ok"))
posted = []
m.post = lambda path, payload: posted.append((path, payload)) or {}
rc = m.main(["x", ${JSON.stringify(CODE)}, "https://p.supabase.co/functions/v1/msgr-bot"])
print(json.dumps({"rc": rc, "calls": calls, "posted": posted}))
`;
  const out = await new Promise((resolve) => {
    const p = spawn('python3', ['-c', py], { env: { PATH: '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' } });
    let so = ''; p.stdout.on('data', (d) => { so += d; }); p.stderr.on('data', (d) => { so += d; });
    p.on('close', (c) => resolve({ c, so })); p.stdin.end(CONNECT_PY);
  });
  const j = JSON.parse(out.so.trim().split('\n').pop());
  assert.equal(j.rc, 0, out.so);
  const ru = j.calls.find((c) => c[0] === 'runuser');
  assert.deepEqual(ru.slice(0, 3), ['runuser', '-l', 'crew'], '에이전트 계정으로 넘긴다');
  assert.equal(ru[3], '-c'); assert.match(ru[4], /python3 \S+connect\.py argo_link_/);
  assert.ok(j.calls.some((c) => c.join(' ') === 'systemctl restart com.ai-native.hermes-gateway@aesop.service'), 'root가 서비스 재시작');
  assert.deepEqual(j.posted.map((p) => p[0]), ['link/done']);
  assert.equal(j.posted[0][1].results[0].ok, true); assert.equal('unit' in j.posted[0][1].results[0], false);
});

// ── 오픈클로 전용(2026-09-29): 최신 CLI(2026.8.1+)에서 처음 설치하는 서버, 채널 줄 오인, 로드 실패, 오래된 버전 ──
// 실측 근거(격리 설치 openclaw@2026.9.6): 바인딩이 없으면 `config get bindings --json`이 rc=1 + {"ok":false,"error":{"message":"Config path is valid but unset: bindings…"}},
// `agents list` 텍스트에는 들여쓴 채널 줄("    - Argo Messenger main: configured")이 섞이고, `plugins enable`은 로드 실패여도 rc=0이다.
const OC_AGENTS_TEXT = 'Agents:\n- main (default)\n  Workspace: ~/.openclaw/workspace\n  Routing rules: 1\n  Providers:\n    - Argo Messenger main: configured\n    - Telegram default: configured\n- support\n  Workspace: ~/.openclaw/workspace-support\nRouting rules map channel/account/peer to an agent.\n';
const OC_AGENTS_JSON = '[{"id":"main","workspace":"/w","bindings":1,"isDefault":true},{"id":"support","workspace":"/w2","bindings":0,"isDefault":false}]';
const OC_UNSET = '{\n  "ok": false,\n  "error": {\n    "type": "cli_error",\n    "message": "Config path is valid but unset: bindings. The runtime default applies until you set an authored value with openclaw config set bindings <value>."\n  }\n}';
const OC_LOADED = '{"plugin":{"id":"openclaw-argo-msgr","status":"loaded","error":null},"diagnostics":[]}';
const OC_LOAD_FAILED = '{"plugin":{"id":"openclaw-argo-msgr","status":"error","error":"Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath \'./plugin-sdk\' is not defined by \\"exports\\""},"diagnostics":[{"level":"error","message":"plugin failed during load"}]}';

function fakeOpenclaw({ version = 'OpenClaw 2026.9.6 (eb377ac)', agentsJson = OC_AGENTS_JSON, inspect = OC_LOADED } = {}) {
  const block = (tag, text) => `cat <<'${tag}'\n${text}\n${tag}\n`;
  return `#!/bin/sh
echo "openclaw $*" >> "$ARGO_TEST_LOG"
case "$1 $2" in
"--version ") echo "${version}" ;;
"agents list") if [ "$3" = "--json" ]; then
${agentsJson == null ? 'echo "error: unknown option --json" >&2; exit 1\n' : block('AJ', agentsJson)}else
${block('AT', OC_AGENTS_TEXT)}fi ;;
"config get") if [ -f "$HOME/bindings.json" ]; then cat "$HOME/bindings.json"; else
${block('UNSET', OC_UNSET)}exit 1; fi ;;
"config set") [ "$3" = bindings ] && printf '%s' "$4" > "$HOME/bindings.json" ;;
"plugins inspect")
${block('PI', inspect)};;
"plugins registry") [ "$3" = "--refresh" ] && : > "$HOME/registry-refreshed" ;;
"plugins enable") [ -f "$HOME/registry-refreshed" ] || { echo "[openclaw] Reason: plugin not installed: openclaw-argo-msgr" >&2; exit 1; } ;;
esac
exit 0
`;
}

async function runOpenclawOnly({ openclaw, approve = pickAll, script = CONNECT_PY }) {
  const dir = await mkdtemp(join(tmpdir(), 'argo-vps-oc-'));
  const home = join(dir, 'home'); const bin = join(dir, 'bin'); const log = join(dir, 'cli.log');
  await mkdir(home, { recursive: true }); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'openclaw'), openclaw); await chmod(join(bin, 'openclaw'), 0o755);
  await writeFile(log, '');
  const st = { agents: null, results: null };
  const rpc = async (fn, a) => {
    if (fn === 'msgr_server_link_report') { st.agents = a.agents; st.approved = approve(a.agents); return null; }
    if (fn === 'msgr_server_link_status') return { status: 'approved', approved: st.approved };
    if (fn === 'msgr_server_link_done') { st.results = a.results; return null; }
  };
  const srv = createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c;
    const { status, body } = await handleLink(parseLinkPath(`http://x${req.url}`), JSON.parse(raw || '{}'), rpc);
    res.writeHead(status); res.end(JSON.stringify(body)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/functions/v1/msgr-bot`;
  try {
    const out = await new Promise((resolve) => {
      const p = spawn('python3', ['-', CODE, base], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ARGO_TEST_LOG: log, LANG: 'C.UTF-8' } });
      let so = ''; p.stdout.on('data', (d) => { so += d; }); p.stderr.on('data', (d) => { so += d; });
      p.on('close', (c) => resolve({ code: c, so })); p.stdin.end(script);
    });
    const bindings = existsSync(join(home, 'bindings.json')) ? JSON.parse(await readFile(join(home, 'bindings.json'), 'utf8')) : null;
    return { ...out, home, calls: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean), st, bindings };
  } finally { srv.close(); }
}

test('connect.py(오픈클로 최신): 바인딩이 아직 없는 서버에서도 연결된다 — "valid but unset" JSON 오류를 빈 목록으로 읽는다', { skip }, async () => {
  const r = await runOpenclawOnly({ openclaw: fakeOpenclaw(), approve: (agents) => agents.filter((a) => a.id === 'main').map(({ kind, id }) => ({ kind, id })) });
  assert.equal(r.code, 0, r.so);
  assert.deepEqual(r.st.results.map((x) => `${x.kind}:${x.id}:${x.ok}`), ['openclaw:main:true'], r.so);
  assert.deepEqual(r.bindings, [{ match: { channel: 'argo-msgr', accountId: 'main' }, agentId: 'main' }]);
  assert.ok(r.calls.includes('openclaw gateway restart'));
});

test('connect.py(오픈클로): 게이트웨이가 돌고 있어도 방금 복사한 플러그인을 켠다 — enable 전에 플러그인 목록을 다시 만든다', { skip }, async () => {
  const r = await runOpenclawOnly({ openclaw: fakeOpenclaw() });
  assert.equal(r.code, 0, r.so);
  const at = (c) => r.calls.indexOf(c);
  assert.ok(at('openclaw plugins registry --refresh') >= 0 && at('openclaw plugins registry --refresh') < at('openclaw plugins enable openclaw-argo-msgr'), r.calls.join('\n'));
  assert.ok(at('openclaw plugins enable openclaw-argo-msgr') < at('openclaw plugins inspect openclaw-argo-msgr --runtime --json'), '켠 뒤에 실제 로드를 확인한다');
});

test('connect.py(오픈클로): 에이전트 목록은 --json으로 읽고, 채널·공급자 줄("    - Argo Messenger main: configured")은 에이전트가 아니다', { skip }, async () => {
  const r = await runOpenclawOnly({ openclaw: fakeOpenclaw() });
  assert.deepEqual(r.st.agents.map((a) => `${a.id}:${a.default}`), ['main:true', 'support:false']);
  assert.ok(r.calls.includes('openclaw agents list --json'));
  assert.equal(r.code, 0, r.so);
});

test('connect.py(오픈클로): --json이 없는 CLI의 텍스트 목록에서도 들여쓴 채널 줄은 건너뛴다', { skip }, async () => {
  const r = await runOpenclawOnly({ openclaw: fakeOpenclaw({ agentsJson: null }) });
  assert.deepEqual(r.st.agents.map((a) => `${a.id}:${a.default}`), ['main:true', 'support:false'], '"Argo"·"Telegram"을 에이전트로 보고하지 않는다');
  assert.equal(r.code, 0, r.so);
});

test('connect.py(오픈클로): 플러그인이 실제로 로드되지 않으면(enable은 rc=0) 설정·재시작 없이 실패로 보고한다', { skip }, async () => {
  const r = await runOpenclawOnly({ openclaw: fakeOpenclaw({ inspect: OC_LOAD_FAILED }) });
  assert.equal(r.code, 7, r.so);
  assert.ok(r.calls.includes('openclaw plugins inspect openclaw-argo-msgr --runtime --json'));
  assert.ok(r.st.results.every((x) => x.ok === false && /ERR_PACKAGE_PATH_NOT_EXPORTED/.test(x.detail) && /업데이트/.test(x.detail)), JSON.stringify(r.st.results));
  assert.ok(!r.calls.some((c) => c.startsWith('openclaw config set') || c.startsWith('openclaw gateway')), '계정·바인딩을 쓰지 않고 게이트웨이도 건드리지 않는다');
});

test('connect.py(오픈클로): 최소 버전(2026.8.1) 미만이면 설치하지 않고 "OpenClaw를 업데이트하세요"로 끝난다', { skip }, async () => {
  for (const version of ['OpenClaw 2026.2.23 (1a2b3c4)', 'OpenClaw 2026.8.1-beta.3 (1a2b3c4)', 'openclaw: command output without a version']) {
    const r = await runOpenclawOnly({ openclaw: fakeOpenclaw({ version }) });
    assert.equal(r.code, 8, `${version}\n${r.so}`);
    assert.match(r.so, /OpenClaw를 (업데이트하세요|2026\.8\.1 이상으로 업데이트)/);
    assert.equal(r.st.agents, null, '서버에 보고하지 않는다(연결 코드도 쓰지 않는다)');
    assert.equal(existsSync(join(r.home, '.openclaw/extensions/openclaw-argo-msgr')), false, '플러그인을 깔지 않는다');
    assert.deepEqual(r.calls, ['openclaw --version']);
  }
  const ok = await runOpenclawOnly({ openclaw: fakeOpenclaw({ version: 'OpenClaw 2026.8.1 (1a2b3c4)' }) });
  assert.equal(ok.code, 0, ok.so);
});

// 1-b(2026-09-29 유건 결정) — 연결할 때 위험 명령은 사람에게 묻는 모드를 기본값으로, 이미 명시한 값은 덮어쓰지 않는다(카드에 실제 모드 안내)
test('connect.py: 승인 모드 기본값 — 명시한 값이 없을 때만 Hermes manual·OpenClaw ask, 있으면 그대로(블록·한 줄 YAML 둘 다)', { skip }, async () => {
  const py = String.raw`
import importlib.util, sys, os, tempfile
spec = importlib.util.spec_from_file_location('connect', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.yaml_sets('approvals:\n  mode: smart\n', 'approvals', 'mode')
assert m.yaml_sets('approvals: {mode: off, timeout: 60}\n', 'approvals', 'mode')
assert m.yaml_sets('model: x\napprovals:\n  # 주석\n\n  timeout: 60\n  mode: manual\nother: 1\n', 'approvals', 'mode')
assert not m.yaml_sets('approvals:\n  timeout: 60\nmode: smart\n', 'approvals', 'mode'), '다른 최상위 키의 mode는 아니다'
assert not m.yaml_sets('auxiliary:\n  approvals:\n    mode: smart\n', 'approvals', 'mode'), '중첩된 같은 이름은 아니다'
assert not m.yaml_sets('approvals:\n  gateway:\n    mode: strict\n  timeout: 60\n', 'approvals', 'mode'), 'approvals 아래 더 깊은 mode는 아니다(검수 LOW)'
assert not m.yaml_sets('', 'approvals', 'mode')
calls = []
m.run = lambda cli, args, env=None: calls.append(args) or (True, '')
d = tempfile.mkdtemp()
assert m.default_manual_approvals_hermes('hermes', d, {}) == 'manual' and calls[-1] == ['config', 'set', 'approvals.mode', 'manual']
open(os.path.join(d, 'config.yaml'), 'w').write('approvals:\n  mode: smart\n')
n = len(calls)
assert m.default_manual_approvals_hermes('hermes', d, {}) == 'kept' and len(calls) == n, '명시한 smart는 덮어쓰지 않는다'
m.run = lambda cli, args, env=None: calls.append(args) or ((False, 'Config path not found') if args[:2] == ['config', 'get'] else (True, ''))
assert m.default_ask_exec_openclaw('openclaw') == 'ask' and calls[-1] == ['config', 'set', 'tools.exec.mode', 'ask']
m.run = lambda cli, args, env=None: calls.append(args) or ((True, '"full"\n') if args[:2] == ['config', 'get'] else (True, ''))
n = len(calls)
assert m.default_ask_exec_openclaw('openclaw') == 'kept' and len(calls) == n + 1, '명시한 full은 덮어쓰지 않는다'
m.run = lambda cli, args, env=None: (False, 'boom')
assert m.default_manual_approvals_hermes('hermes', tempfile.mkdtemp(), {}) == 'failed', '설정 실패는 연결을 막지 않고 보고만'
`;
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('python3', ['-c', py, new URL('../integrations/server-connect/connect.py', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
