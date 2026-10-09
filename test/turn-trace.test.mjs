// 작업 과정 보이기(유건 요청 2026-10-09) — 턴별 기록기(src/turn-trace.mjs)·러너별 매핑·codex JSONL 읽기·가림·보존·폴링 크기의 단위 계약.
// 화면 계약: 진행 중엔 단계가 차례로 쌓이고(생각·도구·작업), 결과는 앞 20줄 + 'N줄 더 보기', 끝난 뒤엔 이 기기에만 남는다(200KB·100턴·30일).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, utimes, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-turn-trace-'));
process.env.ARGO_ENC_VAULT = '0'; // 암호화 키 없는 환경의 '이번 사이클 불가시'와 구분 — 순수하게 경로 규칙만 본다
const T = await import('../src/turn-trace.mjs');
const { paths } = await import('../src/workspace.mjs');
const { EXCLUDE, isTurnTraceRel } = await import('../src/sync.mjs');
const { createCodexJsonReader, humanizeCodexJsonError } = await import('../src/runners/codex-json.mjs');
const { CODEX_LOCKUP_RE } = await import('../src/runners/codex.mjs');
const { apiError } = await import('../src/runners/exec.mjs');
const { displayContent } = await import('../src/engine/native-query.mjs');
const { fromResponsesResponse } = await import('../src/engine/responses-wire.mjs');

const traceDir = (ws, slug) => join(paths(ws).root, T.TRACE_DIR, slug);

test('가림 — ghp_·AKIA·Bearer·xox·KEY=VALUE·URL 비밀번호·PEM·JSON 비밀 키는 가리고, 평범한 키·값은 그대로', () => {
  const cases = [
    ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', /ghp_/],
    ['aws id AKIAABCDEFGHIJKLMNOP here', /AKIAABCDEFGHIJKLMNOP/],
    ['curl -H "Authorization: Bearer abcdefghijklmnop123"', /abcdefghijklmnop123/],
    ['slack xoxb-1234567890-abcdefghij', /xoxb-1234567890/],
    ['OPENAI_API_KEY=plain-value-123', /plain-value-123/],
    ['SUPABASE_SERVICE_ROLE_KEY: zzz-role-secret', /zzz-role-secret/],
    ['export DB_PASSWORD="hunter2"', /hunter2/],
    ['postgresql://app:p4ssw0rd@db.example.com:5432/x', /p4ssw0rd/],
    ['{"apiKey": "abc123", "client_secret": "def456"}', /abc123|def456/],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nzzzz\n-----END RSA PRIVATE KEY-----', /MIIEpAIBAAKCAQEA/],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', /github_pat_11ABC/],
    ['token sk-ant-oat01-AbCdEf bad', /AbCdEf/],
  ];
  for (const [raw, leak] of cases) assert.doesNotMatch(T.maskSecrets(raw), leak, raw);
  for (const keep of ['monkey: banana', '{"keyboard": "qwerty", "primaryKey": "id"}', 'ls -la vault/notes', 'exit_code: 0', 'Note: done']) {
    assert.equal(T.maskSecrets(keep), keep, `과하게 가리지 않는다: ${keep}`);
  }
  assert.match(T.maskSecrets('OPENAI_API_KEY=plain-value-123'), /^OPENAI_API_KEY=\*\*\*$/, '이름은 남기고 값만 가린다');
});

test('결과 20줄 — 300줄은 앞 20줄 + 280줄 더', () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');
  const p = T.previewLines(text);
  assert.equal(p.lines, 300); assert.equal(p.more, 280);
  assert.equal(p.text.split('\n').length, 20); assert.match(p.text, /^line 1\n/); assert.match(p.text, /line 20$/);
  const tr = T.createTrace({ wsId: 'p20', slug: 'a', source: 'routine' });
  tr.toolStart({ id: 'x', name: 'Bash', input: { command: 'seq 300' } });
  tr.toolEnd('x', { result: text });
  const v = tr.view(0).steps[0];
  assert.equal(v.lines, 300, '전체 줄 수'); assert.equal(v.result.split('\n').length, 20, '폴링 보기는 앞 20줄만');
  assert.equal(tr.data().steps[0].result.split('\n').length, 300, '저장본은 전체(예산 안) — 더 보기는 저장본으로');
  tr.toolStart({ id: 'nl', name: 'Bash', input: { command: 'seq 1 300' } });
  tr.toolEnd('nl', { result: `${text}\n` });
  assert.equal(tr.view(0).steps[1].lines, 300, '명령 출력 끝 줄바꿈은 줄 수에 넣지 않는다(301줄 아님)');
  tr.finish();
});

test('40개 상한 — 도구 45개가 전부 쌓이고, 옛 소비자용 요약은 마지막 40개(45번째가 마지막)', () => {
  const tr = T.createTrace({ wsId: 'w40', slug: 'a', source: 'routine' });
  for (let i = 1; i <= 45; i++) { tr.toolStart({ id: `t${i}`, name: 'Read', input: { file_path: `vault/n${i}.md` } }); tr.toolEnd(`t${i}`, { result: `r${i}` }); }
  assert.equal(tr.size, 45); assert.equal(tr.toolCount, 45);
  const c = tr.compact(40);
  assert.equal(c.length, 40);
  assert.equal(c.at(-1).detail, 'n45.md', '마지막 단계까지 실린다(옛 step()은 40번째에서 멈췄다)');
  assert.equal(c[0].detail, 'n6.md');
  tr.finish();
});

test('같은 크루의 두 턴 — 기록이 따로 쌓이고 섞이지 않으며, 화면이 보던 기록을 계속 고른다', () => {
  const a = T.createTrace({ wsId: 'mix', slug: 'k', source: 'chat' });
  const b = T.createTrace({ wsId: 'mix', slug: 'k', source: 'routine' });
  a.toolStart({ id: '1', name: 'Bash', input: { command: 'echo A' } });
  b.toolStart({ id: '1', name: 'Bash', input: { command: 'echo B' } }); // 같은 도구 id여도 다른 턴
  b.toolEnd('1', { result: 'B-out' });
  a.toolEnd('1', { result: 'A-out' });
  assert.deepEqual(a.data().steps.map((s) => [s.input, s.result]), [['$ echo A', 'A-out']]);
  assert.deepEqual(b.data().steps.map((s) => [s.input, s.result]), [['$ echo B', 'B-out']]);
  assert.equal(T.liveTraces('mix', 'k').length, 2);
  assert.equal(T.pickLiveTrace('mix', 'k', { want: a.id, pointer: b.id }).id, a.id, '보던 기록(want)이 살아 있으면 그대로');
  assert.equal(T.pickLiveTrace('mix', 'k', { pointer: b.id }).id, b.id, '없으면 상태 파일 포인터');
  a.finish(); assert.equal(T.pickLiveTrace('mix', 'k', { want: a.id }).id, b.id, '끝난 기록은 등록부에서 빠진다');
  b.finish(); assert.equal(T.pickLiveTrace('mix', 'k'), null);
});

test('폴링 크기 — 한 번에 32KB 이하, 못 실은 단계는 다음 폴(rev)이 이어 받는다', () => {
  const tr = T.createTrace({ wsId: 'poll', slug: 'a', source: 'routine' });
  const big = Array.from({ length: 20 }, () => 'x'.repeat(70)).join('\n');
  for (let i = 0; i < 60; i++) { tr.toolStart({ id: `t${i}`, name: 'Bash', input: { command: `cmd ${i} ${'y'.repeat(400)}` } }); tr.toolEnd(`t${i}`, { result: big }); }
  let rev = 0; let got = 0; let rounds = 0;
  for (;;) {
    const v = tr.view(rev);
    assert.ok(Buffer.byteLength(JSON.stringify(v.steps)) <= T.POLL_BUDGET_BYTES, `폴 ${rounds} 크기 ${Buffer.byteLength(JSON.stringify(v.steps))}`);
    got += v.steps.length; rev = v.rev; rounds += 1;
    if (!v.more) break;
  }
  assert.equal(got, 60, '모든 단계가 결국 실린다'); assert.ok(rounds > 1, '여러 폴에 나뉜다');
  assert.equal(tr.view(rev).steps.length, 0, '바뀐 것이 없으면 빈 목록(늘어난 부분만)');
  tr.toolStart({ id: 't0', name: 'Bash' }); // 같은 id 재시작 — 입력 그대로, 수정 번호만
  tr.toolEnd('t0', { result: 'again' });
  assert.deepEqual(tr.view(rev).steps.map((s) => s.i), [0], '수정된 단계만 다시 실린다');
  tr.finish();
});

test('200KB 상한 — 저장본은 204,800바이트 이하, 단계 제목·상태는 남는다', () => {
  const steps = Array.from({ length: 300 }, (_, i) => ({ i, id: `t${i}`, kind: 'tool', name: 'Bash', input: `$ cmd ${i} ${'a'.repeat(900)}`, result: Array.from({ length: 200 }, () => 'b'.repeat(40)).join('\n'), lines: 200, cut: false, status: 'ok', t: i, ms: 1, parent: null }));
  const data = { v: 1, id: 'trabcdef0123abcd', steps, n: 300 };
  const out = T.shrinkTrace(data);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= T.TRACE_CAP_BYTES, `크기 ${Buffer.byteLength(JSON.stringify(out))}`);
  assert.equal(out.capped, true);
  assert.ok(out.steps.length >= 2 && out.steps.every((s) => s.name === 'Bash' && s.status === 'ok'), '제목·상태 유지');
  assert.equal(data.steps[0].result.split('\n').length, 200, '원본은 바꾸지 않는다');
});

test('저장·보존 — 1:1·회의실만 저장, 에이전트별 최근 100턴 그리고 30일, 다른 파일은 건드리지 않는다', async () => {
  const ws = 'keep'; const slug = 'ann';
  await mkdir(paths(ws).root, { recursive: true });
  const routine = T.createTrace({ wsId: ws, slug, source: 'routine' });
  assert.equal(routine.persist, false); await routine.finish();
  assert.equal(existsSync(join(traceDir(ws, slug), `${routine.id}.json`)), false, '루틴 턴은 진행 중 보기만');
  const ids = [];
  let clock = Date.now() - 50 * 86_400_000;
  for (let i = 0; i < 105; i++) {
    clock += 3600_000; const now = () => clock;
    const tr = T.createTrace({ wsId: ws, slug, source: i % 2 ? 'chat' : 'room', now });
    tr.toolStart({ id: 'a', name: 'Read', input: { file_path: 'x' } }); tr.toolEnd('a', { result: 'ok' });
    await tr.finish(); ids.push(tr.id);
    assert.equal(tr.persist, true);
  }
  await writeFile(join(traceDir(ws, slug), 'notes.txt'), 'keep me');
  // 마지막 저장 1건 — 시계를 지금으로(30일 넘은 것은 지워진다)
  const last = T.createTrace({ wsId: ws, slug, source: 'chat' }); last.think('지금'); await last.finish(); ids.push(last.id);
  const files = (await readdir(traceDir(ws, slug))).filter((n) => T.TRACE_ID_RE.test(n.replace(/\.json$/, '')));
  assert.ok(files.length <= T.TRACE_KEEP_TURNS, `100턴 이하: ${files.length}`);
  const idx = JSON.parse(await readFile(join(traceDir(ws, slug), 'index.json'), 'utf8'));
  for (const id of Object.keys(idx.items)) {
    assert.ok(Date.now() - idx.items[id].at <= T.TRACE_KEEP_DAYS * 86_400_000 + 1000, '30일 안');
    assert.ok(files.includes(`${id}.json`), 'index와 파일이 맞다');
  }
  assert.ok(idx.items[last.id], '방금 저장한 것은 남는다');
  assert.equal(idx.items[ids[0]], undefined, '50일 전 것은 지워진다');
  assert.equal(await readFile(join(traceDir(ws, slug), 'notes.txt'), 'utf8'), 'keep me', '모르는 파일은 지우지 않는다');
  const sum = await T.traceSummaries(ws, slug, [last.id, 'trzzzzzz00000000', 'not-an-id']);
  assert.deepEqual(Object.keys(sum), [last.id], '이 기기에 없는 기록 id는 빠진다(다른 기기 = 답만)');
  assert.equal((await T.readTrace(ws, slug, last.id)).id, last.id);
  assert.equal(await T.readTrace(ws, slug, '../../company'), null, '경로 모양 id는 거절');
});

test('중단 — 돌던 단계는 stop, 실패면 err로 닫히고 기록은 ok:false로 남는다', async () => {
  const ws = 'stop'; await mkdir(paths(ws).root, { recursive: true });
  const tr = T.createTrace({ wsId: ws, slug: 'b', source: 'chat' });
  tr.toolStart({ id: 'r', name: 'Bash', input: { command: 'sleep 99' } });
  const saved = await tr.finish({ ok: false, aborted: true });
  assert.equal(saved.ok, false); assert.equal(saved.aborted, true);
  assert.equal(saved.steps[0].status, 'stop');
  assert.equal(await tr.finish(), saved, '두 번 불러도 한 번');
  assert.equal(tr.toolStart({ id: 'late', name: 'Bash' }), null, '끝난 뒤엔 쌓지 않는다');
});

test('동기화 제외 — .turn-traces는 올리지 않고 diff에서도 보이지 않는다', () => {
  assert.equal(EXCLUDE('.turn-traces/ann/trabc.json'), true);
  assert.equal(EXCLUDE('.turn-traces/ann/index.json'), true);
  assert.equal(isTurnTraceRel('.turn-traces/x/y.json'), true);
  assert.equal(isTurnTraceRel('vault/.turn-traces/y.json'), false, '최상위만');
  assert.equal(EXCLUDE('chats/ann.json'), false, '대화(답·traceId)는 그대로 동기화');
});

test('SDK 모양 매핑 — 생각·도구 입력 전부·결과 짝·하위 에이전트(parent)·API 오류 합성 메시지 무시', () => {
  const tr = T.createTrace({ wsId: 'sdk', slug: 'a', source: 'routine' });
  T.recordSdkMessage(tr, { type: 'assistant', message: { model: 'claude-x', content: [
    { type: 'thinking', thinking: '파일을 먼저 본다' },
    { type: 'text', text: '보겠습니다' },
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la vault', description: '목록' } },
    { type: 'tool_use', id: 'tu2', name: 'Task', input: { description: '조사', prompt: '찾아줘' } },
  ] } });
  T.recordSdkMessage(tr, { type: 'assistant', parent_tool_use_id: 'tu2', message: { content: [{ type: 'tool_use', id: 'sub1', name: 'Grep', input: { pattern: 'TODO' } }] } });
  T.recordSdkMessage(tr, { type: 'user', parent_tool_use_id: 'tu2', message: { content: [{ type: 'tool_result', tool_use_id: 'sub1', content: [{ type: 'text', text: 'a.md:1:TODO' }] }] } });
  T.recordSdkMessage(tr, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'total 0', is_error: false }, { type: 'tool_result', tool_use_id: 'tu2', content: 'done', is_error: true }] } });
  T.recordSdkMessage(tr, { type: 'assistant', error: 'overloaded', message: { content: [{ type: 'tool_use', id: 'ghost', name: 'Bash', input: {} }] } });
  const s = tr.data().steps;
  assert.deepEqual(s.map((x) => [x.kind, x.name, x.status]), [['think', '', 'ok'], ['tool', 'Bash', 'ok'], ['task', 'Task', 'err'], ['tool', 'Grep', 'ok']]);
  assert.equal(s[0].result, '파일을 먼저 본다');
  assert.equal(s[1].input, '$ ls -la vault', '명령 그대로');
  assert.equal(s[1].result, 'total 0');
  assert.equal(s[3].parent, 'tu2'); assert.equal(s[3].result, 'a.md:1:TODO');
  assert.equal(tr.data().model, 'claude-x');
  tr.finish();
});

// 핀 0.159.3 실측(2026-10-09, 이 PR 작성 중 실제 실행) — `codex exec --json`의 출력 그대로(경로만 줄임)
const REAL_JSONL = [
  '{"type":"thread.started","thread_id":"01a11eeb-ee93-79e3-8aed-079311e25581"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"요청한 두 명령을 순서대로 실행해 확인하겠습니다."}}',
  '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \'ls -la\\ncat note.txt\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \'ls -la\\ncat note.txt\'","aggregated_output":"total 24\\n-rw-r--r--@ 1 u  wheel    6 Oct  9 13:28 note.txt\\nhello\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"note.txt 내용은 hello입니다."}}',
  '{"type":"turn.completed","usage":{"input_tokens":86828,"cached_input_tokens":49792,"output_tokens":329,"reasoning_output_tokens":157}}',
];
// 실측: 없는 모델(-m no-such-model-xyz) — 사람 모드는 stderr `warning: …`·`ERROR: {…}`, JSON 모드는 stdout 이벤트로 옮겨 간다
const REAL_FAIL_JSONL = [
  '{"type":"thread.started","thread_id":"t"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"error","message":"Model metadata for `no-such-model-xyz` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'no-such-model-xyz\' model is not supported when using Codex with a ChatGPT account.\\"}}"}',
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'no-such-model-xyz\' model is not supported when using Codex with a ChatGPT account.\\"}}"}}',
];

test('codex exec JSONL(실측) — 명령 단계(입력·결과·종료 코드), 크루가 이미 말한 글은 partial로', () => {
  const tr = T.createTrace({ wsId: 'cx', slug: 'a', source: 'routine' });
  const said = [];
  const r = createCodexJsonReader({ onEvent: (ev) => T.recordCodexEvent(tr, ev, { onText: (t) => said.push(t) }) });
  const all = `${REAL_JSONL.join('\n')}\n`;
  for (let i = 0; i < all.length; i += 37) r.push(all.slice(i, i + 37)); // 줄이 조각으로 나뉘어 와도
  r.end();
  const s = tr.data().steps;
  assert.equal(s.length, 1);
  assert.equal(s[0].name, 'Bash'); assert.equal(s[0].status, 'ok');
  assert.match(s[0].input, /^\$ \/bin\/zsh -lc 'ls -la\ncat note.txt'/);
  assert.match(s[0].result, /hello/);
  assert.deepEqual(said, ['요청한 두 명령을 순서대로 실행해 확인하겠습니다.', 'note.txt 내용은 hello입니다.']);
  assert.equal(r.stderr(''), '', '경고·오류가 없으면 되살릴 줄도 없다');
  tr.finish();
});

test('codex JSONL 항목 모양 — 파일 변경·MCP·웹 검색·추론 요약·할 일·실패 명령, app-server(camelCase)도 같은 이름', () => {
  const tr = T.createTrace({ wsId: 'cx2', slug: 'a', source: 'routine' });
  const ev = (type, item) => T.recordCodexEvent(tr, { type, item });
  ev('item.completed', { id: 'r1', type: 'reasoning', text: '먼저 구조를 본다' });
  ev('item.completed', { id: 'f1', type: 'file_change', changes: [{ path: '/w/a.md', kind: 'add' }, { path: '/w/b.md', kind: 'update' }], status: 'completed' });
  ev('item.started', { id: 'm1', type: 'mcp_tool_call', server: 'notion', tool: 'search', arguments: { query: 'x' }, status: 'in_progress' });
  ev('item.completed', { id: 'm1', type: 'mcp_tool_call', server: 'notion', tool: 'search', arguments: { query: 'x' }, result: { content: [{ type: 'text', text: '3건' }] }, status: 'completed' });
  ev('item.completed', { id: 'w1', type: 'web_search', query: 'argo' });
  ev('item.completed', { id: 'td', type: 'todo_list', items: [{ text: '읽기', completed: true }, { text: '쓰기', completed: false }] });
  ev('item.completed', { id: 'c9', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' });
  // app-server 알림 모양
  T.recordCodexEvent(tr, { method: 'item/completed', params: { item: { id: 'a1', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/w\n', exitCode: 0, status: 'completed', durationMs: 12 } } });
  T.recordCodexEvent(tr, { method: 'item/completed', params: { item: { id: 'a2', type: 'reasoning', summary: ['요약 한 줄'], content: [] } } });
  T.recordCodexEvent(tr, { method: 'item/completed', params: { item: { id: 'a3', type: 'mcpToolCall', server: 'crew', tool: 'delegate', arguments: { to: 'b' }, result: null, error: { message: 'denied' }, status: 'failed' } } });
  const s = tr.data().steps;
  assert.deepEqual(s.map((x) => [x.kind, x.name, x.status]), [
    ['think', '', 'ok'], ['tool', 'Edit', 'ok'], ['tool', 'mcp__notion__search', 'ok'], ['tool', 'WebSearch', 'ok'], ['task', 'TodoWrite', 'ok'],
    ['tool', 'Bash', 'err'], ['tool', 'Bash', 'ok'], ['think', '', 'ok'], ['tool', 'mcp__crew__delegate', 'err'],
  ]);
  assert.match(s[1].input, /\/w\/a\.md, \/w\/b\.md/); assert.match(s[2].input, /query: x/); assert.equal(s[2].result, '3건');
  assert.equal(s[6].ms, 12, 'app-server 소요 시간'); assert.equal(s[7].result, '요약 한 줄'); assert.equal(s[8].result, 'denied');
  tr.finish();
});

test('codex JSON 모드 stderr 되살리기(실측) — 실패 원인은 사람 모드와 같은 문구로, 잠김 경고는 같은 정규식으로 잡힌다', () => {
  const r = createCodexJsonReader();
  for (const l of REAL_FAIL_JSONL) r.push(`${l}\n`);
  const e = Object.assign(new Error('Command failed'), { code: 1, stdout: REAL_FAIL_JSONL.join('\n'), stderr: '2026-10-09T04:29:03Z ERROR rmcp::transport::worker: quit\n' });
  humanizeCodexJsonError(e, r);
  assert.equal(e.stdout, '', 'JSONL은 판정에 넘기지 않는다(사람 모드 실패 때 stdout은 비어 있었다)');
  assert.match(e.stderr, /^warning: Model metadata for `no-such-model-xyz` not found/m);
  assert.match(e.stderr, /^ERROR: \{"type":"error","status":400/m);
  assert.match(apiError(e, 'codex').message, /The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account\./, '벤더 원인 문구가 그대로 나온다(자가치유·업데이트 안내가 같은 글을 본다)');
  const lock = createCodexJsonReader();
  lock.push('{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host`."}}\n');
  lock.end();
  assert.ok(CODEX_LOCKUP_RE.test(lock.stderr('')), '잠김 경고가 stderr 글로 되살아나 기존 정규식에 걸린다');
  const quoted = createCodexJsonReader();
  quoted.push('{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"warning: Code Mode is unavailable because code-mode host is disabled"}}\n');
  quoted.end();
  assert.ok(!CODEX_LOCKUP_RE.test(quoted.stderr('')), '크루가 인용한 글은 경고가 아니다(오탐 없음)');
});

test('codex JSONL 한 줄 상한 — 거대한 줄은 건너뛰고 다음 줄은 정상으로 읽는다', () => {
  const seen = [];
  const r = createCodexJsonReader({ onEvent: (ev) => seen.push(ev.type) });
  r.push('{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"');
  r.push('z'.repeat(8_100_000));
  r.push('"}}\n{"type":"turn.completed"}\n');
  r.end();
  assert.deepEqual(seen, ['turn.completed']);
});

test('네이티브 표시 사본 — Gemini 사고 글·Responses 요약은 thinking 블록으로 앞에, 원본(전사)은 그대로', () => {
  const content = [{ type: 'gem_thought', text: '생각 A', _gemSig: 's' }, { type: 'text', text: '답' }];
  const shown = displayContent(content, ['요약 B']);
  assert.deepEqual(shown.slice(0, 2), [{ type: 'thinking', thinking: '생각 A' }, { type: 'thinking', thinking: '요약 B' }]);
  assert.equal(content.length, 2, '원본 배열은 바꾸지 않는다');
  assert.equal(displayContent(content).length, 3, '사고 1개 + 원본 2개');
  const plain = [{ type: 'text', text: 'x' }];
  assert.equal(displayContent(plain), plain, '사고가 없으면 같은 배열');
  const r = fromResponsesResponse({ output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '먼저 읽는다' }] }, { type: 'message', content: [{ type: 'output_text', text: '끝' }] }] }, 'm');
  assert.deepEqual(r.thoughts, ['먼저 읽는다']);
  assert.deepEqual(r.content, [{ type: 'text', text: '끝' }], '요약은 내용 블록에 싣지 않는다(다음 요청에 안 보낸다)');
  assert.equal(fromResponsesResponse({ output: [{ type: 'reasoning', summary: [] }] }, 'm').thoughts, undefined, '요약이 없으면 필드도 없다');
});

test('텍스트 모드 러너 — 실행 한 단계(task)가 시작·끝으로 남는다', () => {
  const tr = T.createTrace({ wsId: 'gm', slug: 'a', source: 'routine' });
  const end = tr.task('Gemini');
  assert.equal(tr.view(0).steps[0].status, 'run');
  end(true);
  const s = tr.data().steps;
  assert.deepEqual(s.map((x) => [x.kind, x.name, x.status]), [['task', 'Gemini', 'ok']]);
  tr.finish();
});

test('화면 합치기 — 폴 조각을 번호로 합치고, 다른 기록이면 처음부터, 같은 내용이면 같은 참조', async () => {
  const { mergeTraceDelta, traceQuery, fmtTraceDur, stepTitle, nestSteps } = await import('../app/lib/trace-view.mjs');
  const a1 = mergeTraceDelta(null, { id: 'trA', rev: 2, n: 2, steps: [{ i: 0, status: 'ok' }, { i: 1, status: 'run' }] });
  assert.deepEqual(a1.steps.map((s) => [s.i, s.status]), [[0, 'ok'], [1, 'run']]);
  assert.equal(traceQuery(a1), '&tr=trA&rev=2');
  const a2 = mergeTraceDelta(a1, { id: 'trA', rev: 4, n: 3, steps: [{ i: 1, status: 'ok' }, { i: 2, status: 'run' }] });
  assert.deepEqual(a2.steps.map((s) => [s.i, s.status]), [[0, 'ok'], [1, 'ok'], [2, 'run']], '바뀐 단계는 갈아 끼우고 새 단계는 뒤에');
  assert.equal(mergeTraceDelta(a2, { id: 'trA', rev: 4, n: 3, steps: [] }), a2, '바뀐 것 없으면 같은 참조(다시 그리지 않음)');
  const b = mergeTraceDelta(a2, { id: 'trB', rev: 1, n: 1, steps: [{ i: 0, status: 'run' }] });
  assert.deepEqual(b.steps.map((s) => s.i), [0], '다른 기록이면 앞 목록을 버린다(두 턴이 섞이지 않게)');
  assert.equal(traceQuery(null), '');
  const t = (k, p) => `${k}:${JSON.stringify(p)}`;
  assert.equal(fmtTraceDur(t, 64_000), 'trace.dur.m:{"m":1,"s":4}', '1분 4초');
  assert.equal(fmtTraceDur(t, 1234), 'trace.dur.s:{"s":1.2}');
  assert.equal(fmtTraceDur(t, 42_400), 'trace.dur.s:{"s":42}');
  assert.deepEqual(stepTitle({ name: 'mcp__notion__search', input: '\nquery: x\nmore' }), { label: 'notion · search', detail: 'query: x' });
  const nested = nestSteps([{ i: 0, id: 'task', name: 'Task' }, { i: 1, id: 'x', name: 'Bash' }, { i: 2, id: 's1', parent: 'task', name: 'Grep' }, { i: 3, id: 'o', parent: 'gone', name: 'Read' }]);
  assert.deepEqual(nested.map((r) => [r.step.i, r.depth]), [[0, 0], [2, 1], [1, 0], [3, 0]], '하위 에이전트 단계는 부모 아래로, 부모가 없으면 제자리');
});

test('i18n — 작업 과정 문구가 ko·en 모두 있다', async () => {
  const src = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const k of ['trace.summary', 'trace.dur.s', 'trace.dur.m', 'trace.think', 'trace.runnerTask', 'trace.input', 'trace.result', 'trace.lines', 'trace.more', 'trace.fullInput', 'trace.noResult', 'trace.failed', 'trace.stopped', 'trace.loading', 'trace.loadFail', 'trace.earlier', 'trace.dropped', 'trace.cutStored', 'trace.capped', 'activity.stepsOmitted']) {
    const m = src.match(new RegExp(`'${k.replace(/\./g, '\\.')}': \\['([^']+)', (?:'([^']*)'|"([^"]*)")\\]`));
    assert.ok(m, `${k} 없음`);
    const en = m[2] ?? m[3];
    assert.ok(/[가-힣]/.test(m[1]) && en && !/[가-힣]/.test(en), `${k}: ko는 한글, en은 영어`);
    assert.doesNotMatch(m[1], /크루|사장/, `${k}: 용어(에이전트·사용자)`);
  }
});

test('단계 0개 턴은 남기지 않는다 — 모델 호출 전 실패에 빈 기록이 쌓이지 않게', async () => {
  const ws = 'empty'; await mkdir(paths(ws).root, { recursive: true });
  const tr = T.createTrace({ wsId: ws, slug: 'z', source: 'chat' });
  assert.equal(tr.kept, false);
  assert.equal(await tr.finish({ ok: false }), null);
  assert.equal(existsSync(join(traceDir(ws, 'z'), `${tr.id}.json`)), false);
});
