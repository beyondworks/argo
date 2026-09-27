// 보낼 목록 규칙 — 저장 버튼 없이 무엇도 잃지 않는다(유건 2026-09-26: 노션처럼 모든 것이 비동기 저장).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, autoFlush } from '../src/core/outbox.js';

const memStore = () => { let v; return { get: async () => v, set: async (x) => { v = structuredClone(x); }, peek: () => v }; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
// 전송 횟수 상한 — 재시도를 멈추지 않는 결함은 쉬지 않고 돌아 타이머도 못 돈다. 50번을 넘으면 영구 오류로 끊어 실패가 드러나게 한다.
const guarded = (fn) => { let n = 0; return async (op) => { if (++n > 50) throw Object.assign(new Error('loop'), { transient: false }); return fn(op); }; };
const outbox = (opts) => createOutbox({ ...opts, send: guarded(opts.send) });

// 이유: 같은 대상의 연속 입력(글자마다)을 전부 보내면 DB에 갱신이 쌓인다(TOAST 사고 9/16) — 마지막 값 하나만 보낸다.
test('같은 key는 아직 안 보낸 것끼리 마지막 값으로 합친다', async () => {
  const sent = [];
  const ob = outbox({ store: memStore(), send: async (op) => { sent.push(op.payload); } });
  await ob.enqueue({ key: 'page:1', payload: 'a' });
  await ob.enqueue({ key: 'page:1', payload: 'ab' });
  await ob.enqueue({ key: 'page:1', payload: 'abc' });
  await ob.flush();
  assert.deepEqual(sent, ['abc']);
});

// 이유: 만들기 → 이동 같은 구조 변경은 순서가 바뀌면 부모 없는 페이지가 생긴다.
test('다른 key는 넣은 순서대로 보낸다', async () => {
  const sent = [];
  const ob = outbox({ store: memStore(), send: async (op) => { sent.push(op.key); } });
  await ob.enqueue({ key: 'create:1', payload: 1 });
  await ob.enqueue({ key: 'move:1', payload: 2 });
  await ob.enqueue({ key: 'create:2', payload: 3 });
  await ob.flush();
  assert.deepEqual(sent, ['create:1', 'move:1', 'create:2']);
});

// 이유: 탭을 닫거나 새로고침해도 안 보낸 변경이 남아야 한다 — 저장소에서 다시 읽어 이어서 보낸다.
test('다시 열면 저장소에 남은 목록을 이어서 보낸다', async () => {
  const store = memStore();
  const a = outbox({ store, send: async () => { throw Object.assign(new Error('offline'), { transient: true }); } });
  await a.enqueue({ key: 'page:1', payload: 'draft' });
  await a.flush();
  assert.equal(store.peek().length, 1);
  const sent = [];
  const b = outbox({ store, send: async (op) => { sent.push(op.payload); } });
  await b.load();
  await b.flush();
  assert.deepEqual(sent, ['draft']);
  assert.equal(store.peek().length, 0);
});

// 이유: 재시도가 같은 변경을 두 번 적용하면 안 된다 — 요청마다 멱등 id가 붙고 재시도에도 같은 id다.
test('일시 오류는 같은 멱등 id로 재시도, 성공하면 목록에서 빠진다', async () => {
  const ids = []; let fail = 2;
  const ob = outbox({ store: memStore(), send: async (op) => { ids.push(op.id); if (fail-- > 0) throw Object.assign(new Error('net'), { transient: true }); } });
  await ob.enqueue({ key: 'k', payload: 1 });
  await ob.flush(); await ob.flush(); await ob.flush();
  assert.equal(new Set(ids).size, 1);
  assert.equal(ids.length, 3);
  assert.equal(ob.pending(), 0);
});

// 이유: 권한 거절처럼 다시 해도 안 되는 오류는 목록을 막으면 안 된다 — 빼고, 화면을 되돌리게 알린다.
test('영구 오류는 목록에서 빼고 onRejected로 알린 뒤 다음 것을 보낸다', async () => {
  const rejected = [], sent = [];
  const ob = outbox({ store: memStore(), onRejected: (op) => rejected.push(op.key),
    send: async (op) => { if (op.key === 'bad') throw Object.assign(new Error('403'), { transient: false }); sent.push(op.key); } });
  await ob.enqueue({ key: 'bad', payload: 1 });
  await ob.enqueue({ key: 'good', payload: 2 });
  await ob.flush();
  assert.deepEqual(rejected, ['bad']);
  assert.deepEqual(sent, ['good']);
});

// 이유: 일시 오류가 나면 뒤의 것도 멈춰야 순서가 지켜진다(첫 것 실패 중에 둘째가 먼저 가면 안 된다).
test('일시 오류가 난 자리에서 멈춘다', async () => {
  const sent = []; let calls = 0;
  const ob = outbox({ store: memStore(), send: async (op) => {
    // 멈추지 않는 결함이면 쉬지 않고 재시도해 타이머조차 못 돈다 — 횟수로 루프를 끊어 실패가 드러나게
    if (++calls > 20) throw Object.assign(new Error('loop'), { transient: false });
    if (op.key === 'a') throw Object.assign(new Error('net'), { transient: true });
    sent.push(op.key);
  } });
  await ob.enqueue({ key: 'a', payload: 1 });
  await ob.enqueue({ key: 'b', payload: 2 });
  await ob.flush();
  assert.equal(calls, 1);
  assert.deepEqual(sent, []);
  assert.equal(ob.pending(), 2);
});

// 이유: 보내는 중인 것에는 합치지 않는다 — 합치면 전송 중인 값과 새 값 중 하나가 사라진다.
test('전송 중인 op에는 합치지 않고 뒤에 새로 붙인다', async () => {
  const sent = []; let release;
  const ob = outbox({ store: memStore(), send: async (op) => { sent.push(op.payload); if (op.payload === 'a') await new Promise((r) => { release = r; }); } });
  await ob.enqueue({ key: 'p', payload: 'a' });
  const f = ob.flush();
  await tick(5);
  await ob.enqueue({ key: 'p', payload: 'ab' });
  release(); await f; await ob.flush();
  assert.deepEqual(sent, ['a', 'ab']);
});

// 이유: 저장 상태 표시(저장됨/저장 중/오프라인)는 목록 상태에서 나온다.
test('상태: 비면 idle, 남아 있으면 pending, 일시 오류면 retrying', async () => {
  const states = [];
  const ob = outbox({ store: memStore(), onState: (s) => states.push(s), send: async () => { throw Object.assign(new Error('net'), { transient: true }); } });
  await ob.enqueue({ key: 'k', payload: 1 });
  await ob.flush();
  assert.ok(states.includes('pending'));
  assert.equal(states.at(-1), 'retrying');
});

// 이유: 가려진 탭은 브라우저가 타이머를 분 단위로 늦춘다 — 입력 직후 탭을 옮기면 다른 기기 반영이 늦어진다. 가려지는 순간 보낸다.
test('탭이 가려지면 대기 시간을 기다리지 않고 바로 보낸다', async () => {
  const handlers = {};
  globalThis.window = { addEventListener() {} };
  globalThis.document = { hidden: false, addEventListener: (k, f) => { handlers[k] = f; } };
  try {
    const sent = [];
    const ob = outbox({ store: memStore(), send: async (op) => { sent.push(op.key); } });
    const auto = autoFlush(ob, { delay: 60_000, maxWait: 60_000 });
    await ob.enqueue({ key: 'page:1', payload: 'a' });
    auto.poke();
    document.hidden = true; handlers.visibilitychange();
    await tick(5);
    assert.deepEqual(sent, ['page:1']);
    auto.cancel?.();
  } finally { delete globalThis.window; delete globalThis.document; }
});
