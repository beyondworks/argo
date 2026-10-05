// 시작 파일(src/main.jsx)의 boot — 메일 연결 복귀 화면에서 데스크톱 넘김 코드를 못 받아도 화면을 그리는지(분리 검수 의심 2),
// 그린 뒤 한가할 때 보낼 목록의 서버 전송 코드를 미리 받는지(의심 1 — 처음 보낼 때 오프라인이면 새로고침 전까지 실패가 남는다).
// main.jsx의 시작 함수들만 꺼내(babel·esbuild) 브라우저 대역을 넣고 실행한다. 동적 import는 대역(__import)으로 바꾼다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';

const src = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const want = new Set(['desktopAuth', 'mailRelay', 'warmTransport', 'boot']);
const parts = parse(src, { sourceType: 'module', plugins: ['jsx'] }).program.body
  .filter((n) => (n.type === 'FunctionDeclaration' && want.has(n.id.name)) || (n.type === 'VariableDeclaration' && n.declarations.some((d) => want.has(d.id.name))))
  .map((n) => src.slice(n.start, n.end)).join('\n');
const code = transformSync(parts, { loader: 'jsx', jsx: 'transform', jsxFactory: 'h', format: 'cjs' }).code.replace(/\bimport\(/g, '__import(');

function run({ path = '/me/mail/connect', desktop = false, modules = {}, idle = true } = {}) {
  const log = { rendered: 0, imports: [], warns: [], idle: [], timers: [], session: 0 };
  const __import = (spec) => { log.imports.push(spec); const m = modules[spec]; return m instanceof Error ? Promise.reject(m) : Promise.resolve(m ?? {}); };
  const window = idle ? { requestIdleCallback: (fn) => log.idle.push(fn) } : {};
  const setTimeout = (fn) => log.timers.push(fn);
  const console = { warn: (...a) => log.warns.push(a.join(' ')) };
  const boot = new Function('__import', 'h', 'App', 'createRoot', 'document', 'isDesktop', 'location', 'initSession', 'window', 'setTimeout', 'console', `${code}\nreturn boot;`)(
    __import, () => null, () => null, () => ({ render: () => { log.rendered++; } }), { getElementById: () => ({}) }, () => desktop, { pathname: path }, async () => { log.session++; }, window, setTimeout, console);
  return { boot, log };
}
const flush = () => new Promise((r) => setImmediate(r));

test('메일 연결 복귀 화면: 넘김 코드를 못 받으면 경고만 남기고 화면을 그린다', async () => {
  const { boot, log } = run({ modules: { './core/desktop-auth.js': new Error('Failed to fetch dynamically imported module') } });
  await boot();
  assert.equal(log.rendered, 1);
  assert.match(log.warns.join('\n'), /mail relay failed/);
  assert.equal(log.session, 1, '그 뒤 로그인 확인도 이어진다');
});

test('메일 연결 복귀 화면: 넘기기가 예외를 던져도 그리고, 넘겼으면(true) 그리지 않는다', async () => {
  const thrown = run({ modules: { './core/desktop-auth.js': { initMailRelay: async () => { throw new Error('desktop_auth_state'); } } } });
  await thrown.boot();
  assert.equal(thrown.log.rendered, 1);
  const handed = run({ modules: { './core/desktop-auth.js': { initMailRelay: async () => true } } });
  await handed.boot();
  assert.equal(handed.log.rendered, 0, '데스크톱 앱으로 넘긴 화면은 그대로 둔다');
  const other = run({ path: '/me' });
  await other.boot();
  assert.equal(other.log.rendered, 1);
  assert.ok(!other.log.imports.includes('./core/desktop-auth.js'), '다른 화면에서는 넘김 코드를 받지 않는다');
});

test('그린 뒤 한가할 때 서버 전송 코드를 미리 받는다 — requestIdleCallback이 없으면 setTimeout, 실패해도 조용히', async () => {
  const { boot, log } = run({ path: '/me', modules: { './core/transport.js': new Error('offline') } });
  await boot();
  assert.equal(log.idle.length, 1);
  assert.ok(!log.imports.includes('./core/transport.js'), '그리기 전에는 받지 않는다(첫 화면을 늦추지 않게)');
  log.idle[0]();
  await flush();
  assert.ok(log.imports.includes('./core/transport.js'));
  const old = run({ path: '/me', idle: false });
  await old.boot();
  assert.equal(old.log.timers.length, 1); old.log.timers[0]();
  assert.ok(old.log.imports.includes('./core/transport.js'));
});
