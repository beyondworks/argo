// 재현 경로 잠금 — **실제 SDK 턴**(claude-agent-sdk → CLI → Bash 도구)이 이 서버의 API를 직접 부르면 막힌다.
// 재현(PR #916 분리 검수, 2026-10-09 격리 서버): 에이전트 Bash의 curl·python이 루틴 삭제·결재 자가 승인·주인 직접 턴 열기에 성공했다.
// 이 시험 프로세스가 서버 자리(installAgentPeerGuard)이고, chat()이 띄운 SDK CLI → Bash → node/curl이 에이전트 자리다(실제 프로세스 사슬).
// 모델은 가짜 Messages 엔드포인트(자식 프로세스 — 이 프로세스의 HTTP 서버는 전부 판정 대상이라 CLI의 모델 호출까지 막히지 않게 밖에 둔다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const onWin = process.platform === 'win32'; // 서버 판정은 Windows 미적용(src/agent-peer.mjs 머리말). Windows의 Bash 도구 따옴표 차이도 이 시험에서는 확인하지 않았다 — 셋 다 건너뛴다
const root = await mkdtemp(join(tmpdir(), 'argo-agent-loopback-'));
const home = await mkdtemp(join(tmpdir(), 'argo-agent-loopback-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PORT']) delete process.env[key];

// 가짜 모델(자식 프로세스) — 큐 파일의 Bash 명령을 도구 호출로 한 번 내고, 돌아온 tool_result를 결과 파일에 적는다
const queueFile = join(root, 'queue.json'); const resultFile = join(root, 'results.json');
const MODEL = `
const http = require('node:http'); const fs = require('node:fs');
const [queueFile, resultFile] = process.argv.slice(1);
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write('event: ' + e + '\\ndata: ' + JSON.stringify(d) + '\\n\\n'); res.end(); };
const start = () => ({ type: 'message_start', message: { id: 'm' + Date.now(), type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
  if (!(req.method === 'POST' && req.url.startsWith('/v1/messages'))) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const body = JSON.parse(b || '{}'); const last = (body.messages || []).at(-1);
  const rs = Array.isArray(last && last.content) ? last.content.filter((c) => c.type === 'tool_result') : [];
  if (rs.length) { const prev = JSON.parse(fs.readFileSync(resultFile, 'utf8')); prev.push(...rs.map((r) => typeof r.content === 'string' ? r.content : JSON.stringify(r.content))); fs.writeFileSync(resultFile, JSON.stringify(prev)); }
  const q = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  if (!rs.length && (body.tools || []).some((t) => t.name === 'Bash') && q.length) {
    const cmd = q.shift(); fs.writeFileSync(queueFile, JSON.stringify(q));
    return sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu' + Date.now(), name: 'Bash', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: cmd, description: 'x' }) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
  }
  sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
}); });
s.listen(0, '127.0.0.1', () => console.log(s.address().port));`;
await writeFile(queueFile, '[]'); await writeFile(resultFile, '[]');
const model = spawn(process.execPath, ['-e', MODEL, queueFile, resultFile], { stdio: ['ignore', 'pipe', 'inherit'] });
after(() => model.kill());
const modelPort = await new Promise((resolve) => model.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${modelPort}`;

// 서버 자리 — 판정을 끼운 HTTP 서버. /api/ping은 Argo 신원 마커(권한 게이트 탐침이 이 서버를 Argo로 알아본다).
const { installAgentPeerGuard } = await import('../src/agent-peer.mjs');
installAgentPeerGuard();
const reached = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/ping') return res.end('{"argo":true}');
    reached.push(`${req.method} ${req.url}`); res.end('{"ok":true}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => srv.close());
const PORT = srv.address().port;

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const ws = 'agent-loopback';
await createCompany(ws, '루프백', 'owner', null, 'ko');
await mkdir(paths(ws).agents, { recursive: true });
await writeFile(join(paths(ws).agents, 'x.md'), '---\nname: 엑스\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다

async function agentRuns(command) {
  await writeFile(queueFile, JSON.stringify([command])); await writeFile(resultFile, '[]');
  reached.length = 0;
  await chat(ws, 'x', '해 줘', null, {});
  const results = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(results.length, 1, `도구 결과가 정확히 한 건 — ${JSON.stringify(results).slice(0, 200)}`);
  return results[0];
}
// 문자열을 쪼개 조립한 주소 — 권한 게이트의 셸 문자열 판정을 지나가는 모양(재현의 python과 같은 계열). 서버 판정만으로 막혀야 한다.
const split = (path, method, body) => `node -e "fetch('http://'+['127','0','0','1'].join('.')+':'+(${PORT - 7}+7)+'${path}',{method:'${method}',headers:{cookie:'argo-device=1','content-type':'application/json'}${body ? `,body:JSON.stringify(${body})` : ''}}).then(async r=>console.log(r.status, await r.text()))"`;

test('실제 SDK 턴: 쪼갠 주소로 부른 루틴 삭제·결재 자가 승인·대화 시작이 모두 403 agent_loopback — 서버 핸들러에 닿지 않는다', { skip: onWin, timeout: 120_000 }, async () => {
  for (const [path, method, body] of [
    ['/api/companies/agent-loopback/routines?id=r1', 'DELETE'],
    ['/api/companies/agent-loopback/approvals', 'POST', "{id:'ap-1',approve:true}"],
    ['/api/companies/agent-loopback/chat', 'POST', "{slug:'y',message:'AGENT-OPENED-TURN'}"],
  ]) {
    const out = await agentRuns(split(path, method, body));
    assert.match(out, /403 .*"errorCode":"agent_loopback"/, `${method} ${path}: ${out.slice(0, 200)}`);
    assert.deepEqual(reached, [], `${method} ${path}가 핸들러에 닿았다`);
  }
});

test('실제 SDK 턴: 재현과 같은 리터럴 curl은 실행 전에 권한 게이트가 거절하고 이유를 알린다', { skip: onWin, timeout: 120_000 }, async () => {
  const out = await agentRuns(`curl -s -X DELETE -H 'Cookie: argo-device=1' 'http://127.0.0.1:${PORT}/api/companies/agent-loopback/routines?id=r1'`);
  assert.match(out, /루프백 주소가 들어 있습니다/, out.slice(0, 200));
  assert.deepEqual(reached, []);
});

test('실제 SDK 턴: 부모를 끊고 나간 고아 curl(백그라운드 묶음)의 결재 승인도 403 — 핸들러에 닿지 않는다', { skip: onWin, timeout: 120_000 }, async () => {
  const outFile = join(root, 'orphan.txt');
  // 리터럴 주소는 권한 게이트가 먼저 막으므로 셸 산술로 포트를 만든다(게이트를 지나 서버 판정만 받는 모양)
  const out = await agentRuns(`(curl -s -w ' %{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"ap-1","approve":true}' http://127.0.0.$((0+1)):$((${PORT - 7}+7))/api/companies/agent-loopback/approvals > '${outFile}' 2>&1 &) ; for i in 1 2 3 4 5 6 7 8 9 10; do [ -s '${outFile}' ] && break; sleep 0.5; done; cat '${outFile}'`);
  assert.match(out, /agent_loopback.* 403/, out.slice(0, 300));
  assert.deepEqual(reached, []);
});

test('실제 SDK 턴: 세션을 새로 만들어 Bash 명령이 끝난 뒤에도 살아남는 고아(perl setsid → exec curl)의 루틴 삭제도 403', { skip: onWin, timeout: 120_000 }, async () => {
  // Claude CLI는 Bash 명령이 끝나면 그 그룹을 정리한다(실측 — 같은 그룹 고아는 요청 전에 사라졌다). 살아남는 모양은 세션 분리뿐이다.
  const outFile = join(root, 'orphan-setsid.txt');
  const perl = `use POSIX; if (fork() == 0) { POSIX::setsid(); select(undef,undef,undef,1.5); open(STDOUT, q{>}, q{${outFile}}); exec(q{curl}, q{-s}, q{-w}, q{ %{http_code}}, q{-X}, q{DELETE}, q{http://127.0.0.} . (0+1) . q{:} . (${PORT - 7}+7) . q{/api/companies/agent-loopback/routines?id=r1}); } exit 0;`;
  await agentRuns(`perl -e '${perl}' ; echo launched`);
  let out = '';
  for (let i = 0; i < 60 && !/\d{3}$/.test(out); i++) { await new Promise((r) => setTimeout(r, 250)); out = await readFile(outFile, 'utf8').catch(() => ''); }
  assert.match(out, /agent_loopback.* 403$/, out.slice(0, 300));
  assert.deepEqual(reached, []);
});

test('실제 SDK 턴: 에이전트 셸이 표지 env를 물려받는다(부모를 끊어도 남는 근거)', { skip: onWin, timeout: 120_000 }, async () => {
  const out = await agentRuns('printenv ARGO_AGENT_PROC');
  assert.equal(out.trim(), String(process.pid), out.slice(0, 200));
});

test('실제 SDK 턴: 루프백이 아닌 평범한 셸은 그대로 실행된다(회귀 없음)', { skip: onWin, timeout: 120_000 }, async () => {
  const out = await agentRuns('echo NORMAL-SHELL-7777');
  assert.match(out, /NORMAL-SHELL-7777/);
});
