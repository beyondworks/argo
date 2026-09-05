// 브라우저 유즈·컴퓨터 유즈(네이티브 엔진 내장) — 헤드리스 크롬 실구동(있을 때), 순수 빌더, 이미지 결과 조립, 비전 판정, 배선 핀.
// 실벤더 호출 0. 컴퓨터 유즈 라이브(스크린샷·마우스 이동)는 macOS + 접근성 권한이 있을 때만(ARGO_TEST_COMPUTER=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-bc-home-'));
process.env.USERPROFILE = process.env.HOME;
// 윈도우 크롬은 USERPROFILE로 기본 데이터 폴더(AppData\Local)를 찾다 실패하면 원격 디버깅을 거부한다
// ("DevTools remote debugging requires a non-default data directory") — 격리용 임시 USERPROFILE 아래에 그 폴더를 만들어 준다.
// 윈도우 러너 실측(PR #435 프로브 3): AppData\Local 없음=거부, 있음=0.3초 기동, HOME만 바꾼 경우=무관. 실사용 환경엔 항상 있다.
await mkdir(join(process.env.HOME, 'AppData', 'Local'), { recursive: true });
await mkdir(join(process.env.HOME, 'AppData', 'Roaming'), { recursive: true });
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-bc-'));
process.env.ARGO_MODEL_CATALOG = 'off';
process.env.ARGO_BROWSER_HEADLESS = '1';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const { findChrome, parseKeyCombo, browserRunners, BrowserSession, closeAllBrowsers, BROWSER_SPECS } = await import('../src/engine/browser-tools.mjs');
const { macKeyScript, macMouseJxa, winScript, winKeyString, computerRunners, COMPUTER_SPECS } = await import('../src/engine/computer-tools.mjs');
const { visionCapable, imageToolResult, builtinTools, nativeToolsDirective, nativeQuery } = await import('../src/engine/native-query.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');

const CHROME = findChrome();
const AX = process.platform === 'darwin' && process.env.ARGO_TEST_COMPUTER === '1';

async function page(html) {
  const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

test('B1. 브라우저 유즈 실구동(헤드리스 크롬) — 이동·스냅샷 ref·클릭·입력·키·스크롤·스크린샷·eval', { skip: !CHROME && 'Chrome 없음' }, async () => {
  const p = await page(`<html><head><title>Argo BT</title></head><body>
    <h1>Hello</h1><form onsubmit="event.preventDefault(); document.getElementById('out').textContent='submitted:'+document.getElementById('q').value">
    <input id="q" placeholder="query"><button type="submit">Go</button></form><p id="out">none</p>
    <a href="#second" id="lnk">Second</a><div style="height:3000px"></div><p id="bottom">BOTTOM</p></body></html>`);
  const br = browserRunners({ wsId: 'bt1', env: process.env, headless: true });
  try {
    const nav = await br.browser_navigate({ url: p.url });
    assert.match(nav, /TITLE: Argo BT/); assert.match(nav, /\[e\d+\] input "query"/); assert.match(nav, /\[e\d+\] button:submit "Go"/);
    const snap = await br.browser_snapshot({ max_chars: 5000 });
    const inputRef = snap.match(/\[(e\d+)\] input "query"/)[1]; const btnRef = snap.match(/\[(e\d+)\] button:submit "Go"/)[1];
    assert.match(await br.browser_type({ ref: inputRef, text: '아르고 검색' }), /typed into/);
    const clicked = await br.browser_click({ ref: btnRef });
    assert.match(clicked, /submitted:아르고 검색/, '클릭 뒤 스냅샷에 결과 반영');
    assert.equal(await br.browser_eval({ js: "document.getElementById('out').textContent" }), 'submitted:아르고 검색');
    const scrolled = await br.browser_scroll({ direction: 'bottom' }); assert.match(scrolled, /scrolled bottom/);
    assert.ok(Number(await br.browser_eval({ js: 'window.scrollY' })) > 1000, '실제로 스크롤됨');
    assert.match(await br.browser_press({ key: 'Escape' }), /pressed Escape/);
    const shot = await br.browser_screenshot({}); assert.ok(Buffer.isBuffer(shot.image) && shot.image.subarray(1, 4).toString() === 'PNG', 'PNG 스크린샷');
    assert.match(await br.browser_click({ ref: '#lnk' }), /clicked #lnk/, 'CSS 셀렉터도 된다');
    await assert.rejects(br.browser_click({ ref: 'e999' }), /element not found/);
    await assert.rejects(br.browser_navigate({ url: 'file:///etc/passwd' }), /http\(s\) URL/);
  } finally { await closeAllBrowsers(); await p.close(); }
});

test('B2. 순수 빌더 — 키 조합·크롬 탐색·JXA/PowerShell 스크립트·비전 판정·안내 문구·사양 이름', () => {
  assert.deepEqual(parseKeyCombo('cmd+a'), { key: 'a', code: 'KeyA', keyCode: 65, text: undefined, modifiers: 4 });
  assert.equal(parseKeyCombo('Enter').text, '\r'); assert.equal(parseKeyCombo('ctrl+shift+ArrowDown').modifiers, 10);
  assert.equal(findChrome({}, 'linux'), null, '없으면 null(도구가 정직한 오류)'); assert.equal(findChrome({ ARGO_CHROME_PATH: ROOT + 'package.json' }), ROOT + 'package.json', 'env 우선');
  assert.equal(macKeyScript('cmd+shift+t'), 'tell application "System Events" to keystroke "t" using {command down, shift down}');
  assert.equal(macKeyScript('enter'), 'tell application "System Events" to key code 36'); assert.throws(() => macKeyScript('bogus-key'), /unknown key/);
  assert.match(macMouseJxa('left', 10, 20), /AXIsProcessTrusted/); assert.match(macMouseJxa('double', 1, 2), /const n = 2/); assert.match(macMouseJxa('drag', 1, 2, { x2: 30, y2: 40 }), /kCGEventLeftMouseDragged/); assert.match(macMouseJxa('scroll', null, null, { dy: 3 }), /ScrollWheelEvent/);
  const ps = winScript('type', { text: "it's $env:PATH `x` (a)" });
  assert.ok(ps.includes("SendWait('it''s $env:PATH `x` {(}a{)}')"), 'PowerShell 작은따옴표 리터럴 + SendKeys 메타 이스케이프');
  assert.equal(winKeyString('ctrl+shift+t'), '^+(t)'); assert.equal(winKeyString('enter'), '{ENTER}'); assert.throws(() => winKeyString('nope-key'), /unknown key/);
  assert.match(winScript('screenshot', { file: "C:\\x\\it's.png" }), /Save\('C:\\x\\it''s\.png'/);
  assert.equal(visionCapable('anthropic/claude-haiku-4.5'), true); assert.equal(visionCapable('minimax/minimax-m3:free'), true); assert.equal(visionCapable('deepseek/deepseek-v4-pro'), false, '모르는 모델 = 텍스트만(400 방지)');
  assert.equal(visionCapable('deepseek/x', { ARGO_VISION_MODELS: '*' }), true); assert.equal(visionCapable('claude-x', { ARGO_VISION_MODELS: 'none' }), false); assert.equal(visionCapable('foo/bar', { ARGO_VISION_MODELS: 'bar,baz' }), true);
  assert.match(nativeToolsDirective('ko'), /browser_navigate/); assert.match(nativeToolsDirective('en'), /computer_screenshot/);
  assert.deepEqual(BROWSER_SPECS.map((s) => s.name), ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_back', 'browser_screenshot', 'browser_eval']);
  assert.deepEqual(COMPUTER_SPECS.map((s) => s.name), ['computer_screenshot', 'computer_move', 'computer_click', 'computer_drag', 'computer_type', 'computer_key', 'computer_scroll']);
  const names = builtinTools({ cwd: ROOT, env: {} }).map((t) => t.name);
  assert.ok(names.includes('browser_navigate') && names.includes('computer_screenshot') && names.includes('Read'), '네이티브 도구 집합에 포함');
  assert.ok(builtinTools({ cwd: ROOT, env: {}, browser: false, computer: false }).every((t) => !/^(browser|computer)_/.test(t.name)));
});

test('B3. 이미지 결과 조립 — 비전 모델은 이미지 블록 + 파일, 그 외는 파일 경로만; 루프에서 스크린샷 도구가 블록으로 회신된다', async () => {
  const ws = 'bt3'; await createCompany(ws, '스샷', '사장'); const root = paths(ws).root;
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(16)]);
  const a = await imageToolResult({ image: png, mime: 'image/png', note: 'n' }, { cwd: root, model: 'claude-x', now: 1_700_000_000_000 });
  assert.equal(a.length, 2); assert.equal(a[1].type, 'image'); assert.equal(a[1].source.media_type, 'image/png'); assert.match(a[0].text, /saved: vault\/screenshots\/2023-11-14T22-13-20-000Z\.png/);
  const b = await imageToolResult({ image: png, mime: 'image/png', note: 'n' }, { cwd: root, model: 'deepseek/x', now: 1_700_000_000_001 });
  assert.equal(b.length, 1); assert.match(b[0].text, /이미지 입력을 지원하지 않는/);
  assert.equal((await readdir(join(root, 'vault', 'screenshots'))).length, 2);
  // 루프 배선 — 가짜 벤더가 computer_screenshot을 부르면 tool_result.content가 블록 배열(이미지 포함)이다(비전 모델). 실행기는 주입 없이 스텁 불가라 builtinTools를 비전 모델로 돌리되 도구 자체는 가짜 서버가 부르지 않는 경로로 검증.
  const srv = createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { const body = JSON.parse(d); const n = (srv.bodies ??= []).push(body);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(n === 1 ? { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'vault/x.md', content: 'x' } }], stop_reason: 'tool_use', usage: {}, model: 'claude-x' } : { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {}, model: 'claude-x' })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const q = nativeQuery({ wsId: ws, slug: 's', prompt: 'x', cwd: root, systemPrompt: '', env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${srv.address().port}`, ANTHROPIC_AUTH_TOKEN: 't' }, model: 'claude-x', canUseTool: makePermissionGate(ws, 's', root, null, 'ko', []) });
    const out = []; for await (const m of q) out.push(m);
    assert.equal(out.at(-1).result, 'ok');
    const toolNames = srv.bodies[0].tools.map((t) => t.name);
    assert.ok(toolNames.includes('browser_screenshot') && toolNames.includes('computer_click'), '브라우저·컴퓨터 도구가 벤더에 광고된다');
  } finally { srv.close(); }
});

test('B4. 컴퓨터 유즈 라이브(macOS·접근성) — 스크린샷 PNG + 마우스 이동(무해)', { skip: !AX && 'ARGO_TEST_COMPUTER=1 + macOS 접근성 필요' }, async () => {
  const cr = computerRunners();
  const shot = await cr.computer_screenshot({});
  assert.ok(Buffer.isBuffer(shot.image) && shot.image.subarray(1, 4).toString() === 'PNG'); assert.match(shot.note, /screenshot \d+x\d+/);
  assert.match(await cr.computer_move({ x: 5, y: 5 }), /moved to 5,5/);
});

test('B5. 배선 핀 — chat.mjs 네이티브 턴 프롬프트에 도구 안내, native-query가 이미지 결과를 블록으로', async () => {
  const chat = await readFile(join(ROOT, 'src', 'chat.mjs'), 'utf8');
  assert.match(chat, /systemPrompt: systemPromptFor\(md, p\.root, skills, meta, lang\) \+ sysTail \+ nativeToolsDirective\(lang\),/);
  const nq = await readFile(join(ROOT, 'src', 'engine', 'native-query.mjs'), 'utf8');
  assert.match(nq, /if \(out && typeof out === 'object' && Buffer\.isBuffer\(out\.image\)\) blocks = await imageToolResult\(out, \{ cwd, model, env \}\);/);
  assert.match(nq, /content: blocks \?\? \(text\.slice\(0, TOOL_RESULT_CAP\) \|\| '\(empty\)'\)/);
});

test('B6. 브라우저 기동 실패 판정 — 뜨자마자 종료되는 실행 파일은 상한(60초)을 기다리지 않고 즉시 원인 있는 오류', async () => {
  // node 실행 파일을 가짜 크롬으로: 크롬 인자('--remote-debugging-port=…')를 node가 잘못된 옵션으로 거절해 즉시 종료(모든 OS 공통).
  const env = { ...process.env, ARGO_CHROME_PATH: process.execPath, ARGO_ROOT: join(tmpdir(), `argo-bt6-${Date.now()}`, 'workspaces') };
  const s = new BrowserSession('bt6', { env, headless: true });
  const t0 = Date.now();
  await assert.rejects(() => s.launch(), (e) => /뜨자마자 종료|실행 실패/.test(e.message) && !/60초/.test(e.message), '조기 종료가 원인으로 실림');
  assert.ok(Date.now() - t0 < 15_000, `상한을 기다리지 않는다(${Date.now() - t0}ms)`);
  await s.close();
});
