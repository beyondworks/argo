// 루틴 빈 답·NO_REPORT — 실제 chat()을 지나는 러너별 판(가짜 Codex CLI, 가짜 Claude SDK 엔드포인트).
// 실사고(2026-10-07 조사): '보고할 것이 0건이면 아무 말도 하지 말라'는 루틴 지시에 GPT-6가 빈 최종 답을 냈다
// (codex exit 0, --output-last-message 파일 0바이트). Codex 경로는 "Codex 러너가 빈 응답을 반환했습니다"로 실패했고
// 대화 기록엔 아무것도 없었다. SDK 경로는 빈 result를 성공으로 기록하고 제목만 있는 알림을 보냈다.
// 잠그는 행동: 루틴 턴에는 NO_REPORT 규칙이 러너 프롬프트까지 가고, NO_REPORT는 알림 없는 성공, 빈 답은 알아듣는 문구의 실패.
// 루틴이 아닌 대화 턴의 빈 답 처리는 그대로다(인접 핀).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const base = await mkdtemp(join(tmpdir(), 'argo-rtn-runners-'));
const home = join(base, 'home');
Object.assign(process.env, { ARGO_ROOT: join(base, 'root'), HOME: home, USERPROFILE: home, TMPDIR: join(base, 'tmp'),
  ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ARGO_CODEX_ENGINE']) delete process.env[key];
for (const d of [process.env.ARGO_ROOT, home, process.env.TMPDIR]) await mkdir(d, { recursive: true });

// 가짜 Claude Messages 엔드포인트 — 요청 본문의 표지로 답을 고른다. 본문에 NO_REPORT 규칙이 실렸는지도 적어 둔다.
const sdkSeen = [];
const sse = (res, text) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const evs = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ...(text ? [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]] : []),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]];
  for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  res.end();
};
// 표지는 **가장 뒤에 나온 것**으로 고른다 — 프롬프트 앞부분의 대화 맥락에 지난 루틴의 표지가 실려 온다.
const MODES = { 'MODE-EMPTY': '', 'MODE-NOREPORT': 'NO_REPORT', 'MODE-REPORT': '보고: 새 메일 2건' };
const lastMode = (body) => Object.keys(MODES).reduce((best, k) => (body.lastIndexOf(k) > (best ? body.lastIndexOf(best) : -1) ? k : best), null);
const pick = (body) => MODES[lastMode(body) ?? 'MODE-REPORT'];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) { sdkSeen.push(b); return sse(res, pick(b)); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

// 가짜 codex — stdin 프롬프트의 표지로 --output-last-message 파일을 쓴다. MODE-EMPTY = 실사고 모양(exit 0, 0바이트).
const bin = join(base, 'bin');
const seenLog = join(base, 'codex-prompts.log');
await mkdir(bin, { recursive: true });
await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('fake-codex'); process.exit(0); }
let input = ''; process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(seenLog)}, JSON.stringify(input) + '\\n');
  const out = a[a.indexOf('--output-last-message') + 1];
  const modes = { 'MODE-EMPTY': '', 'MODE-NOREPORT': 'NO_REPORT\\n', 'MODE-REPORT': '보고: 새 메일 2건' };
  const last = Object.keys(modes).sort((x, y) => input.lastIndexOf(y) - input.lastIndexOf(x))[0];
  fs.writeFileSync(out, input.lastIndexOf(last) >= 0 ? modes[last] : modes['MODE-REPORT']);
});
`);
await chmod(join(bin, 'codex'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1';

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { addRoutine, runRoutine, loadRoutines } = await import('../src/routines.mjs');
const { loadThread } = await import('../src/thread.mjs');
const { onNotify } = await import('../src/notify.mjs');
const { readEvents } = await import('../src/events.mjs');
const { rerunMode, rerunMessage } = await import('../app/c/[ws]/activity/rerun.mjs');

const WS = 'rtn-runners';
await createCompany(WS, '러너별 루틴 검수', 'owner', null, 'ko');
await mkdir(paths(WS).agents, { recursive: true });
await writeFile(join(paths(WS).agents, 'cx.md'), '---\nname: 코덱스\nrole: 검증\nrunner: codex\n---\n검증용.\n');
await writeFile(join(paths(WS).agents, 'sd.md'), '---\nname: 클로드\nrole: 검증\nrunner: claude\n---\n검증용.\n');
// codex host 표지 — saveRunnerCred는 codex CLI 조달을 띄우므로 저장 파일을 직접 쓴다(runner-limits 테스트와 같은 모양). claude는 형식만 맞춘 가짜 키(요청은 로컬 가짜로만).
// host 표지는 이 컴퓨터의 codex 로그인(~/.codex/auth.json — 임시 HOME)이 있어야 유효하다(runnerStatus) — 없으면 claude로 대체 실행돼 codex 경로를 못 탄다.
await mkdir(join(home, '.codex'), { recursive: true });
await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a.b.c', refresh_token: 'r', account_id: 'acct-test' } }));
await writeFile(join(paths(WS).root, '.secrets.json'), JSON.stringify({ runners: { codex: { type: 'host', value: 'host' } } }));
await saveRunnerCred(WS, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`);

const events = [];
onNotify((e) => { if (e.wsId === WS) events.push(e); });
const settle = () => new Promise((r) => setTimeout(r, 30));
const byId = async (id) => (await loadRoutines(WS)).find((r) => r.id === id);
let n = 0;
const mk = (slug, mode) => addRoutine(WS, { agentSlug: slug, title: `${mode} ${++n}`, prompt: `${mode} 새 메일을 확인하고 보고할 것이 0건이면 아무 말도 하지 말고 끝내라`, schedule: { type: 'daily', time: '09:00' } });
const routineEvents = (id) => events.filter((e) => e.type === 'routine' && e.routine?.id === id);

for (const [slug, label] of [['cx', 'Codex CLI'], ['sd', 'Claude SDK']]) {
  test(`${label}: NO_REPORT 규칙이 러너 프롬프트까지 가고, NO_REPORT 답은 알림 없는 성공이다`, async () => {
    const r = await mk(slug, 'MODE-NOREPORT');
    const out = await runRoutine(WS, r.id, { chatFn: chat });
    await settle();
    assert.equal(out.ok, true);
    const seen = slug === 'cx' ? (await readFile(seenLog, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : sdkSeen;
    assert.ok(seen.some((p) => p.includes('MODE-NOREPORT') && p.includes('NO_REPORT 한 줄')), '루틴 턴 프롬프트에 보고 규칙이 실려야 한다');
    const saved = await byId(r.id);
    assert.equal(saved.lastOk, true); assert.equal(saved.lastResult, '보고할 내용 없음');
    assert.equal(routineEvents(r.id).length, 0, '보고할 것이 없으면 알림·메신저 글을 보내지 않는다');
    // 활동 '다시 실행'은 대화 턴이다 — 턴 이벤트 원문(msg)에 실린 보고 규칙을 떼고 보낸다(대화 턴의 답 처리는 루틴 규칙과 무관)
    const ev = (await readEvents(WS)).find((e) => e.type === 'turn' && e.source === 'routine' && e.slug === slug && String(e.gist ?? '').includes(r.title));
    assert.ok(ev, '루틴 턴 이벤트가 기록됐다');
    if (slug === 'cx') {
      // CLI 경로의 턴 이벤트는 원문(msg)을 싣지 않는다(종전) — 다시 실행 버튼 자체가 없어 규칙이 대화 턴으로 새지 않는다
      assert.equal(ev.msg, undefined); assert.equal(rerunMode(ev), 'none');
    } else {
      assert.match(ev.msg, /\[보고 규칙\]/, '전제: 이벤트 원문에는 러너에게 보낸 그대로 규칙이 실려 있다');
      assert.equal(rerunMode(ev), 'rerun', '전제: 사장이 만든 루틴 턴은 다시 실행 버튼이 보인다');
      assert.equal(rerunMessage(ev), `[루틴: ${r.title}] ${r.prompt}`, '다시 실행은 규칙을 뗀 지시만 보낸다');
    }
  });

  test(`${label}: 빈 최종 답은 실패 — 알아듣는 문구로 기록·알림하고 대화 기록에 남는다`, async () => {
    const r = await mk(slug, 'MODE-EMPTY');
    await assert.rejects(runRoutine(WS, r.id, { chatFn: chat }), /에이전트가 아무 답도 내지 않았습니다/);
    await settle();
    const saved = await byId(r.id);
    assert.equal(saved.lastOk, false); assert.match(saved.lastResult, /아무 답도 내지 않았습니다/);
    const ev = routineEvents(r.id);
    assert.equal(ev.length, 1); assert.equal(ev[0].ok, false);
    assert.match(ev[0].reply, /아무 답도 내지 않았습니다/, '제목만 있는 알림이 아니라 사유가 본문에 있다');
    const msgs = (await loadThread(WS, slug)).messages;
    const i = msgs.findIndex((m) => m.via === 'routine' && m.text === `[루틴: ${r.title}] ${r.prompt}`);
    assert.ok(i >= 0, '실패한 루틴도 지시가 대화 기록에 남는다');
    assert.match(msgs[i + 1]?.text ?? '', /루틴 실행에 실패했습니다.*아무 답도 내지 않았습니다/s);
  });

  test(`${label}: 보고가 있으면 종전대로 성공·결과 알림 1건(인접 핀)`, async () => {
    const r = await mk(slug, 'MODE-REPORT');
    const out = await runRoutine(WS, r.id, { chatFn: chat });
    await settle();
    assert.equal(out.ok, true);
    assert.match(out.reply, /보고: 새 메일 2건/);
    const ev = routineEvents(r.id);
    assert.equal(ev.length, 1); assert.equal(ev[0].ok, true); assert.match(ev[0].reply, /새 메일 2건/);
  });
}

test('C8 핀: 루틴이 아닌 대화 턴의 Codex 빈 응답은 종전 문구 그대로 실패한다', async () => {
  await assert.rejects(chat(WS, 'cx', 'MODE-EMPTY 안녕', null, {}), /Codex 러너가 빈 응답을 반환했습니다/);
});

test('C8 핀: 루틴이 아닌 대화 턴(SDK)의 빈 답 처리는 바꾸지 않는다 — 실패로 던지지 않는다', async () => {
  const t = await chat(WS, 'sd', 'MODE-EMPTY 안녕', null, {});
  assert.equal(String(t.reply ?? '').trim(), '');
});
