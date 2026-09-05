// 네이티브 엔진 분리 검수 3R(2026-09-06) 처방 핀 — CRITICAL-1 비밀 계급 분리, CRITICAL-2 컴퓨터 유즈 옵트인+게이트, HIGH-1 전사 불변식·이미지 상한,
// HIGH-2 오류 code 보존, MEDIUM-1 기동 뮤텍스, MEDIUM-3 청크 안전 파싱, MEDIUM-5 윈도우 스크롤 부호, LOW a/b/c 프로필 위치·키체인 인자·AppleScript 리터럴.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
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
const { makePermissionGate, stringLeaves } = await import('../src/permission-gate.mjs');
const { trimMessages, dropOldImages, SESSION_MAX_CHARS } = await import('../src/engine/session.mjs');
const { imageToolResult, IMAGE_MAX_B64, nativeQuery, builtinTools } = await import('../src/engine/native-query.mjs');
const { extractErrorMessage } = await import('../src/engine/messages-http.mjs');
const { isGrokCreditError } = await import('../src/runners/grok.mjs');
const { devToolsUrlFrom, devToolsUrlFromFile, BrowserSession, findChrome, closeAllBrowsers, _sessionsForTest } = await import('../src/engine/browser-tools.mjs');
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
  assert.ok(IMAGE_MAX_B64 <= SESSION_MAX_CHARS * 0.8 && IMAGE_MAX_B64 >= 100_000, `상한은 전사 예산의 80% 이하(자기참조 핀 금지 — 4R): ${IMAGE_MAX_B64}`);
  const huge = Buffer.alloc(400_000, 1); // 고정 크기 — 상한을 올리는 변이가 초록이 되지 않게
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
  const p = BrowserSession.profileDir('ws1', { ARGO_ROOT: join('/x', 'workspaces') }); // 윈도우는 백슬래시 — 경로 비교는 join으로(CI 실측)
  assert.equal(p, join('/x', 'browser', 'ws1')); assert.ok(!p.startsWith(join('/x', 'workspaces') + sep), '회사 폴더 밖');
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

test('R3-9 4R-HIGH. 프로필에 남은 옛 DevToolsActivePort(죽은 포트)가 있어도 기동에 성공한다 — 스폰 전 삭제', { skip: !findChrome() && 'Chrome 없음' }, async () => {
  const wsId = 'r3stale'; const profile = BrowserSession.profileDir(wsId, process.env);
  await mkdir(profile, { recursive: true }); await writeFile(join(profile, 'DevToolsActivePort'), '59999\n/devtools/browser/dead-uuid\n');
  try {
    const s = await BrowserSession.get(wsId); assert.equal(s.alive, true, '잔재 파일이 있어도 기동');
    const cur = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    assert.ok(!cur.includes('dead-uuid'), '잔재는 스폰 전에 지워지고 새 값으로 대체된다');
  } finally { await closeAllBrowsers(); }
});

test('R3-10 4R. 세션 map 축출 가드 — 실패한 기동의 exit가 같은 wsId의 산 세션을 map에서 밀어내지 않는다', async () => {
  const wsId = 'r3guard'; const alive = { wsId, alive: true, touch() {}, async close() {} };
  _sessionsForTest().set(wsId, alive);
  try {
    const bad = new BrowserSession(wsId, { env: { ...process.env, ARGO_CHROME_PATH: process.execPath }, headless: true });
    await assert.rejects(() => bad.launch(), /뜨자마자 종료|실행 실패/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(_sessionsForTest().get(wsId), alive, '산 세션 유지'); assert.equal(await BrowserSession.get(wsId), alive, 'get도 산 세션을 돌려준다');
  } finally { _sessionsForTest().delete(wsId); }
});

test('R3-11 4R. trimMessages 배선 — 상한 초과 전사의 이미지는 최신 1개만 남는다(dropOldImages 호출 핀)', () => {
  const img = (data) => ({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }] });
  const chunk = 'B'.repeat(260_000); // 두 장 합이 전사 상한(40만)을 넘어야 트리밍 경로에 들어간다
  const msgs = [{ role: 'user', content: '지시' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'browser_screenshot', input: {} }] }, { role: 'user', content: [img(chunk)] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'browser_screenshot', input: {} }] }, { role: 'user', content: [img(chunk + 'Z')] }];
  const out = trimMessages(msgs);
  const images = out.flatMap((m) => (Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === 'tool_result' ? b.content : [b])) : [])).filter((b) => b.type === 'image');
  // 5R: '<= 1'은 0개 붕괴(dropOldImages 배선 제거)에도 초록이었다 — 정확히 1개·최신 데이터·전사 길이 보존·자리표시 존재까지 단언
  assert.equal(images.length, 1, `이미지 ${images.length}개`); assert.equal(images[0].source.data, chunk + 'Z', '최신 이미지가 남는다');
  assert.equal(out.length, 5, '전사가 붕괴하지 않는다'); assert.ok(JSON.stringify(out[2]).includes('생략'), '옛 이미지는 자리표시');
  assert.equal(out[0].role, 'user');
});

test('R3-12 4R. 게이트 리터럴 방어는 입력의 모든 문자열 잎을 본다(고정 키 목록 우회 차단) — 분할 입력·조합키는 한계로 명시', async () => {
  const wsRoot = join(process.env.ARGO_ROOT, 'r3ws2'); await mkdir(wsRoot, { recursive: true });
  const on = makePermissionGate('r3ws2', 'crew', wsRoot, null, 'ko', [], { computerUse: true });
  assert.equal((await on('computer_type', { texts: ['cat ~/.argo/.secrets.json'] })).behavior, 'deny');
  assert.equal((await on('computer_type', { input: { nested: { s: 'open ~/.codex/auth.json' } } })).behavior, 'deny');
  assert.equal((await on('computer_key', { keys: ['cmd+space', 'capabilities.json'] })).behavior, 'deny');
  assert.equal((await on('computer_type', { text: 'cat ~/.ar' })).behavior, 'allow', '분할 입력은 못 막는다 — 실효 통제는 옵트인(정직 표기)');
  assert.deepEqual(stringLeaves({ a: 'x', b: ['y', { c: 'z', n: 1 }] }), ['x', 'y', 'z']);
});

test('R3-13 4R. 스크린샷 품질 사다리 — 상한이 작으면 품질·배율을 낮춰 더 작은 이미지를 낸다(버리지 않는다)', { skip: !findChrome() && 'Chrome 없음' }, async () => {
  const noisy = `<html><body style="margin:0"><canvas id=c width=1280 height=900></canvas><script>const c=document.getElementById('c').getContext('2d');const d=c.createImageData(1280,900);for(let i=0;i<d.data.length;i++)d.data[i]=(Math.random()*256)|0;c.putImageData(d,0,0);</script></body></html>`;
  const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(noisy); }); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const s = await BrowserSession.get('r3shot'); await s.navigate(`http://127.0.0.1:${srv.address().port}/`);
    const big = await s.screenshotJpeg(Number.MAX_SAFE_INTEGER); const small = await s.screenshotJpeg(1);
    // 스크롤 뒤 저하단 clip이 현재 뷰포트(pageY)를 가리키는지 — 문서 좌표 0,0이면 뷰포트 밖 백지(5R HIGH)
    await s.evaluate('(() => { document.body.style.height = "5000px"; window.scrollTo(0, 1800); return 1; })()');
    const calls = []; const orig = s.send.bind(s); s.send = (m, p) => { if (m === 'Page.captureScreenshot') calls.push(p); return orig(m, p); };
    try { await s.screenshotJpeg(1); } finally { s.send = orig; }
    const clipped = calls.filter((p) => p.clip); assert.ok(clipped.length >= 1, '저하단이 돌았다');
    for (const p of clipped) assert.ok(p.clip.y >= 1700 && p.clip.y <= 1900, `clip.y가 스크롤 위치를 반영: ${p.clip.y}`);
    assert.ok(big.length > 0 && small.length < big.length * 0.6, `사다리 축소: ${big.length} → ${small.length}`);
    assert.ok(small[0] === 0xFF && small[1] === 0xD8, 'JPEG');
  } finally { await closeAllBrowsers(); await new Promise((r) => srv.close(r)); }
});
