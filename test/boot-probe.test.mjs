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

function load({ fetchImpl, hasAC = true }) {
  const el = () => ({ textContent: '', hidden: true, style: {} });
  const els = { status: el(), fill: el(), logtail: el(), err: el() };
  const listeners = {};
  const timers = [];
  const ctx = {
    console,
    document: { getElementById: (id) => els[id] },
    location: { search: '', replace: (u) => { ctx.__navigated = u; } },
    // 타이머 핸들은 1부터(0이면 boot.js의 `if (timer)` 진위 검사가 거짓 실패 — 검수 하네스 교훈)
    setTimeout: (fn, ms) => { const t = { fn, ms, id: timers.length + 1, cleared: false }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
    setInterval: () => 0,
    fetch: fetchImpl,
    Date, Math, JSON,
    __navigated: null,
  };
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
  return { ctx, listeners, timers };
}

const drain = () => new Promise((r) => setImmediate(r));
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
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ argo: true, version: '0.0.0' }) }),
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
      json: () => Promise.resolve(String(url).includes('3001') ? { hello: 'imposter' } : { argo: true, version: '0.0.0' }),
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
      json: () => Promise.resolve({ argo: true, version: String(url).includes('3001') ? '0.0.1' : '9.9.9' }),
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
