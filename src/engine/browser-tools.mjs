// 브라우저 유즈(네이티브 엔진 내장) — Argo 전용 크롬 프로필을 띄우고 CDP(Chrome DevTools Protocol)로 제어한다.
// Hermes(browser_* 도구 13종, CDP 백엔드)·OpenClaw(browser 확장, CDP·확장 릴레이)와 같은 구조: 러너·모델과 무관하게 같은 도구·같은 게이트.
// 회사·크루별 전용 프로필, 실행별 탭. 개인/기존 회사 프로필을 복사하지 않는다. 프로필은 동기화 대상 밖이다.
// 의존성 0: Node 22의 전역 WebSocket + 시스템 크롬(Chrome/Chromium/Edge/Brave). 없으면 도구가 정직한 오류를 돌려준다(마켓의 브라우저 MCP가 대안).
import { spawn } from 'node:child_process';
import { IMAGE_MAX_B64 } from './session.mjs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { detectEgoBrowser, selectIsolatedBrowserProvider } from './ego-browser-provider.mjs';

import { BROWSER_SPECS } from './browser-specs.mjs';
export { BROWSER_SPECS } from './browser-specs.mjs';

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

/** 디버깅 포트 준비 대기 상한 — Puppeteer 기본(30초)의 2배. 윈도우 콜드 스타트+Defender 검사+병렬 부하 여유. */
const LAUNCH_TIMEOUT_MS = 60_000;
/** 스크린샷 품질 사다리 (JPEG 품질, 배율) — 마지막 단계는 상한을 넘겨도 채택(그래도 300KB 안팎). */
const SHOT_LADDER = [[70, 1], [50, 0.75], [35, 0.5]];
/** stderr 누적 버퍼에서 완결된 'DevTools listening on ws://…' 줄만 채택(순수) — 줄 종료가 없으면 아직 조각이다. */
export const devToolsUrlFrom = (acc) => acc.match(/DevTools listening on (ws:\/\/\S+)\r?\n/)?.[1] ?? null;
/** 프로필의 DevToolsActivePort 파일(1행 포트, 2행 /devtools/browser/<id>) — 두 행이 다 있어야 채택(쓰는 중 조각 방지). */
export async function devToolsUrlFromFile(profile) {
  try { const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/); return /^\d+$/.test(port ?? '') && path?.startsWith('/') ? `ws://127.0.0.1:${port}${path}` : null; } catch { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 최소 CDP 클라이언트 — 전역 WebSocket, flatten 세션. */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.method === 'Target.detachedFromTarget') for (const [id, pending] of this.pending) {
        if (pending.sessionId === m.params?.sessionId) { this.pending.delete(id); pending.rej(new Error('Browser task tab closed')); }
      }
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(`CDP ${m.error.message}`)) : res(m.result ?? {}); }
      else if (m.method) for (const fn of this.listeners.get(`${m.sessionId ?? ''}:${m.method}`) ?? []) fn(m.params); };
    ws.onclose = () => { for (const { rej } of this.pending.values()) rej(new Error('CDP connection closed')); this.pending.clear(); };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser command timed out')); }, 30_000); timer.unref?.();
      const res = (value) => { clearTimeout(timer); resolve(value); }; const rej = (error) => { clearTimeout(timer); reject(error); };
      this.pending.set(id, { res, rej, sessionId });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (e) { this.pending.delete(id); rej(e); }
    });
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

/** 크루별 브라우저 프로세스 — 모든 러너의 MCP도 호스트의 이 맵을 공유한다. */
const sessions = new Map();
const launching = new Map(); // wsId → 기동 중 Promise
const children = new Set(); // 살아 있는 크롬 자식 전수 — 프로세스 종료 시 동기 스위퍼(4R MEDIUM: 재배포마다 고아가 쌓이면 SingletonLock으로 그 회사 브라우저가 막힌다)
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* */ } } });
/** 테스트 전용 — 세션 map(축출 가드 핀). */
export const _sessionsForTest = () => sessions;
export const BROWSER_LOGIN_ERRORS = Object.freeze({
  BROWSER_LOGIN_PAUSED: 'Browser login handed off to the user. Further automation in this run is disabled; continue in a new work run after sign-in.',
  BROWSER_LOGIN_PENDING: 'This agent already has a login tab waiting for the user. Complete sign-in and close that tab first.',
  BROWSER_LOGIN_PAGE_REQUIRED: 'Open the required service login page in this work tab first.',
  BROWSER_LOGIN_HEADLESS: 'Login handoff is unavailable in a headless browser. Use a visible browser on the execution device; mobile remote control is not available.',
});
const loginError = (code) => Object.assign(new Error(BROWSER_LOGIN_ERRORS[code]), { code });
export class BrowserSession {
  static profileDir(wsId, env = process.env, slug = '') { const root = env.ARGO_ROOT ? dirname(env.ARGO_ROOT) : join(homedir(), '.argo'); return slug ? join(root, 'browser', 'agents', scopeHash([wsId, slug])) : join(root, 'browser', wsId); }
  static peek(wsId, { env = process.env, slug = '' } = {}) { return sessions.get(slug ? BrowserSession.profileDir(wsId, env, slug) : wsId); }
  static async get(wsId, { env = process.env, headless = env.ARGO_BROWSER_HEADLESS === '1', slug = '' } = {}) {
    const key = slug ? BrowserSession.profileDir(wsId, env, slug) : wsId;
    const s = sessions.get(key);
    if (s?.closing) { await s.closing; return BrowserSession.get(wsId, { env, headless, slug }); }
    if (s && s.alive) { s.touch(); return s; }
    // 기동 중 뮤텍스 — 같은 회사 두 크루가 동시에 부르면 프로필 SingletonLock 경합으로 둘 다 실패하고, 실패한 기동이 map에서 산 세션을
    // 밀어내 그 회사 브라우저가 계속 실패했다(분리 검수 MEDIUM-1 실측). 진행 중인 기동 약속을 공유한다.
    if (launching.has(key)) return launching.get(key);
    const p = (async () => {
      const n = new BrowserSession(wsId, { env, headless, slug });
      try { await n.launch(); sessions.set(key, n); return n; } catch (e) { await n.close(); throw e; } finally { launching.delete(key); }
    })();
    launching.set(key, p); return p;
  }
  constructor(wsId, { env, headless, slug = '' }) { this.wsId = wsId; this.slug = slug; this.env = env; this.headless = headless; this.key = slug ? BrowserSession.profileDir(wsId, env, slug) : wsId; this.pages = new Map(); this.pageStarts = new Map(); this.humanLoginPages = new Map(); this.handedOffRuns = new Set(); this.alive = false; this.idleMs = 5 * 60_000; }
  touch() { clearTimeout(this.timer); if (this.humanLoginPages.size) return; this.timer = setTimeout(() => this.close().catch(() => {}), this.idleMs); this.timer.unref?.(); }
  async launch() {
    const bin = findChrome(this.env);
    if (!bin) throw new Error('Chrome/Chromium/Edge/Brave를 찾지 못했습니다 — 설치하거나 ARGO_CHROME_PATH로 경로를 지정하세요(대안: 스킬·도구의 브라우저 MCP)');
    const profile = BrowserSession.profileDir(this.wsId, this.env, this.slug); await mkdir(profile, { recursive: true, mode: 0o700 });
    // 잔재 DevToolsActivePort(비정상 종료가 남김)를 스폰 전에 지운다 — 남아 있으면 죽은 포트를 채택해 127ms 만에 'CDP 연결 실패'로 죽고(4R 검수 HIGH),
    // 고아 크롬이 그 파일을 덮어 그 회사 브라우저가 계속 고장난다. Playwright도 같은 이유로 스폰 전에 지운다.
    await rm(join(profile, 'DevToolsActivePort'), { force: true }).catch(() => {});
    // --use-mock-keychain / --password-store=basic: OS 키체인을 건드리지 않는다 — 없으면 macOS가 "'Chrome'을 저장할 키체인을 찾을 수 없습니다" 대화상자를
    // 띄운다(실사고 2026-09-05: 테스트·배터리가 반복 실행하며 유건 화면에 계속 뜸). Playwright·Puppeteer의 기본 인자와 같다. 쿠키·로그인은 프로필 안에 유지된다.
    // stderr는 진단용 꼬리만 보관(값 없음 — 크롬은 'DevTools listening' 정도만 쓴다). 파이프는 반드시 소비한다(안 읽으면 크롬이 막힌다).
    const tail = [];
    this.child = spawn(bin, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking', '--window-size=1280,900',
      '--use-mock-keychain', '--password-store=basic', '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication', '--disable-component-update',
      ...(this.headless ? ['--headless=new', '--hide-scrollbars'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: false, windowsHide: true });
    // 포트는 크롬이 고른다(--remote-debugging-port=0) — 우리가 먼저 빈 포트를 고르면 병렬 프로세스가 그 사이 차지할 수 있다(윈도우 CI 실사고:
    // 크롬은 살아 있는데 /json/version 무응답 60초). 주소는 크롬이 stderr에 찍는 'DevTools listening on ws://…' 줄에서 읽는다(Puppeteer·Playwright 동일).
    let wsUrl = null; let acc = '';
    // 누적 버퍼 + 줄 종료 요구 — 파이프 청크가 URL 중간에서 갈라지면 잘린 주소를 채택해 'CDP 연결 실패'로 죽는다(분리 검수 MEDIUM-3 실측).
    this.child.stderr.on('data', (d) => { const t = String(d); tail.push(t); if (tail.length > 20) tail.shift(); acc = (acc + t).slice(-64_000); if (!wsUrl) wsUrl = devToolsUrlFrom(acc); });
    let spawnErr = null; let exited = null;
    this.child.on('error', (e) => { spawnErr = e; });
    children.add(this.child);
    this.child.on('exit', (code, sig) => { exited = { code, sig }; children.delete(this.child); this.alive = false; if (sessions.get(this.key) === this) sessions.delete(this.key); this.cdp?.close(); }); // map 가드 — 남의 산 세션을 밀어내지 않는다
    // 준비 판정은 시간 기준(LAUNCH_TIMEOUT_MS). 실행 오류·조기 종료는 상한을 기다리지 않고 즉시 실패로 돌린다(원인이 문구에 실린다).
    const diag = () => { const t = tail.join('').trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400); return t ? ` — stderr: ${t}` : ''; };
    const t0 = Date.now();
    while (!wsUrl && Date.now() - t0 < LAUNCH_TIMEOUT_MS) {
      if (spawnErr) throw new Error(`브라우저 실행 실패: ${spawnErr.message}`);
      if (exited) throw new Error(`브라우저가 뜨자마자 종료됐습니다(code ${exited.code ?? exited.sig})${diag()}`);
      // 폴백: 크롬이 프로필에 쓰는 DevToolsActivePort(1행 포트·2행 브라우저 경로) — stderr 버퍼링과 무관(Playwright 방식)
      if (!wsUrl) wsUrl = await devToolsUrlFromFile(profile);
      await sleep(100);
    }
    if (!wsUrl) { await this.kill(); throw new Error(`브라우저가 ${Math.round(LAUNCH_TIMEOUT_MS / 1000)}초 안에 뜨지 않았습니다${diag()}`); }
    const ws = new WebSocket(wsUrl);
    try { await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`CDP 연결 실패(${wsUrl})${diag()}`)); }); }
    catch (e) { this.kill(); throw e; } // 연결 실패도 자식을 남기지 않는다(4R: 고아 크롬이 SingletonLock을 쥐면 다음 기동도 실패)
    this.cdp = new Cdp(ws);
    this.cdp.on('', 'Target.targetDestroyed', ({ targetId }) => {
      if (this.humanLoginPages.delete(targetId)) this.touch();
    });
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.sid = sessionId; this.targetId = targetId;
    await this.cdp.send('Page.enable', {}, sessionId); await this.cdp.send('Runtime.enable', {}, sessionId);
    this.alive = true; this.touch();
  }
  /** 자식 종료 — SIGTERM 뒤 최대 1.5초 기다렸다가 살아 있으면 SIGKILL(await — unref 타이머는 프로세스가 먼저 끝나면 안 발화해 고아를 남겼다, 4R MEDIUM). */
  async kill() {
    const c = this.child; if (!c || c.exitCode !== null || c.signalCode !== null) return;
    try { c.kill(); } catch { /* */ }
    let t; await Promise.race([new Promise((r) => c.once('exit', r)), new Promise((r) => { t = setTimeout(r, 1500); t.unref?.(); })]); clearTimeout(t); // 타이머가 프로세스 종료를 붙잡지 않게(5R LOW)
    if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGKILL'); } catch { /* */ } }
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      clearTimeout(this.timer); this.alive = false;
      this.pages.clear(); this.humanLoginPages.clear(); this.handedOffRuns.clear();
      // Windows child.kill() terminates Chrome without flushing newly connected accounts.
      // Request normal browser shutdown first; only an unresponsive process is killed.
      const child = this.child;
      if (this.cdp && child && child.exitCode === null && child.signalCode === null) {
        let commandTimer;
        await Promise.race([this.cdp.send('Browser.close').catch(() => {}), new Promise((resolve) => { commandTimer = setTimeout(resolve, 1500); })]);
        clearTimeout(commandTimer);
        if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => {
          let timer;
          const finish = () => { clearTimeout(timer); child.off('exit', finish); resolve(); };
          child.once('exit', finish); timer = setTimeout(finish, 3500);
        });
      }
      try { this.cdp?.close(); } catch { /* Already disconnected. */ }
      await this.kill();
      if (sessions.get(this.key) === this) sessions.delete(this.key);
    })();
    return this.closing;
  }
  async page(runId) {
    if (this.handedOffRuns.has(runId)) throw loginError('BROWSER_LOGIN_PAUSED');
    if (this.pages.has(runId)) return this.pages.get(runId);
    if (this.pageStarts.has(runId)) return this.pageStarts.get(runId);
    const promise = (async () => {
      const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
      try {
        const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await this.cdp.send('Page.enable', {}, sessionId); await this.cdp.send('Runtime.enable', {}, sessionId);
        const page = Object.create(this);
        page.sid = sessionId; page.targetId = targetId; page.touch = () => this.touch();
        this.pages.set(runId, page); return page;
      } catch (e) { await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {}); throw e; }
    })().finally(() => this.pageStarts.delete(runId));
    this.pageStarts.set(runId, promise); return promise;
  }
  async closePage(runId) {
    await this.pageStarts.get(runId)?.catch(() => {});
    const page = this.pages.get(runId); if (!page) return;
    this.pages.delete(runId);
    await this.cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
  }
  handOffLogin(runId) {
    if (this.humanLoginPages.size) throw loginError('BROWSER_LOGIN_PENDING');
    const page = this.pages.get(runId);
    if (!page) throw loginError('BROWSER_LOGIN_PAGE_REQUIRED');
    this.pages.delete(runId); this.humanLoginPages.set(page.targetId, page); this.handedOffRuns.add(runId);
    this.touch();
  }
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
    let off; let timer;
    const loaded = new Promise((res) => { const finish = () => { off?.(); clearTimeout(timer); res(); }; off = this.cdp.on(this.sid, 'Page.loadEventFired', finish); timer = setTimeout(finish, 20_000); timer.unref?.(); });
    try { const r = await this.send('Page.navigate', { url: u }); if (r.errorText) throw new Error(`navigate failed: ${r.errorText}`); await loaded; }
    finally { off?.(); clearTimeout(timer); }
    await sleep(300);
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
  /** JPEG 스크린샷 — 전사 상한(IMAGE_MAX_B64) 안에 들 때까지 품질·배율을 낮춘다(4R MEDIUM: 색 밀도 높은 페이지는 q70도 상한을 넘겨 이미지가 통째로 버려졌다). */
  async screenshotJpeg(maxB64 = IMAGE_MAX_B64) {
    let out = null;
    for (const [quality, scale] of SHOT_LADDER) {
      const { layoutViewport: v } = await this.send('Page.getLayoutMetrics');
      // clip은 문서 좌표 — 스크롤 위치(pageX/pageY)를 넣지 않으면 스크롤된 페이지에서 뷰포트 밖(백지)을 찍는다(5R 검수 HIGH 픽셀 실측)
      const clip = scale < 1 && v ? { clip: { x: v.pageX ?? 0, y: v.pageY ?? 0, width: v.clientWidth, height: v.clientHeight, scale } } : {};
      const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality, ...clip });
      out = Buffer.from(r.data, 'base64');
      if (out.toString('base64').length <= maxB64) break;
    }
    this.touch(); return out;
  }
}

/** 실행기 — 이미지 반환은 호출부(native-query)가 모델의 비전 지원 여부로 이미지 블록/파일 경로를 결정한다. */
const scopeHash = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const workQueues = new Map();
export function createBrowserStatusReader({ probe = detectEgoBrowser, now = Date.now, ttlMs = 60_000 } = {}) {
  const probes = new Map();
  return async ({ wsId, slug, env = process.env, connected = false }) => {
    const requested = env.ARGO_BROWSER_PROVIDER === 'ego' ? 'ego' : 'chromium';
    const selection = await selectIsolatedBrowserProvider({ requested, wsId, slug, probe: async () => {
      // The capability check needs the executable environment, not agent/provider credentials.
      const probeEnv = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
      const key = JSON.stringify(probeEnv); const cached = probes.get(key);
      if (cached && cached.expires > now()) return cached.promise;
      if (probes.size >= 8) probes.delete(probes.keys().next().value);
      const promise = Promise.resolve().then(() => probe({ env: probeEnv, timeoutMs: 5000 })).catch(() => ({ available: false, reason: 'ego_probe_failed' }));
      probes.set(key, { promise, expires: now() + ttlMs }); return promise;
    } });
    return {
      provider: selection.provider, requestedProvider: requested, supportedBrowserAvailable: !!findChrome(env), connected,
      agentProfileIsolated: !!slug, workTabIsolated: !!slug, fallbackReason: selection.reason ?? null,
      accountConnection: 'Connect only needed accounts in this agent browser on the execution device. Personal and other agent logins are not copied.',
    };
  };
}
const readBrowserStatus = createBrowserStatusReader();
export function browserRunners({ wsId, slug = '', runId = randomUUID(), env = process.env, headless, statusReader = readBrowserStatus }) {
  let owner; let closed = false; let handedOff = false; let queue = Promise.resolve();
  const workKey = scopeHash([BrowserSession.profileDir(wsId, env, slug), runId]);
  const get = async () => {
    if (closed) throw new Error('Browser task closed');
    owner = await BrowserSession.get(wsId, { env, headless, slug });
    if (closed) throw new Error('Browser task closed');
    const page = slug ? await owner.page(runId) : owner;
    if (closed) { if (slug) await owner.closePage(runId); throw new Error('Browser task closed'); }
    return page;
  };
  const actions = {
    browser_status: async () => {
      const session = owner ?? BrowserSession.peek(wsId, { env, slug });
      return JSON.stringify({ ...await statusReader({ wsId, slug, env, connected: owner?.alive === true }),
        humanLoginPending: session?.alive === true && session.humanLoginPages.size > 0,
        humanLoginAvailable: !(session?.headless ?? headless ?? (env.ARGO_BROWSER_HEADLESS === '1')),
        automationPausedForLogin: handedOff || session?.handedOffRuns.has(runId) === true,
      });
    },
    browser_request_login: async () => {
      if (!slug || !owner?.pages.has(runId)) throw loginError('BROWSER_LOGIN_PAGE_REQUIRED');
      if (owner.headless) throw loginError('BROWSER_LOGIN_HEADLESS');
      if (!['http:', 'https:'].includes(await owner.pages.get(runId).evaluate('location.protocol'))) throw loginError('BROWSER_LOGIN_PAGE_REQUIRED');
      owner.handOffLogin(runId); handedOff = true;
      return 'The login tab is reserved for you and will remain open after this turn. Sign in only to the needed account in the agent browser on the execution device, then close that login tab and send a new message to continue. Browser automation in this run has stopped. Mobile cannot remotely control that browser.';
    },
    browser_navigate: async ({ url }) => (await get()).navigate(String(url)),
    browser_snapshot: async ({ max_chars }) => (await get()).snapshot(max_chars),
    browser_click: async ({ ref }) => (await get()).click(String(ref)),
    browser_type: async ({ ref, text, submit }) => (await get()).type(String(ref), String(text ?? ''), !!submit),
    browser_press: async ({ key }) => (await get()).press(String(key)),
    browser_scroll: async ({ direction, amount }) => (await get()).scroll(String(direction), amount),
    browser_back: async () => (await get()).back(),
    browser_screenshot: async () => ({ image: await (await get()).screenshotJpeg(), mime: 'image/jpeg' }),
    browser_eval: async ({ js }) => { const v = await (await get()).evaluate(String(js)); return typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 0).slice(0, 30_000); },
  };
  const runners = Object.fromEntries(Object.entries(actions).map(([name, action]) => [name, (input = {}, { signal } = {}) => {
    const execute = async () => {
      signal?.throwIfAborted();
      if (closed) throw new Error('Browser task closed');
      if ((handedOff || BrowserSession.peek(wsId, { env, slug })?.handedOffRuns.has(runId)) && name !== 'browser_status') throw loginError('BROWSER_LOGIN_PAUSED');
      let rejectAborted;
      const aborted = new Promise((_, reject) => { rejectAborted = reject; });
      const abort = () => { closed = true; if (slug) owner?.closePage(runId).catch(() => {}); rejectAborted(signal.reason ?? new Error('Browser task cancelled')); };
      signal?.addEventListener('abort', abort, { once: true });
      try { const result = await Promise.race([action(input), aborted]); signal?.throwIfAborted(); return result; }
      catch (e) { if (/timed out/.test(String(e?.message))) { closed = true; if (slug) await owner?.closePage(runId); } throw e; }
      finally { signal?.removeEventListener('abort', abort); }
    };
    const result = (slug ? workQueues.get(workKey) ?? Promise.resolve() : queue).then(execute);
    queue = result.catch(() => {});
    if (slug) { const pending = queue; workQueues.set(workKey, pending); pending.then(() => { if (workQueues.get(workKey) === pending) workQueues.delete(workKey); }); }
    return result;
  }]));
  Object.defineProperty(runners, 'close', { value: async () => { closed = true; if (slug && owner) await owner.closePage(runId); } });
  return runners;
}

export async function closeBrowser(wsId) { for (const s of [...sessions.values()]) if (s.wsId === wsId) await s.close(); }
export async function closeAllBrowsers() { await Promise.allSettled([...launching.values()]); for (const s of [...sessions.values()]) await s.close().catch(() => {}); }
