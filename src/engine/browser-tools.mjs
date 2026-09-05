// 브라우저 유즈(네이티브 엔진 내장) — Argo 전용 크롬 프로필을 띄우고 CDP(Chrome DevTools Protocol)로 제어한다.
// Hermes(browser_* 도구 13종, CDP 백엔드)·OpenClaw(browser 확장, CDP·확장 릴레이)와 같은 구조: 러너·모델과 무관하게 같은 도구·같은 게이트.
// 설계 원칙 — 사용자의 일상 크롬 프로필을 건드리지 않는다(전용 프로필 디렉터리, 워크스페이스별). 프로필은 회사 폴더 밖(동기화 대상 아님).
// 의존성 0: Node 22의 전역 WebSocket + 시스템 크롬(Chrome/Chromium/Edge/Brave). 없으면 도구가 정직한 오류를 돌려준다(마켓의 브라우저 MCP가 대안).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const BROWSER_SPECS = Object.freeze([
  { name: 'browser_navigate', description: 'Open a URL in the Argo browser (dedicated Chrome profile) and wait for load. Returns title, url and a short text snapshot.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_snapshot', description: 'Text snapshot of the current page: interactive elements get refs like [e3] for browser_click / browser_type, plus visible text. Use after navigation or actions.',
    input_schema: { type: 'object', properties: { max_chars: { type: 'number' } } } },
  { name: 'browser_click', description: 'Click an element by ref from browser_snapshot (e.g. "e3") or a CSS selector.',
    input_schema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } },
  { name: 'browser_type', description: 'Type text into an element by ref or CSS selector (focuses it first). Set submit=true to press Enter afterwards.',
    input_schema: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] } },
  { name: 'browser_press', description: 'Press a keyboard key in the page: Enter, Tab, Escape, Backspace, ArrowDown, … Optional modifiers: "cmd+a", "ctrl+f".',
    input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'browser_scroll', description: 'Scroll the page: direction up | down | top | bottom, amount in pixels (default 600).',
    input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] }, amount: { type: 'number' } }, required: ['direction'] } },
  { name: 'browser_back', description: 'Go back in history.', input_schema: { type: 'object', properties: {} } },
  { name: 'browser_screenshot', description: 'Screenshot of the current viewport (PNG). Returned as an image when the model supports vision; the file is also saved under vault/screenshots/.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'browser_eval', description: 'Run JavaScript in the page and return the result (JSON). Use for reading data the snapshot does not show.',
    input_schema: { type: 'object', properties: { js: { type: 'string' } }, required: ['js'] } },
]);

/** 시스템 크롬 계열 실행 파일(순수 탐색) — env ARGO_CHROME_PATH가 우선. */
export function findChrome(env = process.env, platform = process.platform) {
  if (env.ARGO_CHROME_PATH && existsSync(env.ARGO_CHROME_PATH)) return env.ARGO_CHROME_PATH;
  const c = platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ] : platform === 'win32' ? [
    join(env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'), join(env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'), join(env.PROGRAMFILES ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    join(env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return c.find((p) => p && existsSync(p)) ?? null;
}

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 최소 CDP 클라이언트 — 전역 WebSocket, flatten 세션. */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(`CDP ${m.error.message}`)) : res(m.result ?? {}); }
      else if (m.method) for (const fn of this.listeners.get(`${m.sessionId ?? ''}:${m.method}`) ?? []) fn(m.params); };
    ws.onclose = () => { for (const { rej } of this.pending.values()) rej(new Error('CDP connection closed')); this.pending.clear(); };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  on(sessionId, method, fn) { const k = `${sessionId ?? ''}:${method}`; if (!this.listeners.has(k)) this.listeners.set(k, new Set()); this.listeners.get(k).add(fn); return () => this.listeners.get(k)?.delete(fn); }
  close() { try { this.ws.close(); } catch { /* 이미 닫힘 */ } }
}

// 스냅샷 — 상호작용 요소에 data-argo-ref="eN"을 달고 [eN] 한 줄씩 + 보이는 텍스트 블록(중복·공백 정리). 페이지 안에서 실행된다.
const SNAPSHOT_JS = (maxChars) => `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const lines = []; let n = 0;
  const sel = 'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [contenteditable="true"], [onclick]';
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue; n += 1; const ref = 'e' + n; el.setAttribute('data-argo-ref', ref);
    const tag = el.tagName.toLowerCase(); const type = el.getAttribute('type') || ''; const role = el.getAttribute('role') || '';
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.value || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const href = tag === 'a' ? ' → ' + (el.getAttribute('href') || '').slice(0, 100) : '';
    lines.push('[' + ref + '] ' + (role || tag) + (type ? ':' + type : '') + ' "' + label + '"' + href);
    if (lines.length >= 300) break;
  }
  const text = (document.body?.innerText || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
  const head = 'TITLE: ' + document.title + '\\nURL: ' + location.href + '\\n';
  const out = head + '\\n## Interactive (' + n + ')\\n' + lines.join('\\n') + '\\n\\n## Text\\n' + text;
  return out.length > ${maxChars} ? out.slice(0, ${maxChars}) + '\\n…[truncated]' : out;
})()`;

const KEYS = { enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, tab: { key: 'Tab', code: 'Tab', keyCode: 9 }, escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 }, delete: { key: 'Delete', code: 'Delete', keyCode: 46 }, space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }, arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 }, end: { key: 'End', code: 'End', keyCode: 35 }, pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 }, pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 } };
/** "cmd+shift+a" → CDP 키 이벤트 인자(순수) */
export function parseKeyCombo(combo) {
  const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean);
  const name = parts.pop() ?? ''; let modifiers = 0;
  for (const m of parts.map((s) => s.toLowerCase())) { if (m === 'alt' || m === 'option') modifiers |= 1; if (m === 'ctrl' || m === 'control') modifiers |= 2; if (m === 'meta' || m === 'cmd' || m === 'command') modifiers |= 4; if (m === 'shift') modifiers |= 8; }
  const k = KEYS[name.toLowerCase()];
  if (k) return { ...k, modifiers };
  if (name.length === 1) return { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: modifiers ? undefined : name, modifiers };
  return { key: name, code: name, keyCode: 0, modifiers };
}

/** 워크스페이스별 브라우저 세션(프로세스 싱글턴 맵) — 첫 사용 시 크롬을 띄우고 idle 뒤 정리한다. */
const sessions = new Map();
export class BrowserSession {
  static profileDir(wsId, env = process.env) { const root = env.ARGO_ROOT ? dirname(env.ARGO_ROOT) : join(homedir(), '.argo'); return join(root, 'browser', wsId); }
  static async get(wsId, { env = process.env, headless = env.ARGO_BROWSER_HEADLESS === '1' } = {}) {
    let s = sessions.get(wsId);
    if (s && s.alive) { s.touch(); return s; }
    s = new BrowserSession(wsId, { env, headless }); sessions.set(wsId, s); await s.launch(); return s;
  }
  constructor(wsId, { env, headless }) { this.wsId = wsId; this.env = env; this.headless = headless; this.alive = false; this.idleMs = 5 * 60_000; }
  touch() { clearTimeout(this.timer); this.timer = setTimeout(() => this.close().catch(() => {}), this.idleMs); this.timer.unref?.(); }
  async launch() {
    const bin = findChrome(this.env);
    if (!bin) throw new Error('Chrome/Chromium/Edge/Brave를 찾지 못했습니다 — 설치하거나 ARGO_CHROME_PATH로 경로를 지정하세요(대안: 스킬·도구의 브라우저 MCP)');
    const profile = BrowserSession.profileDir(this.wsId, this.env); await mkdir(profile, { recursive: true });
    const port = await freePort();
    // --use-mock-keychain / --password-store=basic: OS 키체인을 건드리지 않는다 — 없으면 macOS가 "'Chrome'을 저장할 키체인을 찾을 수 없습니다" 대화상자를
    // 띄운다(실사고 2026-09-05: 테스트·배터리가 반복 실행하며 유건 화면에 계속 뜸). Playwright·Puppeteer의 기본 인자와 같다. 쿠키·로그인은 프로필 안에 유지된다.
    this.child = spawn(bin, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking', '--window-size=1280,900',
      '--use-mock-keychain', '--password-store=basic', '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication', '--disable-component-update',
      ...(this.headless ? ['--headless=new', '--hide-scrollbars'] : []), 'about:blank'], { stdio: 'ignore', detached: false, windowsHide: true });
    this.child.on('exit', () => { this.alive = false; sessions.delete(this.wsId); this.cdp?.close(); });
    let info = null;
    for (let i = 0; i < 60 && !info; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) info = await r.json(); } catch { /* 부팅 중 */ } if (!info) await sleep(250); }
    if (!info) { this.child.kill(); throw new Error('브라우저가 15초 안에 뜨지 않았습니다'); }
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 연결 실패')); });
    this.cdp = new Cdp(ws);
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.sid = sessionId; this.targetId = targetId;
    await this.cdp.send('Page.enable', {}, sessionId); await this.cdp.send('Runtime.enable', {}, sessionId);
    this.alive = true; this.touch();
  }
  async close() { clearTimeout(this.timer); this.alive = false; sessions.delete(this.wsId); try { this.cdp?.close(); } catch { /* */ } try { this.child?.kill(); } catch { /* */ } }
  send(method, params) { return this.cdp.send(method, params, this.sid); }
  /** 페이지 안 JS 실행 — Node eval이 아니라 CDP Runtime.evaluate(브라우저 컨텍스트). browser_eval 도구의 실체이며 Hermes browser_exec·OpenClaw와 같은 능력.
      결과는 값으로만 돌아오고 Argo 프로세스에는 닿지 않는다. */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async navigate(url) {
    const u = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    if (!/^https?:\/\//i.test(u)) throw new Error('http(s) URL만 열 수 있습니다');
    const loaded = new Promise((res) => { const off = this.cdp.on(this.sid, 'Page.loadEventFired', () => { off(); res(); }); setTimeout(() => { off(); res(); }, 20_000); });
    const r = await this.send('Page.navigate', { url: u }); if (r.errorText) throw new Error(`navigate failed: ${r.errorText}`);
    await loaded; await sleep(300);
    return this.snapshot(4000);
  }
  snapshot(maxChars = 20_000) { this.touch(); return this.evaluate(SNAPSHOT_JS(Math.max(500, Number(maxChars) || 20_000))); }
  async rectOf(ref) {
    const q = /^e\d+$/.test(ref) ? `[data-argo-ref="${ref}"]` : ref;
    const rect = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(q)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!rect) throw new Error(`element not found: ${ref} — run browser_snapshot for fresh refs`);
    return { q, ...rect };
  }
  async click(ref) {
    const { x, y } = await this.rectOf(ref);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(400); this.touch();
    return `clicked ${ref}\n${(await this.snapshot(3000))}`;
  }
  async type(ref, text, submit = false) {
    const { q } = await this.rectOf(ref);
    await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(q)}); el.focus(); if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    await this.send('Input.insertText', { text: String(text) });
    if (submit) await this.press('Enter');
    await sleep(200); this.touch();
    return `typed into ${ref}${submit ? ' + Enter' : ''}`;
  }
  async press(combo) {
    const k = parseKeyCombo(combo);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(300); this.touch();
    return `pressed ${combo}`;
  }
  async scroll(direction, amount = 600) {
    const a = Math.max(1, Number(amount) || 600);
    const js = direction === 'top' ? 'window.scrollTo(0,0)' : direction === 'bottom' ? 'window.scrollTo(0, document.body.scrollHeight)' : `window.scrollBy(0, ${direction === 'up' ? -a : a})`;
    await this.evaluate(js); await sleep(200); this.touch();
    return `scrolled ${direction}\n${await this.snapshot(3000)}`;
  }
  async back() { await this.evaluate('history.back()'); await sleep(800); this.touch(); return this.snapshot(3000); }
  async screenshotPng() { const r = await this.send('Page.captureScreenshot', { format: 'png' }); this.touch(); return Buffer.from(r.data, 'base64'); }
}

/** 실행기 — 이미지 반환은 호출부(native-query)가 모델의 비전 지원 여부로 이미지 블록/파일 경로를 결정한다. */
export function browserRunners({ wsId, env = process.env, headless }) {
  const get = () => BrowserSession.get(wsId, { env, headless });
  return {
    browser_navigate: async ({ url }) => (await get()).navigate(String(url)),
    browser_snapshot: async ({ max_chars }) => (await get()).snapshot(max_chars),
    browser_click: async ({ ref }) => (await get()).click(String(ref)),
    browser_type: async ({ ref, text, submit }) => (await get()).type(String(ref), String(text ?? ''), !!submit),
    browser_press: async ({ key }) => (await get()).press(String(key)),
    browser_scroll: async ({ direction, amount }) => (await get()).scroll(String(direction), amount),
    browser_back: async () => (await get()).back(),
    browser_screenshot: async () => ({ image: await (await get()).screenshotPng(), mime: 'image/png' }),
    browser_eval: async ({ js }) => { const v = await (await get()).evaluate(String(js)); return typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 0).slice(0, 30_000); },
  };
}

export async function closeBrowser(wsId) { const s = sessions.get(wsId); if (s) await s.close(); }
export async function closeAllBrowsers() { for (const s of [...sessions.values()]) await s.close().catch(() => {}); }
