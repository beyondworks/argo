// 부트 프로브(public/boot.js) 행동 핀 — 윈도 실기기 버그(무응답 선점 → 영구 대기)의 재발 방지.
// 분리 검수(2026-08-30)가 실증한 vm 하네스 방식: boot.js를 그대로 올리고 document/fetch/타이머를
// 스텁해 프로브 진행성·상한 이원화·단일 교체를 브라우저 없이 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public', 'boot.js');

function load({ fetchImpl, hasAC = true, now = null, navigator: nav = null, localStorage: ls = null }) {
  const el = () => ({ textContent: '', hidden: true, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const els = { status: el(), fill: el(), logtail: el(), err: el(), title: el(), bar: el() };
  const docEl = { lang: 'en' };
  const listeners = {};
  const timers = [];
  const intervals = []; // 진행률 크리프·느린 부팅 안내 틱(500ms) — 테스트가 직접 돌린다
  const ctx = {
    console,
    document: { getElementById: (id) => els[id], documentElement: docEl },
    location: { search: '', replace: (u) => { ctx.__navigated = u; } },
    // 타이머 핸들은 1부터(0이면 boot.js의 `if (timer)` 진위 검사가 거짓 실패 — 검수 하네스 교훈)
    setTimeout: (fn, ms) => { const t = { fn, ms, id: timers.length + 1, cleared: false }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    fetch: fetchImpl,
    Date: now ? { now } : Date, Math, JSON, // now = 가짜 시계(1분 무응답 안내 판정용)
    __navigated: null,
  };
  if (nav) ctx.navigator = nav; // 없으면 navigator가 아예 없는 환경 — 언어는 영어(이전과 같음)
  if (ls) Object.defineProperty(ctx, 'localStorage', ls); // { value } 또는 { get } — 접근이 막힌 웹뷰도 흉내 낸다
  if (hasAC) {
    ctx.AbortController = class {
      constructor() { this.signal = { aborted: false, onabort: null }; }
      abort() { this.signal.aborted = true; if (this.signal.onabort) this.signal.onabort(); }
    };
  }
  ctx.window = ctx;
  ctx.window.__TAURI__ = { event: { listen: (n, cb) => { listeners[n] = cb; } } };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(BOOT, 'utf8'), ctx);
  return { ctx, listeners, timers, intervals, els, docEl };
}

const drain = () => new Promise((r) => setImmediate(r));

test('ping route publishes the exact adoption protocol without runtime health claims', async () => {
  const source = readFileSync(new URL('../app/api/ping/route.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace('export async function GET', 'async function GET');
  const get = vm.runInNewContext(`${source}\nGET`, {
    Response, pkg: { version: '9.9.9' }, readFileSync: () => 'fixture-build',
  });
  const response = await get();
  assert.deepEqual(await response.json(), { argo: true, version: '9.9.9', buildId: 'fixture-build', dockProtocol: 1 });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
/** 무응답 선점 모사 — signal abort에만 반응해 reject(진짜 매달리는 fetch). */
const hangingFetch = (calls) => (url, opts) => {
  calls.push(url);
  return new Promise((_, reject) => {
    if (opts?.signal) opts.signal.onabort = () => reject(new Error('aborted'));
  });
};

test('무응답 선점: 프로브 상한이 발화하면 다음 후보로 넘어간다 (영구 대기 재발 방지 핀)', async () => {
  const calls = [];
  const { timers } = load({ fetchImpl: hangingFetch(calls) });
  await drain();
  assert.equal(calls.length, 1, '첫 후보(3001) 프로브 시작');
  const probeTimer = timers.find((t) => t.ms === 1500 && !t.cleared);
  assert.ok(probeTimer, '미확정 후보 프로브에 1.5s 상한이 걸린다');
  probeTimer.fn(); // 상한 발화 → abort → 다음 후보
  await drain(); await drain();
  assert.equal(calls.length, 2, '두 번째 후보로 진행 — 구 코드는 여기서 영원히 1이었다(원 결함)');
  assert.ok(String(calls[1]).includes('3011'));
});

test('확정 포트(자기 서버)는 넉넉한 상한(8s) — 기동 지연 서버를 건너뛰지 않는다 (검수 회귀 핀)', async () => {
  const calls = [];
  const { listeners, timers } = load({ fetchImpl: hangingFetch(calls) });
  listeners.boot({ payload: { port: 3011, version: '9.9.9' } });
  // 첫 미확정 프로브(3001)를 상한 발화로 종료 → 소진 → 1.2s 재시도 타이머 발화 → 확정 목록 사이클
  timers.find((t) => t.ms === 1500 && !t.cleared)?.fn();
  await drain(); await drain();
  timers.find((t) => t.ms === 1200)?.fn();
  await drain(); await drain();
  const fixedCall = calls.findIndex((u) => String(u).includes('3011'));
  assert.ok(fixedCall > 0, '확정 포트 프로브 도달');
  const fixedTimer = timers.filter((t) => t.ms === 8000);
  assert.ok(fixedTimer.length >= 1, '확정 포트에는 1.5s가 아니라 8s 상한 — 일괄 1.5s는 ping 3s 서버에 영구 미부착(검수 실측)');
});

test('port 이벤트 = 단일 교체 + 버전 각인 (같은 버전 상주로 새는 경로 차단 — 원 설계 유지)', () => {
  const { ctx, listeners } = load({ fetchImpl: () => new Promise(() => {}) });
  listeners.boot({ payload: { port: 3011, version: '9.9.9' } });
  assert.equal(JSON.stringify(ctx.TARGETS), JSON.stringify(['http://localhost:3011']), '확정 후에는 다른 후보(상주 3001)를 프로브하지 않는다'); // vm 배열은 다른 realm — deepEqual 불가
  assert.equal(ctx.APP_VER, '9.9.9');
});

test('정상 즉답: 신원·버전 일치 서버로 이동하고 상한 타이머를 해제한다 (정상 경로 회귀 0)', async () => {
  const { ctx, timers } = load({
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ argo: true, version: '0.0.0', dockProtocol: 1 }) }),
  });
  await drain(); await drain(); await drain();
  const goDelay = timers.find((t) => t.ms === 350);
  assert.ok(goDelay, 'goto 지연 예약');
  goDelay.fn();
  assert.equal(ctx.__navigated, 'http://localhost:3001');
  assert.ok(timers.filter((t) => t.ms === 1500).every((t) => t.cleared), '정착 시 프로브 상한 타이머 해제');
});

test('이벤트 유실: 사이클마다 후보 상한이 점증한다 (1.5s→3s…8s 캡 — 느린 자기 서버 영구 미부착 방지 핀)', async () => {
  const calls = [];
  const { timers } = load({ fetchImpl: hangingFetch(calls) });
  // 첫 사이클: 후보 4개를 상한 발화로 소진 — 전부 1500이어야 한다(신속 폴오버 유지)
  for (let n = 0; n < 4; n++) {
    await drain(); await drain();
    const t = timers.find((x) => x.ms === 1500 && !x.cleared && !x.fired);
    assert.ok(t, `첫 사이클 ${n + 1}번째 후보 상한 = 1.5s`);
    t.fired = true; t.fn();
  }
  await drain(); await drain();
  timers.find((t) => t.ms === 1200)?.fn(); // 소진 → 재시도 → 두 번째 사이클
  await drain(); await drain();
  assert.ok(timers.some((t) => t.ms === 3000), '두 번째 사이클 후보 상한 = 3s — 고정 1.5s는 boot 이벤트 유실 시 ping 3s 서버를 영구히 굶긴다(검수 실측 20s간 abort 8회)');
});

test('신원 게이트: argo 마커 없는 응답(타 앱)으로는 이동하지 않는다 (Cannot GET / 사고 핀)', async () => {
  const { ctx, timers } = load({
    fetchImpl: (url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(url).includes('3001') ? { hello: 'imposter' } : { argo: true, version: '0.0.0', dockProtocol: 1 }),
    }),
  });
  for (let n = 0; n < 6 && !timers.find((t) => t.ms === 350); n++) await drain();
  timers.find((t) => t.ms === 350)?.fn();
  assert.equal(ctx.__navigated, 'http://localhost:3011', '선점 타 앱(3001)을 건너뛰고 진짜 Argo(3011)로');
});

test('버전 게이트: 셸 버전을 알면 다른 버전의 Argo는 건너뛴다 (v0.1.20 앱-v0.1.22 화면 어긋남 핀)', async () => {
  const { ctx, listeners, timers } = load({
    fetchImpl: (url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ argo: true, version: String(url).includes('3001') ? '0.0.1' : '9.9.9', dockProtocol: 1 }),
    }),
  });
  listeners.boot({ payload: { version: '9.9.9' } }); // port 없이 버전만 — 목록은 그대로
  for (let n = 0; n < 6 && !timers.find((t) => t.ms === 350); n++) await drain();
  timers.find((t) => t.ms === 350)?.fn();
  assert.equal(ctx.__navigated, 'http://localhost:3011', '버전 불일치 상주(3001)를 건너뛰고 같은 버전(3011)으로');
});

test('AbortController 부재 웹뷰: 예외 없이 구 동작으로 강등 (사문화 폴백 핀)', async () => {
  const calls = [];
  const { timers } = load({ fetchImpl: (u) => { calls.push(u); return new Promise(() => {}); }, hasAC: false });
  await drain();
  assert.equal(calls.length, 1);
  assert.equal(timers.filter((t) => t.ms === 1500 || t.ms === 8000).length, 0, '타이머 미배선 — 조용한 강등');
});

for (const stale of [undefined, 0, 10]) {
  test(`same-version resident protocol ${stale} is not adopted even without a boot event`, async () => {
    const { ctx, timers } = load({ fetchImpl: url => Promise.resolve({ ok: true,
      json: () => Promise.resolve({ argo: true, version: '9.9.9', dockProtocol: String(url).includes('3001') ? stale : 1 }),
    }) });
    for (let n = 0; n < 8 && !timers.find(t => t.ms === 350); n++) await drain();
    timers.find(t => t.ms === 350)?.fn();
    assert.equal(ctx.__navigated, 'http://localhost:3011');
  });
}

// ── 상주 대기(2026-10-08 실사고 — 재시동 직후 앱이 상주 자리 3001을 먼저 차지) ──
/** 첫 사이클 후보 4개를 상한 발화로 소진시켜 1분 무응답 판정 줄(probe의 i >= TARGETS.length)까지 보낸다. */
async function exhaustCycle(timers) {
  for (let n = 0; n < 8; n++) {
    await drain(); await drain();
    const t = timers.find((x) => (x.ms === 1500 || x.ms === 8000) && !x.cleared && !x.fired);
    if (!t) break;
    t.fired = true; t.fn();
  }
  await drain(); await drain();
}

test('상주 대기: 문구를 보이고, 후보 전부를 계속 프로브한다(상주가 준비되면 바로 이동)', async () => {
  const calls = [];
  const { ctx, listeners, timers } = load({ fetchImpl: hangingFetch(calls) });
  listeners.boot({ payload: { phase: 'resident', detail: 'waiting for the Argo background service', port: null, version: '9.9.9' } });
  assert.equal(ctx.document.getElementById('status').textContent, 'Waiting for the Argo background service to start…');
  assert.equal(ctx.TARGETS.length, 4, '포트를 확정하지 않는다 — 상주(3001)도 계속 후보');
  assert.equal(ctx.APP_VER, '9.9.9', '기다리는 동안 버전 각인 — 다른 버전 상주로는 이동하지 않는다');
  await exhaustCycle(timers);
  assert.ok(['3001', '3011', '3021', '3999'].every((p) => calls.some((u) => String(u).includes(p))), '후보 4개 모두 프로브');
});

test('1분 무응답 안내: 상주 대기 중에는 띄우지 않고, 앱 서버 기동부터 다시 센다', async () => {
  let clock = 0;
  const { ctx, listeners, timers } = load({ fetchImpl: hangingFetch([]), now: () => clock });
  const err = ctx.document.getElementById('err');
  listeners.boot({ payload: { phase: 'resident', port: null, version: '9.9.9' } });
  clock = 61_000; // 상주를 60초 기다렸다
  await exhaustCycle(timers);
  assert.equal(err.hidden, true, '상주 대기 중 — "다시 열어 보라" 안내 없음');
  listeners.boot({ payload: { phase: 'starting', port: 3011, version: '9.9.9' } }); // 상한 도달 → 앱 서버 기동
  timers.find((t) => t.ms === 1200 && !t.fired)?.fn();
  await exhaustCycle(timers);
  assert.equal(err.hidden, true, '막 뜨는 앱 서버에 1분 안내를 붙이지 않는다');
  clock = 122_000; // 기동 뒤 61초
  timers.filter((t) => t.ms === 1200 && !t.fired).forEach((t) => { t.fired = true; t.fn(); });
  await exhaustCycle(timers);
  assert.equal(err.hidden, false, '기동 뒤 1분이 지나면 안내는 그대로 뜬다');
});

test('1분 무응답 안내: 상주 없는 일반 부팅은 지금과 같다(핀)', async () => {
  let clock = 0;
  const { ctx, timers } = load({ fetchImpl: hangingFetch([]), now: () => clock });
  clock = 61_000;
  await exhaustCycle(timers);
  assert.equal(ctx.document.getElementById('err').hidden, false);
});

test('상주 대기 중 진행 막대는 40%까지만 오르고, 대기 끝에 앱 서버를 띄우면 그때부터 다시 오른다', () => {
  const { ctx, listeners, intervals } = load({ fetchImpl: () => new Promise(() => {}) });
  const width = () => parseFloat(ctx.document.getElementById('fill').style.width);
  const tick = (n) => { for (let k = 0; k < n; k++) intervals.forEach((fn) => fn()); };
  listeners.boot({ payload: { phase: 'resident', port: null, version: '9.9.9' } });
  tick(180); // 90초 — 대기 상한 끝
  assert.ok(width() > 30 && width() <= 40, `기다리는 동안에도 조금씩 오르되 40%를 넘지 않는다: ${width()}`);
  const atFallback = width();
  listeners.boot({ payload: { phase: 'starting', port: 3011, version: '9.9.9' } });
  tick(20); // 10초
  assert.ok(width() > atFallback + 15, `앱 서버 기동 구간에서 막대가 움직인다: ${atFallback} → ${width()}`);
});

test('닫힌 후보를 먼저 다 돌아 waiting(58%)이 된 뒤 상주 대기가 와도 막대는 거기서 멈추고, 기동 구간을 남긴다', async () => {
  const { ctx, listeners, intervals } = load({ fetchImpl: () => Promise.reject(new Error('refused')) });
  const width = () => parseFloat(ctx.document.getElementById('fill').style.width);
  const tick = (n) => { for (let k = 0; k < n; k++) intervals.forEach((fn) => fn()); };
  for (let n = 0; n < 12; n++) await drain(); // 후보 4개 즉시 거절 → 소진 → waiting
  assert.equal(width(), 58);
  listeners.boot({ payload: { phase: 'resident', port: null, version: '9.9.9' } });
  tick(180);
  assert.equal(width(), 58, '대기 중에 90%로 차오르지 않는다');
  listeners.boot({ payload: { phase: 'starting', port: 3011, version: '9.9.9' } });
  tick(20);
  assert.ok(width() > 68, `앱 서버 기동 구간에서 막대가 움직인다: ${width()}`);
});

test('상주 대기 끝에 상주에 붙으면(started) 느린 부팅 안내의 기준 시각도 다시 잡는다', () => {
  let clock = 0;
  const { ctx, listeners, intervals } = load({ fetchImpl: () => new Promise(() => {}), now: () => clock });
  const status = ctx.document.getElementById('status');
  const tick = () => intervals.forEach((fn) => fn());
  listeners.boot({ payload: { phase: 'resident', port: null, version: '9.9.9' } });
  clock = 50_000; tick();
  assert.equal(status.textContent, 'Waiting for the Argo background service to start… 50s', '대기 중에는 느린 부팅 안내로 바꾸지 않는다(기다린 초만 붙는다)');
  listeners.boot({ payload: { phase: 'started', port: 3001, version: '9.9.9' } }); // 50초 기다린 끝에 상주 입양
  clock = 50_500; tick();
  assert.equal(status.textContent, 'Local server is warming up…', '기다린 50초를 세면 "Still working"이 바로 붙는다');
  clock = 66_000; tick();
  assert.equal(status.textContent, 'Still working — first launch can take a couple of minutes…', '붙은 뒤 15초가 지나면 안내는 그대로 뜬다');
});

test('상주 대기 중에는 문구에 기다린 초가 붙는다 — 막대가 waiting(58%)에 멈춰 있어도 화면이 바뀐다(#874 2차 검수 LOW)', async () => {
  let clock = 0;
  const { ctx, listeners, intervals } = load({ fetchImpl: () => Promise.reject(new Error('refused')), now: () => clock });
  const status = ctx.document.getElementById('status');
  const width = () => parseFloat(ctx.document.getElementById('fill').style.width);
  const tick = () => intervals.forEach((fn) => fn());
  for (let n = 0; n < 12; n++) await drain(); // 닫힌 후보를 먼저 다 돌아 waiting(58%) — 사고 경로의 순서
  clock = 1_000;
  listeners.boot({ payload: { phase: 'resident', port: null, version: '9.9.9' } });
  clock = 4_000; tick();
  assert.equal(status.textContent, 'Waiting for the Argo background service to start… 3s');
  clock = 24_500; tick();
  assert.equal(status.textContent, 'Waiting for the Argo background service to start… 23s');
  assert.equal(width(), 58, '막대는 그대로여도 문구가 바뀐다');
  listeners.boot({ payload: { phase: 'resident', port: null, version: '9.9.9' } }); // 셸은 매 간격 같은 상태를 다시 보낸다
  clock = 25_000; tick();
  assert.equal(status.textContent, 'Waiting for the Argo background service to start… 24s', '같은 상태를 다시 받아도 처음부터 세지 않는다');
  listeners.boot({ payload: { phase: 'starting', port: 3011, version: '9.9.9' } });
  tick();
  assert.equal(status.textContent, 'Starting the local server…', '대기가 끝나면 초를 붙이지 않는다');
});


// ── 표시 언어(H22 ②) — 부트 화면 문구가 영어뿐이라 한국어 사용자에게도 영어가 떴다 ──
// boot.js는 Next 밖의 정적 파일(Tauri frontendDist=public)이라 app/i18n.jsx(React 모듈)를 쓸 수 없다 — boot.js 안에 ko/en 두 벌을 둔다.
const KO = {
  title: 'Argo에 연결하는 중…',
  bar: '시작 진행률',
  shell: '앱을 준비하는 중…',
  resident: 'Argo 백그라운드 서비스가 시작되기를 기다리는 중…',
  starting: '이 컴퓨터의 서버를 시작하는 중…',
  started: '서버를 준비하는 중…',
  waiting: '서버가 응답하기를 기다리는 중…',
  slow: '아직 준비 중입니다 — 처음 실행은 몇 분 걸릴 수 있습니다…',
  ready: '준비됐습니다 — 화면을 엽니다…',
};
const EN = {
  title: 'Connecting to Argo…',
  bar: 'startup progress',
  shell: 'Preparing the app shell…',
  resident: 'Waiting for the Argo background service to start…',
  starting: 'Starting the local server…',
  started: 'Local server is warming up…',
  waiting: 'Waiting for the server to respond…',
  slow: 'Still working — first launch can take a couple of minutes…',
  ready: 'Ready — opening your deck…',
};
const KO_NAV = { language: 'ko-KR', languages: ['ko-KR', 'en-US'] };
const EN_NAV = { language: 'en-US', languages: ['en-US'] };

/** 단계별 화면 문구를 실제 이벤트·타이머 경로로 모은다 — 한 언어의 shell·resident·starting·started·waiting·slow·ready. */
async function collectStatus(opts) {
  const seen = {};
  let clock = 0;
  const open = load({ fetchImpl: () => Promise.reject(new Error('refused')), now: () => clock, ...opts });
  const { ctx, listeners, intervals, els } = open;
  seen.title = els.title.textContent; seen.bar = els.bar.attrs['aria-label']; seen.shell = els.status.textContent;
  for (let n = 0; n < 12; n++) await drain(); // 닫힌 후보를 먼저 다 돌아 waiting
  seen.waiting = els.status.textContent;
  listeners.boot({ payload: { phase: 'resident', port: null, version: '9.9.9' } });
  seen.resident = els.status.textContent;
  clock = 3_000; intervals.forEach((fn) => fn());
  seen.residentSec = els.status.textContent;
  listeners.boot({ payload: { phase: 'starting', port: 3011, version: '9.9.9' } });
  seen.starting = els.status.textContent;
  listeners.boot({ payload: { phase: 'started', port: 3011, version: '9.9.9' } });
  seen.started = els.status.textContent;
  clock = 20_000; intervals.forEach((fn) => fn());
  seen.slow = els.status.textContent;
  return { seen, ...open, ctx };
}

test('표시 언어: 웹뷰 언어가 한국어면 부트 화면의 제목·단계 문구·진행 막대 이름이 모두 한국어다(경과 초는 초 단위로)', async () => {
  const { seen, docEl } = await collectStatus({ navigator: KO_NAV });
  assert.deepEqual({ title: seen.title, bar: seen.bar, shell: seen.shell, waiting: seen.waiting, resident: seen.resident, starting: seen.starting, started: seen.started, slow: seen.slow },
    { title: KO.title, bar: KO.bar, shell: KO.shell, waiting: KO.waiting, resident: KO.resident, starting: KO.starting, started: KO.started, slow: KO.slow });
  assert.equal(seen.residentSec, `${KO.resident} 3초`, '상주 대기 경과 초 표시(#874)는 한국어에서도 유지');
  assert.equal(docEl.lang, 'ko', '<html lang>도 표시 언어를 따른다');
});

test('표시 언어: 웹뷰 언어가 영어(또는 알 수 없음)면 이전과 같은 영어 — 경과 초는 s', async () => {
  for (const [label, opts] of [['en-US', { navigator: EN_NAV }], ['일본어 등 한영 밖은 영어', { navigator: { language: 'ja-JP' } }], ['navigator 없음', {}]]) {
    const { seen, docEl } = await collectStatus(opts);
    assert.deepEqual({ title: seen.title, bar: seen.bar, shell: seen.shell, waiting: seen.waiting, resident: seen.resident, starting: seen.starting, started: seen.started, slow: seen.slow },
      { title: EN.title, bar: EN.bar, shell: EN.shell, waiting: EN.waiting, resident: EN.resident, starting: EN.starting, started: EN.started, slow: EN.slow }, label);
    assert.equal(seen.residentSec, `${EN.resident} 3s`, label);
    assert.equal(docEl.lang, 'en', label);
  }
});

test('표시 언어: 준비 완료 문구와 데모 꼬리말도 언어를 따른다', async () => {
  for (const [label, nav, ready, demo] of [['ko', KO_NAV, KO.ready, ' (데모 — 이 화면에 머뭅니다)'], ['en', EN_NAV, EN.ready, ' (demo — staying here)']]) {
    const ok = load({ navigator: nav, fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ argo: true, version: '0.0.0', dockProtocol: 1 }) }) });
    for (let n = 0; n < 4; n++) await drain();
    assert.equal(ok.els.status.textContent, ready, `${label}: 이동 직전 문구`);
    // 데모 모드(?demo) — 리다이렉트 없이 이 화면에 머문다. load()는 검색어를 못 바꾸므로 같은 스텁으로 따로 올린다.
    const els = { status: { textContent: '', hidden: true, style: {} }, fill: { style: {} }, logtail: { hidden: true }, err: { hidden: true } };
    const ctx = { console, document: { getElementById: (id) => els[id] }, location: { search: '?demo', replace() {} }, navigator: nav,
      setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, fetch: () => new Promise(() => {}), Date, Math, JSON };
    ctx.window = ctx; vm.createContext(ctx); vm.runInContext(readFileSync(BOOT, 'utf8'), ctx);
    ctx.goto('http://localhost:3001');
    assert.equal(els.status.textContent, ready + demo, `${label}: 데모 꼬리말`);
  }
});

test('표시 언어: 오류·1분 무응답 안내도 언어를 따르고, 셸이 준 원인(detail)은 그대로 붙는다', async () => {
  for (const [label, nav, expect] of [
    ['ko', KO_NAV, {
      terminal: '이 컴퓨터의 서버를 시작하지 못했습니다: port busy',
      transient: '서버에 문제가 생겼습니다: port busy\n계속 다시 시도하는 중입니다 — 이 화면이 몇 분 넘게 그대로면 Argo를 종료했다가 다시 여세요.',
      unknown: '이 컴퓨터의 서버를 시작하지 못했습니다: 알 수 없음',
      minute: '서버가 1분 넘게 응답하지 않습니다. Argo를 종료했다가 다시 여세요. 그래도 같으면 다른 앱이 3001/3011/3021 포트를 쓰고 있을 수 있습니다.',
    }],
    ['en', EN_NAV, {
      terminal: 'The local server could not start: port busy',
      transient: 'The local server hit a problem: port busy\nStill retrying — if this screen stays for minutes, quit and reopen Argo.',
      unknown: 'The local server could not start: unknown',
      minute: 'The server has not responded for a minute. Quit and reopen Argo — if it persists, another app may be using ports 3001/3011/3021.',
    }]]) {
    let clock = 0;
    const { listeners, els, timers } = load({ navigator: nav, fetchImpl: hangingFetch([]), now: () => clock });
    listeners.boot({ payload: { phase: 'error', terminal: true, detail: 'port busy' } });
    assert.equal(els.err.textContent, expect.terminal, `${label}: 종료된 실패`);
    listeners.boot({ payload: { phase: 'error', detail: 'port busy' } });
    assert.equal(els.err.textContent, expect.transient, `${label}: 재시도 중 실패`);
    listeners.boot({ payload: { phase: 'error', terminal: true } });
    assert.equal(els.err.textContent, expect.unknown, `${label}: 원인 없음`);
    listeners.boot({ payload: { phase: 'starting', port: 3011, version: '9.9.9' } }); // 오류 배너를 걷고 1분 안내 판정으로
    clock = 61_000;
    await exhaustCycle(timers);
    assert.equal(els.err.hidden, false, `${label}: 1분 무응답 안내가 뜬다`);
    assert.equal(els.err.textContent, expect.minute, `${label}: 1분 무응답 안내`);
  }
});

test('표시 언어 우선순위: 같은 출처의 argo-lang(ko|en)이 웹뷰 언어보다 먼저, 값이 이상하거나 저장소가 막혔으면 웹뷰 언어', async () => {
  const kind = async (opts) => (await collectStatus(opts)).seen.shell === KO.shell ? 'ko' : 'en';
  const store = (v) => ({ value: { getItem: (k) => (k === 'argo-lang' ? v : null) } });
  assert.equal(await kind({ navigator: EN_NAV, localStorage: store('ko') }), 'ko', '앱에서 한국어를 골랐으면 OS가 영어여도 한국어');
  assert.equal(await kind({ navigator: KO_NAV, localStorage: store('en') }), 'en', '앱에서 영어를 골랐으면 OS가 한국어여도 영어');
  assert.equal(await kind({ navigator: KO_NAV, localStorage: store('fr') }), 'ko', 'ko·en 밖의 값은 무시하고 웹뷰 언어');
  assert.equal(await kind({ navigator: KO_NAV, localStorage: store(null) }), 'ko', '저장값 없음');
  assert.equal(await kind({ navigator: KO_NAV, localStorage: { get() { throw new Error('SecurityError'); } } }), 'ko', '저장소 접근이 막혀도 예외 없이 웹뷰 언어');
});

test('표시 언어: ko·en 사전은 같은 칸을 갖고, 옛 용어(크루·사장·선장, crew·captain·boss)가 없다', () => {
  const { ctx } = load({ fetchImpl: () => new Promise(() => {}), navigator: KO_NAV });
  const text = ctx.BOOT_TEXT;
  const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${pre}${k}.`) : [[`${pre}${k}`, v]]));
  const ko = flat(text.ko); const en = flat(text.en);
  assert.deepEqual(ko.map(([k]) => k), en.map(([k]) => k), '두 언어의 칸이 같다');
  for (const [k, v] of ko) assert.match(v, /[가-힣]/, `ko ${k}에 한글이 있다: ${v}`);
  for (const [k, v] of ko) assert.doesNotMatch(v, /크루|사장|선장/, `ko ${k}`);
  for (const [k, v] of en) assert.doesNotMatch(v, /\b(crews?|captain|boss)\b/i, `en ${k}`);
  for (const [k, v] of ko) assert.doesNotMatch(v.replace(/Argo/g, ''), /[A-Za-z]{2,}/, `ko ${k}에 영어 낱말이 남지 않았다(고유명사 Argo 제외): ${v}`);
});
