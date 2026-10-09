// codex exec `--json` 실행 경로(작업 과정 보이기, 2026-10-09) — 핀 관리본 자리에 가짜 codex를 두고 externalExec를 실제로 태운다.
// 사람 모드에서 stderr로 오던 경고·실패 문구가 JSON 모드에선 stdout 이벤트로 옮겨 간다(핀 0.159.3 실측). 기존 판정이 같은 글을 보는지 잠근다:
//  ① 성공: --json이 붙고, 이벤트가 onEvent로 흐르며, 최종 답은 종전처럼 --output-last-message 파일
//  ② 실패(없는 모델 400): 사람 모드와 같은 벤더 원인 문구로 실패한다(자가치유·업데이트 안내가 같은 입력)
//  ③ 도구 잠김 경고: JSON 모드에서도 잠김(toolLockup)으로 승격된다
//  ④ ARGO_CODEX_JSON=0 이면 옛 경로(사람 모드) 그대로
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = await mkdtemp(join(tmpdir(), 'argo-codex-json-'));
after(() => rm(base, { recursive: true, force: true }));
process.env.HOME = process.env.USERPROFILE = join(base, 'home'); // 모듈이 import 시점에 homedir()로 관리본 경로를 잡는다
process.env.TMPDIR = join(base, 'tmp');
process.env.ARGO_ROOT = join(base, 'root');
process.env.ARGO_MODEL_CATALOG = 'off';
delete process.env.ARGO_CODEX_PREFER_PATH;
delete process.env.ARGO_CODEX_ENGINE;
for (const d of [process.env.HOME, process.env.TMPDIR, process.env.ARGO_ROOT]) await mkdir(d, { recursive: true });
const log = join(base, 'log.json');
process.env.FAKE_CLI_LOG = log;

const { externalExec } = await import('../src/runners.mjs');
const { CODEX_PIN, codexToolDirFor } = await import('../src/runners/codex.mjs');
const T = await import('../src/turn-trace.mjs');

// 관리본(이 핀) 자리에 가짜 codex — pinned:true 경로(JSON 모드가 켜지는 유일한 경로)를 탄다
const toolDir = codexToolDirFor(process.env.HOME);
await mkdir(toolDir, { recursive: true });
await writeFile(join(toolDir, '.pin'), CODEX_PIN);
const exe = join(toolDir, 'codex');
await writeFile(exe, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('fake-codex'); process.exit(0); }
let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ argv: a }));
  const json = a.includes('--json');
  const i = a.indexOf('--output-last-message');
  const mode = process.env.FAKE_MODE || 'ok';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const vendor = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account." } });
  if (mode === 'fail') {
    if (json) { out({ type: 'thread.started', thread_id: 't' }); out({ type: 'turn.started' }); out({ type: 'error', message: vendor }); out({ type: 'turn.failed', error: { message: vendor } }); }
    else { process.stderr.write('ERROR: ' + vendor + '\\n'); }
    process.exit(1);
  }
  if (mode === 'lock') {
    const w = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable \`features.code_mode_host\`.';
    if (json) out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: w } }); else process.stderr.write('warning: ' + w + '\\n');
    if (i >= 0) fs.writeFileSync(a[i + 1], '도구가 막혔습니다');
    return;
  }
  if (json) {
    out({ type: 'thread.started', thread_id: 't' }); out({ type: 'turn.started' });
    out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '확인하겠습니다.' } });
    out({ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: "/bin/zsh -lc 'cat note.txt'", aggregated_output: '', exit_code: null, status: 'in_progress' } });
    out({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: "/bin/zsh -lc 'cat note.txt'", aggregated_output: 'hello\\nTOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\\n', exit_code: 0, status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: '내용은 hello입니다.' } });
    out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  } else {
    process.stderr.write('exec\\n/bin/zsh -lc cat note.txt\\nhello\\n');
  }
  if (i >= 0) fs.writeFileSync(a[i + 1], '내용은 hello입니다.');
});
`);
await chmod(exe, 0o755);
const cwd = join(base, 'cwd');
await mkdir(cwd, { recursive: true });
const lastArgv = async () => JSON.parse(await readFile(log, 'utf8')).argv;
const opts = { runner: 'codex', model: 'gpt-6.1-sol', effort: 'low', cwd, prompt: 'hi', timeoutMs: 60_000 };

test('① 성공 — 핀 관리본은 --json, 이벤트가 작업 과정 단계로, 최종 답은 종전처럼 파일에서', { skip: process.platform === 'win32' }, async () => {
  delete process.env.FAKE_MODE;
  const tr = T.createTrace({ wsId: 'cj', slug: 'a', source: 'routine' });
  const said = [];
  const reply = await externalExec({ ...opts, onEvent: (ev) => T.recordCodexEvent(tr, ev, { onText: (t) => said.push(t) }) });
  assert.equal(reply, '내용은 hello입니다.');
  const argv = await lastArgv();
  assert.ok(argv.includes('--json'), 'JSON 모드');
  assert.ok(argv.indexOf('--json') < argv.indexOf('--output-last-message'), '최종 답 파일은 그대로');
  const s = tr.data().steps;
  assert.deepEqual(s.map((x) => [x.name, x.status]), [['Bash', 'ok']]);
  assert.match(s[0].result, /hello/);
  assert.doesNotMatch(s[0].result, /ghp_abcdef/, '명령 출력의 비밀 모양은 가린다');
  assert.deepEqual(said, ['확인하겠습니다.', '내용은 hello입니다.']);
  tr.finish();
});

test('② 실패 — JSON 모드에서도 벤더 원인 문구 그대로(사람 모드와 같은 오류)', { skip: process.platform === 'win32' }, async () => {
  process.env.FAKE_MODE = 'fail';
  try {
    const j = await externalExec(opts).then(() => null, (e) => e);
    process.env.ARGO_CODEX_JSON = '0';
    const h = await externalExec(opts).then(() => null, (e) => e);
    delete process.env.ARGO_CODEX_JSON;
    assert.ok(j && h);
    assert.match(j.message, /The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account\./);
    assert.equal(j.message, h.message, 'JSON 모드와 사람 모드가 같은 실패 문구');
  } finally { delete process.env.FAKE_MODE; delete process.env.ARGO_CODEX_JSON; }
});

test('③ 도구 잠김 경고 — JSON 모드에서도 잠김으로 승격(자가치유가 재조달·교체)', { skip: process.platform === 'win32' }, async () => {
  process.env.FAKE_MODE = 'lock';
  try {
    const e = await externalExec(opts).then(() => null, (x) => x);
    assert.ok(e?.toolLockup, `잠김 표지: ${e?.message}`);
    assert.ok((await lastArgv()).includes('--json'));
  } finally { delete process.env.FAKE_MODE; }
});

test('④ ARGO_CODEX_JSON=0 — 옛 경로(사람 모드) 그대로, 단계 이벤트 없음', { skip: process.platform === 'win32' }, async () => {
  process.env.ARGO_CODEX_JSON = '0';
  try {
    const seen = [];
    assert.equal(await externalExec({ ...opts, onEvent: (ev) => seen.push(ev) }), '내용은 hello입니다.');
    assert.ok(!(await lastArgv()).includes('--json'));
    assert.equal(seen.length, 0);
  } finally { delete process.env.ARGO_CODEX_JSON; }
});
