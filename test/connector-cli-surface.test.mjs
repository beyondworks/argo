// CLI 러너 커넥터 표면 — ```argo {"action":"tool"} 블록의 파싱·실행·주입 상한·후속 턴 1회.
// 설계서 docs/mcp-oauth-design.md §2-2(크루 표면) / US-4.
//
// 왜 "결과 주입 재턴 1회"인가(스파이크 §③): 벤더 CLI의 세션 재개 3종이 전부 부적합이다 —
// codex는 CODEX_HOME이 매 턴 삭제되고, gemini -r은 타 크루 세션을 오재개하며, antigravity는
// stdin이 없다. 그래서 도구 결과는 **다음 턴의 프롬프트로 주입**되고, 그 프롬프트는 argv로 실린다.
// 상한 24KB의 근거도 거기 있다: Windows CreateProcess 32,767자가 3플랫폼 공통 최소 바운드다.
//
// 상대는 test/helpers/oauth-test-server.mjs(자동승인 AS+RS)라 브라우저·실계정 0으로 실왕복이 돈다.
// 임시 ARGO_ROOT 자가 설정 — 실데이터 미접촉.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-conn-cli-')); // import보다 먼저
const {
  parseDirectives, runDirectives, runToolFollowUp, toolFollowUpMessage,
  capBytes, connectorContentText, TOOL_RESULT_BUDGET_BYTES, TOOL_FOLLOWUP_MAX,
} = await import('../src/cli-directives.mjs');
const { startConnect, closeConnectorPools, CONNECTOR_SECRETS_BASE } = await import('../src/connectors.mjs');
const { systemPromptFor, commonDirectives } = await import('../src/chat.mjs');
const { createCompany, WS_ROOT } = await import('../src/workspace.mjs');
const { readEvents } = await import('../src/events.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

const WS = 'co-cli-conn';
await createCompany(WS, '커넥터 CLI 표면 테스트사', 'captain');
const storePath = join(WS_ROOT, WS, CONNECTOR_SECRETS_BASE);

const S = await startOauthTestServer();
after(async () => { await closeConnectorPools(); await S.close(); });

/** 브라우저·사람 동의 대역(connectors.test.mjs와 동일 패턴) — 인가 URL GET(302) → 콜백 귀환 GET. */
async function approve(authUrl) {
  const r1 = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(r1.status, 302, `authorize는 302여야 한다 (got ${r1.status})`);
  return fetch(new URL(r1.headers.get('location')));
}

const ID = 'demo-cli';
const { authUrl, done } = await startConnect(WS, { id: ID, url: S.mcpUrl, scopes: ['spike.read'] });
await approve(authUrl);
assert.deepEqual(await done, { ok: true, serverId: ID }, '픽스처 연결이 성립해야 이 파일의 실왕복이 의미가 있다');

const connectorEvents = async () => (await readEvents(WS)).filter((e) => e.type === 'connector').length;

// ── ① 파싱 — 기존 블록 문법 그대로, 액션만 늘어난다 ──

test('tool 블록을 지시로 읽는다 — server·tool·args가 그대로 전달된다', () => {
  const { clean, directives, bad } = parseDirectives(
    '메일을 확인해 보겠습니다.\n\n```argo\n{"action":"tool","server":"gmail","tool":"search_threads","args":{"query":"is:unread"}}\n```\n',
  );
  assert.deepEqual(bad, []);
  assert.deepEqual(directives, [{ action: 'tool', server: 'gmail', tool: 'search_threads', args: { query: 'is:unread' } }]);
  assert.equal(clean.includes('argo'), false, '블록은 화면에서 지워진다');
});

// ── ② 실왕복 — 지시 블록 → callConnectorTool → 결과 덧붙임 ──

test('tool 지시가 실제 커넥터 호출로 이어지고 결과가 답변에 붙는다 — 말이 아니라 실행', async () => {
  const results = [];
  const before = await connectorEvents();
  const notes = await runDirectives(WS, 'nobody', [
    { action: 'tool', server: ID, tool: 'search_threads_demo', args: { query: 'is:unread' } },
  ], { results });

  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp(`✓ 커넥터 호출 — ${ID}/search_threads_demo`));
  assert.match(notes[0], /demo results for "is:unread"/, '벤더가 실제로 돌려준 본문이 붙는다');
  assert.equal(await connectorEvents(), before + 1, '호출마다 원장 기록 — 활동 화면과 같은 원천');

  assert.equal(results.length, 1, '후속 턴 재료로 수집된다');
  assert.deepEqual(
    { server: results[0].server, tool: results[0].tool, ok: results[0].ok, truncated: results[0].truncated },
    { server: ID, tool: 'search_threads_demo', ok: true, truncated: false },
  );
  assert.equal(results[0].text, connectorContentText([{ type: 'text', text: 'demo results for "is:unread": [t1, t2]' }]),
    '후속 턴이 보는 텍스트 = 사용자가 보는 텍스트(같은 절단본)');
});

test('영어 회사는 영어 줄로 — 안내 품질 패리티(러너 중립성)', async () => {
  const notes = await runDirectives(WS, 'nobody', [
    { action: 'tool', server: ID, tool: 'search_threads_demo', args: { query: 'x' } },
  ], { lang: 'en' });
  assert.match(notes[0], new RegExp(`✓ Connector call — ${ID}/search_threads_demo`));
});

test('server·tool 누락과 잘못된 args는 조용히 삼키지 않는다', async () => {
  const before = await connectorEvents();
  const notes = await runDirectives(WS, 'nobody', [
    { action: 'tool', tool: 'search_threads_demo' },
    { action: 'tool', server: ID },
    { action: 'tool', server: ID, tool: 'search_threads_demo', args: ['not', 'an', 'object'] },
  ]);
  assert.match(notes[0], /지시 실행 실패 \(tool\).*server/);
  assert.match(notes[1], /지시 실행 실패 \(tool\).*tool/);
  assert.match(notes[2], /지시 실행 실패 \(tool\).*args/);
  assert.equal(await connectorEvents(), before, '검증 실패는 외부 호출 이전에 막힌다');
});

// ── ③ 정직한 실패 — 미연결·카탈로그 밖·재인증 필요(조용한 무동작 금지) ──

test('연결되지 않은 서버(카탈로그 밖 포함) 지시는 정직한 실패 줄 + 후속 턴 재료 없음', async () => {
  const results = [];
  const notes = await runDirectives(WS, 'nobody', [
    { action: 'tool', server: 'never-connected', tool: 'whatever', args: {} },
  ], { results });
  assert.match(notes[0], /⚠ 커넥터 호출 실패 \(never-connected\/whatever\)/);
  assert.match(notes[0], /연결되어 있지 않습니다.*설정에서 연결/);
  assert.deepEqual(results, [], '보여줄 결과가 없으면 후속 턴 비용을 쓰지 않는다');
});

test('재인증 필요 상태는 "다시 연결" 안내로 — 조용한 무동작 금지', async () => {
  const store = JSON.parse(await readFile(storePath, 'utf8'));
  store.servers['stale-conn'] = { url: S.mcpUrl, status: 'reauth', errorCode: 'reauth_required' };
  await writeFile(storePath, JSON.stringify(store), { mode: 0o600 });
  const results = [];
  const notes = await runDirectives(WS, 'nobody', [
    { action: 'tool', server: 'stale-conn', tool: 'search_threads_demo', args: { query: 'q' } },
  ], { results });
  assert.match(notes[0], /인증이 만료되었습니다.*다시 연결/);
  assert.deepEqual(results, []);

  const en = await runDirectives(WS, 'nobody', [
    { action: 'tool', server: 'stale-conn', tool: 'search_threads_demo', args: { query: 'q' } },
  ], { lang: 'en' });
  assert.match(en[0], /authorization expired.*reconnect it in Settings/);
});

// ── ④ 주입 상한 24KB — 초과/미만 경계와 잘림 표기 ──

test('capBytes: 상한 이하는 원문 그대로, 초과는 자르되 멀티바이트를 반토막 내지 않는다', () => {
  assert.deepEqual(capBytes('abc', 10), { text: 'abc', kept: 3, bytes: 3 });
  assert.deepEqual(capBytes('abcdef', 6), { text: 'abcdef', kept: 6, bytes: 6 }, '정확히 상한이면 자르지 않는다');
  assert.deepEqual(capBytes('abcdef', 5), { text: 'abcde', kept: 5, bytes: 6 }, '1바이트 초과부터 잘린다');

  const ko = '한'.repeat(10); // 문자당 3바이트
  const c = capBytes(ko, 8); // 8은 3의 배수가 아니다 — 문자 경계로 되감겨야 한다
  assert.equal(c.text, '한한', '2문자(6바이트)까지만');
  assert.equal(c.kept, 6);
  assert.equal(c.bytes, 30);
  assert.equal(c.text.includes('�'), false, '대체문자(깨진 글자)가 남지 않는다');
  assert.deepEqual(capBytes('한', 0), { text: '', kept: 0, bytes: 3 });
});

test('상한 미만 결과는 온전히 전달되고 잘림 표기가 없다', async () => {
  const results = [];
  const notes = await runDirectives(WS, 'nobody', [
    { action: 'tool', server: ID, tool: 'search_threads_demo', args: { query: 'small' } },
  ], { results });
  assert.doesNotMatch(notes[0], /잘림/);
  assert.equal(results[0].truncated, false);
  assert.ok(Buffer.byteLength(results[0].text, 'utf8') < TOOL_RESULT_BUDGET_BYTES);
});

test('상한 초과 결과는 24KB에서 잘리고 **잘렸다는 사실을 표기**한다', async () => {
  const results = [];
  const big = 'x'.repeat(TOOL_RESULT_BUDGET_BYTES + 5000); // 서버가 그대로 되돌려 준다 → 상한 초과
  const notes = await runDirectives(WS, 'nobody', [
    { action: 'tool', server: ID, tool: 'search_threads_demo', args: { query: big } },
  ], { results });

  assert.equal(results.length, 1);
  assert.equal(results[0].truncated, true);
  assert.equal(Buffer.byteLength(results[0].text, 'utf8'), TOOL_RESULT_BUDGET_BYTES, '주입은 예산 안에서 끝난다');
  assert.match(notes[0], /주입 예산으로 잘림 — 원본 \d+바이트 중 \d+바이트만 전달/,
    '조용한 절단 금지 — 부분 결과를 전체로 착각해 답하는 것을 막는다');
  assert.match(notes[0], new RegExp(`턴 예산 ${TOOL_RESULT_BUDGET_BYTES}바이트`));
});

test('상한은 **턴 전체 예산**이다 — 앞 블록이 다 쓰면 뒤 블록은 남은 만큼만 받는다', async () => {
  const results = [];
  const big = 'x'.repeat(TOOL_RESULT_BUDGET_BYTES + 5000);
  const notes = await runDirectives(WS, 'nobody', [
    { action: 'tool', server: ID, tool: 'search_threads_demo', args: { query: big } },
    { action: 'tool', server: ID, tool: 'search_threads_demo', args: { query: 'second-call-marker' } },
  ], { results });

  assert.equal(results.length, 2, '두 호출 모두 실행된다(상한은 절단이지 차단이 아니다)');
  const total = results.reduce((n, r) => n + Buffer.byteLength(r.text, 'utf8'), 0);
  assert.equal(total, TOOL_RESULT_BUDGET_BYTES, '턴 합계가 예산을 넘지 않는다');
  assert.equal(results[1].text, '', '예산이 소진되면 뒤 결과는 남은 0바이트만 받는다');
  assert.equal(results[1].truncated, true);
  assert.match(notes[1], /주입 예산으로 잘림/, '뒤 블록도 잘림을 표기한다');
  assert.doesNotMatch(notes[1], /second-call-marker/);
});

// ── ⑤ 후속 턴 1회 — 상한·증가·자기왕복 ──

test('toolHop 상한에 도달하면 도구 호출 자체를 막는다 — 정직 표기 + 외부 왕복 0', async () => {
  const results = [];
  const before = await connectorEvents();
  const notes = await runDirectives(WS, 'nobody', [
    { action: 'tool', server: ID, tool: 'search_threads_demo', args: { query: 'again' } },
  ], { toolHop: TOOL_FOLLOWUP_MAX, results });

  assert.match(notes[0], /지시 실행 실패 \(tool\).*커넥터 후속 턴 상한\(턴당 1회\)/);
  assert.match(notes[0], /이미 받은 결과로 답하라/);
  assert.equal(await connectorEvents(), before, '상한이 지키는 것은 외부 왕복 횟수와 비용 — 호출이 나가면 안 된다');
  assert.deepEqual(results, []);
});

test('runToolFollowUp: 결과가 있으면 후속 턴 1회를 돌리되 toolHop을 **올려서** 넘긴다', async () => {
  const calls = [];
  const chatFn = async (ws, slug, msg, sid, opts) => { calls.push({ ws, slug, msg, sid, opts }); return { reply: '메일 3건 중 2건이 미확인입니다.' }; };
  const r = await runToolFollowUp(chatFn, WS, 'nova', {
    results: [{ server: ID, tool: 'search_threads_demo', ok: true, text: 'demo results', truncated: false }],
    toolHop: 0, lang: 'ko', userMsg: '메일 확인해줘', sessionId: 'sess-1', chatOpts: { source: 'deck' },
  });
  assert.equal(r.reply, '메일 3건 중 2건이 미확인입니다.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.toolHop, 1, '증가하지 않으면 상한이 영원히 열린다');
  assert.equal(calls[0].opts.source, 'deck', 'chatOpts는 그대로 전달된다');
  assert.equal(calls[0].sid, 'sess-1');
  assert.match(calls[0].msg, /demo results/);
});

test('runToolFollowUp: 상한 도달·결과 없음이면 턴을 돌리지 않는다(null)', async () => {
  let called = 0;
  const chatFn = async () => { called += 1; return { reply: 'x' }; };
  const res = [{ server: ID, tool: 't', ok: true, text: 'a', truncated: false }];
  assert.equal(await runToolFollowUp(chatFn, WS, 'nova', { results: res, toolHop: TOOL_FOLLOWUP_MAX }), null);
  assert.equal(await runToolFollowUp(chatFn, WS, 'nova', { results: [], toolHop: 0 }), null);
  assert.equal(called, 0, '턴 비용을 쓰지 않는다');
});

test('runToolFollowUp: 후속 턴이 실패해도 원 턴을 죽이지 않고 정직한 줄로 돌려준다', async () => {
  const chatFn = async () => { throw new Error('러너가 빈 응답을 반환했습니다'); };
  const r = await runToolFollowUp(chatFn, WS, 'nova', {
    results: [{ server: ID, tool: 't', ok: true, text: 'a', truncated: false }], toolHop: 0,
  });
  assert.equal(r.reply, '');
  assert.match(r.note, /후속 턴 실패.*빈 응답/);
});

test('자기왕복 차단(체인 실측) — 후속 턴이 또 tool 블록을 내면 그 턴에서 거부되고 호출은 나가지 않는다', async () => {
  const before = await connectorEvents();
  const seen = [];
  // 후속 턴 대역: 실제 CLI 턴이 하는 일(답변에서 블록을 걷어 runDirectives 실행)을 그대로 한다.
  const chatFn = async (ws, slug, _msg, _sid, opts) => {
    const reply = '한 번 더 확인하겠습니다.\n\n```argo\n' + JSON.stringify({ action: 'tool', server: ID, tool: 'search_threads_demo', args: { query: 'loop' } }) + '\n```';
    const { clean, directives, bad } = parseDirectives(reply);
    const notes = await runDirectives(ws, slug, directives, { bad, toolHop: opts.toolHop });
    seen.push(...notes);
    return { reply: [clean, notes.join('\n')].join('\n\n') };
  };
  const r = await runToolFollowUp(chatFn, WS, 'nova', {
    results: [{ server: ID, tool: 'search_threads_demo', ok: true, text: 'demo results', truncated: false }],
    toolHop: 0, userMsg: '메일 확인해줘',
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /커넥터 후속 턴 상한/, '후속 턴의 두 번째 블록은 거부된다');
  assert.match(r.reply, /커넥터 후속 턴 상한/, '거부 사실이 사용자 답변에 남는다(조용한 무동작 금지)');
  assert.equal(await connectorEvents(), before, '왕복은 1회로 끝난다 — 두 번째 호출은 나가지 않았다');
});

test('주입 메시지는 결과·원 지시·재호출 금지를 함께 싣는다 (ko/en)', () => {
  const results = [{ server: 'gmail', tool: 'search_threads', ok: true, text: 'thread A\nthread B', truncated: false }];
  const ko = toolFollowUpMessage(results, { lang: 'ko', userMsg: '  메일   확인해줘  ' });
  assert.match(ko, /### gmail\/search_threads/);
  assert.match(ko, /thread A/);
  assert.match(ko, /사장의 지시는 이것이었다: 메일 확인해줘/, '공백은 정규화된다');
  assert.match(ko, /지어내거나 추측하지 마라/);
  assert.match(ko, /```argo tool 블록을 다시 내지 마라/);

  const en = toolFollowUpMessage(results, { lang: 'en', userMsg: 'check my mail' });
  assert.match(en, /The captain's instruction was: check my mail/);
  assert.match(en, /Do NOT emit another ```argo tool block/);
  assert.doesNotMatch(en, /[가-힣]/, '영어 모드에 한국어가 새지 않는다');
});

test('주입 메시지가 **크루에게도** 잘림·실패를 표시한다 — 부분 결과를 전체로 단정하는 것을 막는다', () => {
  const ko = toolFollowUpMessage([
    { server: 'gmail', tool: 'search_threads', ok: true, text: '앞부분만', truncated: true },
    { server: 'gmail', tool: 'send_mail', ok: false, text: 'quota exceeded', truncated: false },
    { server: 'drive', tool: 'list_files', ok: true, text: '전부 다', truncated: false },
  ], { lang: 'ko' });
  assert.match(ko, /### gmail\/search_threads \[잘림 — 결과의 앞부분일 뿐 전부가 아니다\]/);
  assert.match(ko, /### gmail\/send_mail \[도구가 오류를 반환함\]/);
  assert.match(ko, /### drive\/list_files\n전부 다/, '정상 결과에는 군더더기 표시가 붙지 않는다');
  assert.match(ko, /전부인 것처럼 말하지 말고, 무엇이 빠졌는지 밝혀라/);

  const en = toolFollowUpMessage([{ server: 'gmail', tool: 't', ok: false, text: 'x', truncated: true }], { lang: 'en' });
  assert.match(en, /\[the tool reported an error \/ TRUNCATED/);
  assert.match(en, /do not present them as complete/);
  assert.doesNotMatch(en, /[가-힣]/, '영어 모드에 한국어가 새지 않는다');
});

test('정상 결과만이면 경고를 붙이지 않는다 — 없는 문제를 만들지 않는다', () => {
  const ko = toolFollowUpMessage([{ server: 'gmail', tool: 't', ok: true, text: '다 받음', truncated: false }], { lang: 'ko' });
  assert.doesNotMatch(ko, /잘림/);
  assert.doesNotMatch(ko, /무엇이 빠졌는지/);
});

// ── ⑥ 프롬프트 안내 — 있는 것만 광고한다 ──

const CARD = '---\nname: 노바\n---\n\n너는 노바다.';

test('CLI 크루 프롬프트: 연결된 커넥터가 있을 때만 tool 블록 문법을 안내한다', () => {
  const live = [{ id: 'gmail', status: 'connected' }, { id: 'drive', status: 'connected' }];
  for (const lang of ['ko', 'en']) {
    const none = systemPromptFor(CARD, '/ws', '', { name: '노바' }, lang, { hasTools: false });
    assert.equal(none.includes('"action":"tool"'), false, `${lang}: 연결 0이면 없는 능력을 광고하지 않는다`);

    const some = systemPromptFor(CARD, '/ws', '', { name: '노바' }, lang, { hasTools: false, connectors: live });
    assert.match(some, /"action":"tool"/, `${lang}: 문법 안내`);
    assert.match(some, /gmail, drive/, `${lang}: 연결된 서비스 이름을 알려준다`);
    // schedule·mail·approval과 같은 자리에 병기된다 — 지시 블록은 하나의 문법이다.
    assert.match(some, /"action":"schedule"/);
    assert.match(some, /"action":"mail"/);
    assert.match(some, /"action":"approval"/);
  }
});

test('SDK 러너(hasTools) 프롬프트에는 CLI 블록 문법이 들어가지 않는다 — 표면이 다르다', () => {
  const p = systemPromptFor(CARD, '/ws', '', { name: '노바' }, 'ko', { hasTools: true, connectors: [{ id: 'gmail', status: 'connected' }] });
  assert.equal(p.includes('"action":"tool"'), false);
});

test('재인증 필요 커넥터를 CLI 크루도 안다 — SDK와 같은 표기 + 지금 못 부른다는 사실', () => {
  // 전부 reauth인 회사에서 CLI만 커넥터의 존재조차 모르면, 사장은 재연결이 필요하다는 사실을
  // 영영 듣지 못한다(SDK는 안내한다) — 안내 품질의 러너 편파.
  const stale = [{ id: 'gmail', status: 'reauth' }];
  const ko = systemPromptFor(CARD, '/ws', '', { name: '노바' }, 'ko', { hasTools: false, connectors: stale });
  assert.match(ko, /gmail\(재연결 필요\)/, 'SDK와 같은 표기(connectorNames 공용)');
  assert.match(ko, /설정에서 다시 연결하기 전까지 부를 수 없다/);
  assert.match(ko, /조용히 실패하지 말고/);

  const en = systemPromptFor(CARD, '/ws', '', { name: '노바' }, 'en', { hasTools: false, connectors: stale });
  assert.match(en, /gmail \(needs reconnect\)/);
  assert.match(en, /cannot be called until the captain reconnects/);

  // 정상 연결만 있으면 재연결 문구는 나오지 않는다(불필요한 경고 금지)
  const okOnly = systemPromptFor(CARD, '/ws', '', { name: '노바' }, 'ko', { hasTools: false, connectors: [{ id: 'gmail', status: 'connected' }] });
  assert.doesNotMatch(okOnly, /재연결 필요/);
});

test('CLI 크루도 "회사 밖 쓰기 = 결재 먼저" 규칙을 받는다 — 러너 중립(설계서 §2-4 1차 게이트)', () => {
  const live = [{ id: 'gmail', status: 'connected' }];
  for (const hasTools of [true, false]) {
    const d = commonDirectives({ connectedMcp: [], connectors: live, hasTools, lang: 'ko' });
    assert.match(d, /로그인으로 연결된 외부 서비스\(커넥터\): gmail/, `hasTools=${hasTools}: 커넥터 절`);
    assert.match(d, /회사 밖으로 나가는 쓰기.*결재를 먼저 올려라/, `hasTools=${hasTools}: 결재 선행 규칙`);
    const en = commonDirectives({ connectedMcp: [], connectors: live, hasTools, lang: 'en' });
    assert.match(en, /needs approval first/, `hasTools=${hasTools}(en): 결재 선행 규칙`);
  }
  // 연결 0이면 커넥터 절 자체가 없다
  assert.doesNotMatch(commonDirectives({ connectedMcp: [], connectors: [], hasTools: false, lang: 'ko' }), /커넥터\)/);
});

// ── ⑦ 배선 잠금 — chat.mjs 호출부는 러너 없이 행동으로 못 잡는다(소스 앵커, system-prompt.test와 같은 기법) ──

const chatSrc = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');

test('배선 — chat의 재귀 호출 전부가 toolHop을 싣는다(하나라도 빠지면 상한이 리셋된다)', () => {
  // `await chat(` 한정 — 함수 선언부(`{ … } = {}`)까지 물면 빈 옵션 `{}`가 잡혀 오타겟이 된다.
  const calls = [...chatSrc.matchAll(/await chat\(wsId, agentSlug, userMsg, [^;]*?\{([^{}]*)\}\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 3, `재귀 chat 호출 지점을 못 찾았다(${calls.length}) — 앵커가 낡았다`);
  for (const opts of calls) {
    assert.match(opts, /\btoolHop\b/, `재귀 chat 호출에 toolHop 누락: {${opts}}`);
  }
});

test('배선 — CLI 프롬프트가 커넥터 요약을 systemPromptFor·commonDirectives **양쪽**에 넘긴다', () => {
  // commonDirectives 쪽이 빠지면 결재 선행 규칙(connectorLine)이 CLI에만 통째로 사라진다.
  const m = chatSrc.match(/systemPromptFor\(md, p\.root, skills, meta, lang, \{([^{}]*)\}\)\}\$\{commonDirectives\(\{([^{}]*)\}\)/);
  assert.ok(m, 'CLI 프롬프트 조립 지점을 못 찾았다 — 앵커가 낡았다');
  assert.match(m[1], /connectors:\s*cliConnectors/, 'systemPromptFor에 커넥터 요약 누락');
  assert.match(m[2], /connectors:\s*cliConnectors/, 'commonDirectives에 커넥터 요약 누락 = 결재 선행 규칙이 CLI에서 소실');
});

test('배선 — CLI 커넥터 원천은 connectorBriefing(연결+재인증) 이다', () => {
  // listConnections를 connected로 거르면 reauth가 사라져 SDK와 안내가 갈린다.
  const m = chatSrc.match(/const cliConnectors = [^;]+;/);
  assert.ok(m, 'cliConnectors 정의를 못 찾았다 — 앵커가 낡았다');
  assert.match(m[0], /connectorBriefing\(wsId\)/, 'CLI 커넥터 원천이 SDK와 다르다');
  assert.doesNotMatch(m[0], /status === 'connected'/, 'connected만 거르면 재인증 필요가 크루에게 사라진다');
});
