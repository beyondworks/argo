// 네이티브 엔진 분리 검수 3R(2026-09-06) 처방 핀 — CRITICAL-1 비밀 계급 분리, CRITICAL-2 컴퓨터 유즈 옵트인+게이트, HIGH-1 전사 불변식·이미지 상한,
// HIGH-2 오류 code 보존, MEDIUM-1 기동 뮤텍스, MEDIUM-3 청크 안전 파싱, MEDIUM-5 윈도우 스크롤 부호, LOW a/b/c 프로필 위치·키체인 인자·AppleScript 리터럴.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-r3-home-'));
process.env.USERPROFILE = process.env.HOME;
await mkdir(join(process.env.HOME, 'AppData', 'Local'), { recursive: true });
// ARGO_ROOT는 임시 루트 **아래**(…/workspaces) — 크롬 프로필은 dirname(ARGO_ROOT)/browser/<ws>라, 임시 루트를 직접 쓰면 실행마다 tmpdir/browser/<ws>를 공유해
// 앞선(취소된) 실행의 크롬이 프로필 락을 쥔 채 남으면 다음 실행이 멈춘다(실측). 실행마다 고유 부모 아래에 둔다.
process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-r3-')), 'workspaces');
await mkdir(process.env.ARGO_ROOT, { recursive: true });
process.env.ARGO_MODEL_CATALOG = 'off';
process.env.ARGO_BROWSER_HEADLESS = '1';

const { isSecretRel, isSecretNameRel, isEncRel } = await import('../src/secretbox.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');
const { trimMessages, dropOldImages, SESSION_MAX_CHARS } = await import('../src/engine/session.mjs');
const { imageToolResult, IMAGE_MAX_B64, nativeQuery, builtinTools } = await import('../src/engine/native-query.mjs');
const { extractErrorMessage } = await import('../src/engine/messages-http.mjs');
const { isGrokCreditError } = await import('../src/runners/grok.mjs');
const { devToolsUrlFrom, devToolsUrlFromFile, BrowserSession, findChrome, closeAllBrowsers } = await import('../src/engine/browser-tools.mjs');
const { winScript, macPasteScript, asLiteral } = await import('../src/engine/computer-tools.mjs');

test('R3-1 CRITICAL-1. 회수 계급은 제어 3종만, 이름 규칙은 봉인 계급 — 사용자 문서(.key 키노트·.pem)가 호스티드 마커 회수 대상이 아니다', () => {
  for (const r of ['vault/decks/발표자료.key', 'vault/files/cacert.pem', 'vault/p/auth.json', 'vault/p/tokens.json', 'vault/p/.env']) {
    assert.equal(isSecretRel(r), false, `회수 계급 아님: ${r}`);
    assert.equal(isSecretNameRel(r), true, `이름 규칙: ${r}`);
    assert.equal(isEncRel(r), true, `봉인 계급: ${r}`);
  }
  for (const r of ['connections.json', '.secrets.json', 'mcp.json']) assert.equal(isSecretRel(r), true, r);
  assert.equal(isSecretNameRel('.env.local.example'), false, '예시 파일 제외(검수 LOW-f)');
});

test('R3-2 CRITICAL-2. 컴퓨터 유즈 — 옵트인 없으면 게이트 deny, 옵트인이어도 하드존 리터럴은 deny, 평범한 입력은 allow; 네이티브 턴에 도구가 기본으로 실리지 않는다', async () => {
  const wsRoot = join(process.env.ARGO_ROOT, 'r3ws'); await mkdir(wsRoot, { recursive: true });
  const off = makePermissionGate('r3ws', 'crew', wsRoot, null, 'ko', []);
  const d1 = await off('computer_type', { text: 'hello' });
  assert.equal(d1.behavior, 'deny'); assert.match(d1.message, /컴퓨터 유즈/);
  assert.equal((await off('computer_click', { x: 1, y: 2 })).behavior, 'deny');
  const on = makePermissionGate('r3ws', 'crew', wsRoot, null, 'ko', [], { computerUse: true });
  assert.equal((await on('computer_type', { text: 'cat ~/.argo/.secrets.json' })).behavior, 'deny', '하드존 리터럴');
  assert.equal((await on('computer_type', { text: 'open ~/.codex/auth.json' })).behavior, 'deny', '벤더 자격 리터럴');
  assert.equal((await on('computer_type', { text: 'echo x > capabilities.json' })).behavior, 'deny', '회사 금고 리터럴');
  assert.equal((await on('computer_type', { text: '안녕하세요 보고서 초안입니다' })).behavior, 'allow');
  assert.equal((await on('computer_key', { key: 'cmd+space' })).behavior, 'allow');
  assert.equal((await on('computer_click', { x: 10, y: 20 })).behavior, 'allow');
  // 도구 목록: 기본은 computer_* 없음, 명시 옵트인만 포함
  const names = (o) => builtinTools({ cwd: wsRoot, env: process.env, wsId: 'r3ws', ...o }).map((t) => t.name);
  assert.ok(names({ computer: true }).some((n) => n.startsWith('computer_')));
  assert.ok(!names({ computer: false }).some((n) => n.startsWith('computer_')));
  // 실루프: opts.computer 미지정 → init 이벤트의 tools에 computer_* 없음(browser_*는 있음)
  const srv = createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    let init = null;
    for await (const ev of nativeQuery({ wsId: 'r3ws', slug: 'crew', prompt: 'x', cwd: wsRoot, systemPrompt: '', env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: base }, model: 'm', saveSession: false })) { if (ev.type === 'system' && ev.subtype === 'init') init = ev; }
    assert.ok(init, 'init 이벤트');
    assert.ok(!init.tools.some((n) => n.startsWith('computer_')), `기본 턴에 computer_* 없음: ${init.tools.join(',')}`);
    assert.ok(init.tools.some((n) => n.startsWith('browser_')), '브라우저 유즈는 기본 포함');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('R3-3 HIGH-1. 전사는 절대 비지 않는다 — 큰 이미지·큰 도구 결과 누적에도 마지막 지시가 남고, 옛 이미지는 자리표시로', async () => {
  const big = 'A'.repeat(SESSION_MAX_CHARS + 50_000);
  const img = (data) => ({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] });
  const msgs = [
    { role: 'user', content: '첫 지시' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'browser_screenshot', input: {} }] }, { role: 'user', content: [img('old')] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'browser_screenshot', input: {} }] }, { role: 'user', content: [img(big)] },
  ];
  const out = trimMessages(msgs);
  assert.ok(out.length >= 1, '비지 않는다');
  assert.equal(out[0].role, 'user'); assert.ok(Array.isArray(out[0].content) ? out[0].content.some((b) => b.type !== 'tool_result') : true, '머리는 실제 지시');
  const dropped = dropOldImages(msgs);
  const imagesLeft = dropped.flatMap((m) => (Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === 'tool_result' ? b.content : [b])) : [])).filter((b) => b.type === 'image');
  assert.equal(imagesLeft.length, 1, '최신 이미지 1개만'); assert.equal(imagesLeft[0].source.data, big);
  assert.ok(JSON.stringify(dropped[2]).includes('생략'), '옛 이미지는 자리표시');
  // 상한 초과 이미지는 파일로만 — 전사엔 텍스트만, 경로는 vault/files/screenshots(서빙 접두), 확장자는 mime 기준
  const cwd = await mkdtemp(join(tmpdir(), 'argo-r3-img-'));
  const huge = Buffer.alloc(Math.ceil(IMAGE_MAX_B64 * 0.75) + 10_000, 1);
  const blocks = await imageToolResult({ image: huge, mime: 'image/jpeg' }, { cwd, model: 'claude-x', env: { ARGO_VISION_MODELS: '*' } });
  assert.equal(blocks.length, 1); assert.equal(blocks[0].type, 'text'); assert.match(blocks[0].text, /saved: vault\/files\/screenshots\/.*\.jpg/); assert.match(blocks[0].text, /커서/);
  const small = await imageToolResult({ image: Buffer.alloc(1000, 2), mime: 'image/png' }, { cwd, model: 'claude-x', env: { ARGO_VISION_MODELS: '*' } });
  assert.equal(small.length, 2); assert.equal(small[1].type, 'image'); assert.match(small[0].text, /\.png$/m);
  assert.ok(existsSync(join(cwd, 'vault', 'files', 'screenshots')));
});

test('R3-4 HIGH-2. 벤더 오류 본문의 code 필드가 보존돼 크레딧 분류기가 문다(xAI personal-team-blocked)', () => {
  const m = extractErrorMessage(JSON.stringify({ code: 'personal-team-blocked', error: 'Forbidden' }));
  assert.match(m, /personal-team-blocked/); assert.equal(isGrokCreditError(m), true);
  assert.equal(extractErrorMessage(JSON.stringify({ error: { message: 'Rate limit exceeded', code: 429 } })), 'Rate limit exceeded', '숫자 code는 문구 그대로');
  assert.equal(extractErrorMessage(JSON.stringify({ error: { message: 'bad (E1)', code: 'E1' } })), 'bad (E1)', '중복 부착 없음');
  assert.equal(extractErrorMessage('plain text  error'), 'plain text error');
});

test('R3-5 MEDIUM-3. DevTools 주소 파싱 — 청크가 URL 중간에서 갈라지면 채택하지 않고 완결된 줄만, 파일 폴백은 두 행이 다 있을 때만', async () => {
  assert.equal(devToolsUrlFrom('DevTools listening on ws://127.0.0.1:9'), null, '조각은 미채택');
  assert.equal(devToolsUrlFrom('DevTools listening on ws://127.0.0.1:9' + '2222/devtools/browser/abc\n'), 'ws://127.0.0.1:92222/devtools/browser/abc');
  assert.equal(devToolsUrlFrom('x\r\nDevTools listening on ws://127.0.0.1:1234/devtools/browser/z\r\n'), 'ws://127.0.0.1:1234/devtools/browser/z');
  const prof = await mkdtemp(join(tmpdir(), 'argo-r3-prof-'));
  assert.equal(await devToolsUrlFromFile(prof), null);
  await writeFile(join(prof, 'DevToolsActivePort'), '4567');
  assert.equal(await devToolsUrlFromFile(prof), null, '1행만 = 쓰는 중');
  await writeFile(join(prof, 'DevToolsActivePort'), '4567\n/devtools/browser/q\n');
  assert.equal(await devToolsUrlFromFile(prof), 'ws://127.0.0.1:4567/devtools/browser/q');
});

test('R3-6 MEDIUM-5·LOW-c. 윈도우 스크롤은 uint(음수 그대로 금지), 맥 붙여넣기 스크립트는 이스케이프된 리터럴', () => {
  const down = winScript('scroll', { dy: 3 });
  assert.ok(down.includes(String((-360) >>> 0)), `uint 인자: ${down.slice(-80)}`); assert.ok(!/mouse_event\(2048, 0, 0, -/.test(down), '음수 없음');
  assert.ok(winScript('scroll', { dy: -3 }).includes('mouse_event(2048, 0, 0, 360'));
  const [args] = macPasteScript('a"b\\c\nd');
  assert.equal(args[1], 'set the clipboard to "a\\"b\\\\c\\nd"'); assert.equal(asLiteral('x"y'), '"x\\"y"');
  assert.ok(!args[1].includes('a"b'), '원시 따옴표 보간 없음');
});

test('R3-7 LOW-a/b. 프로필은 회사 폴더 밖(동기화 대상 아님), 크롬 argv에 키체인 무접촉 인자·포트 0·프로필 인자 — 가짜 크롬으로 실측', async (t) => {
  const p = BrowserSession.profileDir('ws1', { ARGO_ROOT: '/x/workspaces' });
  assert.equal(p, '/x/browser/ws1'); assert.ok(!p.startsWith('/x/workspaces/'), '회사 폴더 밖');
  if (process.platform === 'win32') { t.skip('셸 스크립트 가짜 크롬은 POSIX 전용'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'argo-r3-fake-chrome-')); const argvFile = join(dir, 'argv.txt'); const fake = join(dir, 'chrome.sh');
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nexit 0\n`); await chmod(fake, 0o755);
  const s = new BrowserSession('r3fake', { env: { ...process.env, ARGO_CHROME_PATH: fake }, headless: true });
  await assert.rejects(() => s.launch(), /뜨자마자 종료/);
  const argv = (await readFile(argvFile, 'utf8')).split('\n');
  for (const want of ['--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0', '--headless=new', '--no-first-run']) assert.ok(argv.includes(want), `argv에 ${want}`);
  const udd = argv.find((a) => a.startsWith('--user-data-dir='));
  assert.ok(udd && udd.includes(join('browser', 'r3fake')) && !udd.includes(join('workspaces', 'r3fake')), `프로필 인자: ${udd}`);
  await s.close();
});

test('R3-8 MEDIUM-1. 같은 회사 동시 기동 3건은 한 크롬·한 세션으로 수렴하고, 실패한 기동이 산 세션을 밀어내지 않는다', { skip: !findChrome() && 'Chrome 없음' }, async () => {
  try {
    const [a, b, c] = await Promise.all([BrowserSession.get('r3conc'), BrowserSession.get('r3conc'), BrowserSession.get('r3conc')]);
    assert.ok(a === b && b === c, '같은 인스턴스'); assert.equal(a.alive, true);
    const again = await BrowserSession.get('r3conc'); assert.equal(again, a, '재사용');
  } finally { await closeAllBrowsers(); }
});
