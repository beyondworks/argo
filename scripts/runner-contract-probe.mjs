#!/usr/bin/env node
// 러너 계약 프로브 — codex 핀 승격(CODEX_PIN 변경)의 필수 관문.
//
// 왜: 벤더 CLI는 우리 API가 아니다 — 의미가 무통보로 바뀐다(실사고 2026-08-25: code_mode_host가
// 0.147 폴백 → 0.148+ fail-closed로 바뀌어 전 사용자 도구 잠김. 실측 2026-08-28: 0.149.1이
// wire_api="chat"을 제거 — 구계약 기준 통합이 그대로 깨짐). 이 프로브는 Argo가 의존하는 계약면을
// 실행으로 검증한다. 승격 절차: CODEX_PIN을 올리기 전, 새 바이너리로 이 스크립트가 초록이어야 한다.
//
// 사용: node scripts/runner-contract-probe.mjs [codex-바이너리-경로]
//   기본 대상 = 관리본(~/.argo/tools/codex-cli/codex). 실자격 불필요 — 가짜 auth.json + 로컬 목
//   모델(Responses SSE)로 승인 왕복까지 오프라인 검증한다(구독·한도·과금 무관).
//
// 검증 계약면(2026-08-28 스파이크 실측으로 확정):
//   C1. --version 부팅
//   C2. exec 표면 — externalExec가 쓰는 플래그(--sandbox danger-full-access·--output-last-message)
//   C3. app-server 프로토콜 스키마 — 엔진 하네스 설계가 딛는 메서드 존재
//       (initialize·thread/start·turn/start·item/commandExecution/requestApproval·account/rateLimits/read)
//   C4. 승인 왕복 실행 — 목 모델의 exec_command 호출이 승인 요청으로 클라이언트에 오고,
//       decline이 실행을 실제로 막고(파일 미생성), accept가 실행한다(파일 생성). fail-closed 방향까지.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(execFile);
const BIN = process.argv[2] || join(homedir(), '.argo', 'tools', 'codex-cli', process.platform === 'win32' ? 'codex.exe' : 'codex');

const results = [];
const check = (id, ok, detail = '') => {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
};

/* ── C1·C2: 실행 표면 ── */
async function probeExecSurface() {
  const v = await execP(BIN, ['--version'], { timeout: 30_000 }).then((r) => r.stdout.trim(), () => '');
  check('C1 version-boot', !!v, v || '바이너리가 부팅하지 않음');
  const help = await execP(BIN, ['exec', '--help'], { timeout: 30_000 }).then((r) => `${r.stdout}\n${r.stderr}`, () => '');
  check('C2 exec-sandbox-flag', /danger-full-access/.test(help), 'externalExec의 --sandbox 값');
  check('C2 exec-output-flag', /--output-last-message/.test(help), 'externalExec의 응답 회수 경로');
}

/* ── C3: app-server 스키마 계약면 ── */
async function probeSchema(tmp) {
  const out = join(tmp, 'schema');
  const ok = await execP(BIN, ['app-server', 'generate-json-schema', '--out', out], { timeout: 60_000 }).then(() => true, () => false);
  if (!ok) { check('C3 schema-generate', false, 'generate-json-schema 실패'); return; }
  check('C3 schema-generate', true);
  // 메서드·enum 정의는 번들 하나가 아니라 파일들에 나뉘어 있다(ServerRequest.json 등) — 전체를 이어 본다
  let bundle = '';
  for (const n of await readdir(out).catch(() => [])) {
    if (n.endsWith('.json')) bundle += await readFile(join(out, n), 'utf8').catch(() => '');
  }
  for (const m of ['initialize', 'thread/start', 'turn/start', 'thread/resume', 'turn/interrupt',
    'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'account/rateLimits/read']) {
    check(`C3 method:${m}`, bundle.includes(`"${m}"`));
  }
  // 승인 응답 enum — 우리 게이트가 보낼 값. 이름이 바뀌면(denied→decline 같은) 게이트가 무언 fail-closed로만 남는다.
  for (const d of ['accept', 'acceptForSession', 'decline']) check(`C3 decision:${d}`, bundle.includes(`"${d}"`));
}

/* ── C4: 승인 왕복(오프라인 — 목 Responses 모델) ── */
function startMockModel(cmdLine) {
  let calls = 0;
  const sse = (res, type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`);
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls += 1;
      let parsed = null; try { parsed = JSON.parse(body); } catch { /* 무시 */ }
      const first = !(parsed?.input ?? []).some((it) => it?.type === 'function_call_output');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const rid = `resp_${calls}`;
      sse(res, 'response.created', { response: { id: rid } });
      const item = first
        ? { type: 'function_call', id: `fc_${calls}`, call_id: `call_${calls}`, name: 'exec_command', arguments: JSON.stringify({ cmd: cmdLine }) }
        : { type: 'message', id: `msg_${calls}`, role: 'assistant', content: [{ type: 'output_text', text: 'PROBE-DONE' }] };
      sse(res, 'response.output_item.added', { output_index: 0, item });
      sse(res, 'response.output_item.done', { output_index: 0, item });
      sse(res, 'response.completed', { response: { id: rid, output: [item], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } });
      res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

async function approvalRoundTrip(tmp, decision) {
  const home = join(tmp, `home-${decision}`);
  const work = join(tmp, `work-${decision}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(work, { recursive: true });
  // 실자격 불요 — 목 프로바이더는 인증을 검사하지 않는다. 가짜 auth로 실자격 미접촉을 보장한다.
  await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'probe-fake', tokens: null }), { mode: 0o600 });
  const { srv, port } = await startMockModel('touch APPROVAL-PROBE.txt');
  await writeFile(join(home, 'config.toml'), `[model_providers.argomock]\nname = "argomock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n`);
  const child = spawn(BIN, ['app-server'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  const pending = new Map();
  const state = { approvals: 0, done: false, reply: '' };
  const send = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      } else if (m.id !== undefined && m.method) {
        // 서버→클라 요청: 승인이면 지정 결정, 그 외는 빈 수락
        if (/approval/i.test(m.method)) state.approvals += 1;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: /approval/i.test(m.method) ? { decision } : {} }) + '\n');
      } else if (m.method === 'item/completed' && m.params?.item?.type === 'agentMessage') {
        state.reply = String(m.params.item.text ?? '');
      } else if (m.method === 'turn/completed') state.done = true;
    }
  });
  try {
    await send('initialize', { clientInfo: { name: 'argo-contract-probe', title: 'Argo Probe', version: '0.0.1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    const th = await send('thread/start', { cwd: work, approvalPolicy: 'untrusted', sandbox: 'read-only', modelProvider: 'argomock', model: 'probe-1' });
    await send('turn/start', { threadId: th.thread?.id, input: [{ type: 'text', text: 'run the task' }] });
    const t0 = Date.now();
    while (!state.done && Date.now() - t0 < 90_000) await new Promise((r) => setTimeout(r, 250));
  } finally {
    child.kill();
    srv.close();
  }
  const files = await readdir(work).catch(() => []);
  return { ...state, fileCreated: files.includes('APPROVAL-PROBE.txt') };
}

async function probeApproval(tmp) {
  const dec = await approvalRoundTrip(tmp, 'decline');
  check('C4 approval-request-arrives', dec.approvals === 1, `승인 요청 ${dec.approvals}건`);
  check('C4 decline-blocks-exec', dec.done && !dec.fileCreated, dec.done ? '' : '턴 미완주');
  check('C4 decline-turn-completes', dec.done && dec.reply === 'PROBE-DONE', '거부 후에도 턴이 정상 종료(모델에 결과 전달)');
  const acc = await approvalRoundTrip(tmp, 'accept');
  check('C4 accept-executes', acc.done && acc.fileCreated, 'accept가 실제 실행(승인=샌드박스 승격)');
}

const tmp = await mkdtemp(join(tmpdir(), 'argo-runner-probe-'));
try {
  console.log(`## 대상: ${BIN}`);
  await probeExecSurface();
  if (results.every((r) => r.ok)) { // 부팅 실패면 이후 프로브는 소음 — 조기 종료
    await probeSchema(tmp);
    await probeApproval(tmp);
  }
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
const fails = results.filter((r) => !r.ok);
console.log(`\n## ${fails.length ? 'FAIL' : 'PASS'} — ${results.length - fails.length}/${results.length}`);
process.exit(fails.length ? 1 : 0);
