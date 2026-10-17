// 메신저 v2 연결 상태 기계(U5) — 가짜 Supabase(REST·RPC·Storage·Realtime 흉내)와 가짜 시계로 경우 표 칸을 잠근다.
// 설계 7절: 경우 5(최소 버전 미만), 10(중단 스위치), 11(5분 끊김 → 따라잡기 1회·중복 0·더 있음), 19(기기 폐기 → 소켓 닫힘),
// 4절 유휴 요청 0(10분), 재연결 간격 상한, nudge가 간격을 건너뛰지 않음, 보내기 멱등·재시도 상한.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkMachine, LAST_ID_KEY } from '../src/link/machine.mjs';
import { RECONNECT, SEND_RETRY, ATTACH_LIMITS } from '../src/link/policy.mjs';

const UID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ROOM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MIN = 60_000;

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

// ── 가짜 시계 ────────────────────────────────────────────────────────────────
function fakeClock() {
  let t = 1_000_000; let seq = 0; const q = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; q.set(id, { at: t + Math.max(0, ms), fn }); return id; },
    clearTimeout: (id) => { q.delete(id); },
    pending: () => q.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await flush();
        const due = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        q.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = end; await flush();
    },
  };
}

function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }; }

// ── 가짜 Supabase ────────────────────────────────────────────────────────────
// 요청(REST·RPC·Storage)은 전부 log에 남는다. Realtime 가입·방송은 DB 요청이 아니라 따로 센다(joins).
function fakeSupabase({ minVersion = null, paused = false, session = { id: 'sess-1', ageMin: 0 } } = {}) {
  const s = {
    session, // 지금 JWT의 session_id와 로그인 뒤 지난 분(U3 새 app 행은 10분 안 세션만)
    log: [], joins: [], channels: new Set(), net: { down: false },
    db: { messages: [], attachments: [], files: new Map(), devices: new Map(), bySession: new Map(), nextId: 100, minVersion, paused, revokedSession: false, nextSince: undefined },
    fail: {}, // 이름 → [{ error, status, commit? }] 차례로 꺼내 쓴다
    hooks: {}, // 이름 → 응답 만들기 직전에 부른다
  };
  const netErr = () => ({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 });
  const take = (name) => (s.fail[name]?.length ? s.fail[name].shift() : null);
  const reply = (r) => Promise.resolve(r);

  s.insertMessage = ({ room = ROOM_A, author = OTHER, body = 'hi', bodyless = false } = {}) => {
    const m = { id: s.db.nextId++, room_id: room, author_kind: 'user', author_user_id: author, body, client_msg_id: null, created_at: new Date().toISOString() };
    s.db.messages.push(m);
    const payload = bodyless ? { message: { id: m.id, room_id: m.room_id, author_user_id: author } } : { message: m };
    s.broadcast(`v2:u:${UID}`, 'msg', payload);
    return m;
  };
  s.broadcast = (topic, event, payload) => {
    for (const ch of [...s.channels]) if (ch.topic === topic && ch.joined) for (const h of ch.handlers) if (h.type === 'broadcast') h.fn({ type: 'broadcast', event, payload });
  };
  s.dropSockets = () => { for (const ch of [...s.channels]) if (ch.joined) { ch.joined = false; ch.cb?.('CHANNEL_ERROR'); } };
  s.liveTopics = () => [...s.channels].filter((c) => c.joined).map((c) => c.topic).sort();
  s.count = (name) => s.log.filter((l) => l.name === name).length;

  const rpcs = {
    argo_min_app_version: () => ({ data: s.db.minVersion, error: null, status: 200 }),
    msgr2_service_pause: () => ({ data: s.db.paused ? { paused: true, since: '2026-10-17T15:00:00+09:00' } : null, error: null, status: 200 }),
    // U3 …_msgr2_device.sql msgr2_device_register의 거부 순서를 흉내 낸다(124~185줄). PostgREST 상태: 42501 → 403, 22023·P0001 → 400
    msgr2_device_register: (args) => {
      const err = (code, message) => ({ data: null, error: { code, message, details: null, hint: null }, status: code === '42501' ? 403 : 400 });
      if (!s.session?.id) return err('42501', 'msgr2_session_required');
      const runners = args.p_runners ?? [];
      if (!['app', 'runner', 'resident'].includes(args.p_kind) || args.p_app !== (args.p_kind === 'app' ? 'messenger' : 'desktop')
        || !/^\d+(\.\d+)*/.test(String(args.p_app_version ?? '')) || (args.p_kind === 'app' && runners.length)) return err('22023', 'msgr2_device_invalid');
      if (args.p_kind === 'app' && (args.p_link_min != null || args.p_link_max != null)) return err('22023', 'msgr2_device_invalid');
      if (s.db.minVersion && args.p_app_version < s.db.minVersion) return err('P0001', 'app_version_unsupported');
      let d = s.db.bySession.get(s.session.id);
      if (!d) {
        if (args.p_kind === 'app' && s.session.ageMin > 10) return err('42501', 'device_login_required');
        if (s.db.revokedSession) return err('42501', 'device_revoked');
        d = { id: `dev-${s.db.devices.size + 1}`, kind: args.p_kind, app: args.p_app };
        s.db.devices.set(d.id, args); s.db.bySession.set(s.session.id, d);
        return { data: { device_id: d.id, kind: d.kind, wrote: true }, error: null, status: 200 };
      }
      if (d.kind !== args.p_kind || d.app !== args.p_app) return err('42501', 'msgr2_device_kind_locked');
      if (s.db.revokedSession) return err('42501', 'device_revoked');
      return { data: { device_id: d.id, kind: d.kind, wrote: false }, error: null, status: 200 };
    },
    msgr2_catch_up: ({ p_since_id }) => {
      if (s.db.paused) return { data: { rooms: [], paused: true }, error: null, status: 200 };
      const by = new Map();
      for (const m of s.db.messages) if (p_since_id == null || m.id > p_since_id) (by.get(m.room_id) || by.set(m.room_id, []).get(m.room_id)).push(m);
      const rooms = [...by].map(([room_id, ms]) => ({ room_id, messages: ms.slice(-200), more: ms.length > 200 }));
      // U2 next_since: 시험이 정한 값(최근 글 앞에서 멈춘 기준). 정하지 않으면 옛 서버처럼 싣지 않는다
      const ns = typeof s.db.nextSince === 'function' ? s.db.nextSince(p_since_id) : s.db.nextSince;
      return { data: ns === undefined ? { rooms } : { rooms, next_since: ns }, error: null, status: 200 };
    },
    // U2 msgr2_attachment_add 흉내: 내 사람 글만, (글, 순번) 멱등, 경로는 서버가 정한다
    msgr2_attachment_add: ({ p_message, p_index, p_name, p_mime, p_bytes }) => {
      const m = s.db.messages.find((x) => x.id === p_message);
      if (!m || m.author_user_id !== UID) return { data: null, error: { code: '42501', message: 'msgr2_message_not_found' }, status: 403 };
      const path = `sp/${m.room_id}/${m.id}/${p_index}-${String(p_name).replace(/[\\/]/g, '_')}`;
      const had = s.db.attachments.find((a) => a.message_id === m.id && a.storage_path === `msgr/${path}`);
      if (had) return { data: { ok: true, attachment_id: had.id, bucket: 'msgr', path, existing: true }, error: null, status: 200 };
      const a = { id: s.db.attachments.length + 1, message_id: m.id, room_id: m.room_id, storage_path: `msgr/${path}`, name: p_name, mime: p_mime, bytes: p_bytes };
      s.db.attachments.push(a);
      return { data: { ok: true, attachment_id: a.id, bucket: 'msgr', path, existing: false }, error: null, status: 200 };
    },
  };

  s.rpc = (name, args = {}) => {
    s.log.push({ kind: 'rpc', name, args });
    s.hooks[name]?.(args);
    if (s.net.down) return reply(netErr());
    const f = take(name); if (f) return reply({ data: null, ...f });
    const h = rpcs[name];
    return reply(h ? h(args) : { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` }, status: 404 });
  };

  // REST 빌더(insert·select·eq·single·maybeSingle) — then으로 끝난다
  s.from = (table) => {
    const q = { table, op: 'select', row: null, filters: [], single: false, maybe: false, cols: '*' };
    const run = () => {
      s.log.push({ kind: 'rest', name: `${q.op}:${table}`, row: q.row, filters: q.filters });
      if (s.net.down) return netErr();
      const f = take(`${q.op}:${table}`);
      if (f && !f.commit) return { data: null, ...f };
      let out;
      if (q.op === 'insert') {
        const rows = Array.isArray(q.row) ? q.row : [q.row];
        const made = [];
        for (const r of rows) {
          if (table === 'msgr2_messages') {
            if (r.client_msg_id && s.db.messages.some((m) => m.room_id === r.room_id && m.client_msg_id === r.client_msg_id)) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "msgr2_messages_client"' }, status: 409 };
            }
            const m = { ...r, id: s.db.nextId++ }; s.db.messages.push(m); made.push(m);
          } else if (table === 'msgr2_attachments') { const a = { ...r, id: s.db.attachments.length + 1 }; s.db.attachments.push(a); made.push(a); }
        }
        out = { data: q.single ? made[0] : made, error: null, status: 201 };
      } else {
        const src = table === 'msgr2_messages' ? s.db.messages : s.db.attachments;
        const rows = src.filter((r) => q.filters.every(([k, v]) => r[k] === v));
        out = { data: q.single || q.maybe ? rows[0] ?? null : rows, error: null, status: 200 };
      }
      if (f?.commit) return { data: null, error: f.error, status: f.status }; // 서버에는 들어갔는데 답이 끊긴 경우
      return out;
    };
    const b = {
      insert(row) { q.op = 'insert'; q.row = row; return b; },
      select(cols = '*') { q.cols = cols; return b; },
      eq(k, v) { q.filters.push([k, v]); return b; },
      single() { q.single = true; return b; },
      maybeSingle() { q.maybe = true; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    return b;
  };

  s.storage = {
    from: (bucket) => ({
      upload: (path, data, opts) => {
        s.log.push({ kind: 'storage', name: `upload:${bucket}`, path });
        if (s.net.down) return reply({ data: null, error: { name: 'StorageUnknownError', message: 'Failed to fetch' } });
        const f = take(`upload:${bucket}`); if (f) return reply({ data: null, ...f });
        if (s.db.files.has(path) && !opts?.upsert) return reply({ data: null, error: { name: 'StorageApiError', message: 'The resource already exists', status: 409, statusCode: '409' } });
        s.db.files.set(path, data); return reply({ data: { path }, error: null });
      },
    }),
  };

  s.channel = (topic, opts) => {
    const ch = {
      topic, opts, handlers: [], joined: false, cb: null,
      on(type, filter, fn) { this.handlers.push({ type, filter, fn }); return this; },
      subscribe(cb) {
        this.cb = cb; s.joins.push(topic);
        const go = () => {
          if (!s.channels.has(ch)) return;
          if (s.net.down || s.denyJoin.has(topic)) { this.cb?.('CHANNEL_ERROR'); return; } // 권한 없는 토픽(팀에서 빠진 공간 등)
          this.joined = true; this.cb?.('SUBSCRIBED');
        };
        if (s.holdJoin.has(topic)) { s.held.set(topic, go); return this; } // 시험이 release(topic)로 가입을 끝낸다
        queueMicrotask(go);
        return this;
      },
      presenceState() { return {}; },
    };
    s.channels.add(ch);
    return ch;
  };
  s.denyJoin = new Set(); s.holdJoin = new Set(); s.held = new Map();
  // Realtime(phoenix)는 오류 난 채널을 닫지 않으면 rejoinTimer로 계속 다시 가입한다 — 그 한 번을 흉내 낸다
  s.tickRejoin = () => { for (const ch of [...s.channels]) if (!ch.joined && ch.cb) ch.subscribe(ch.cb); };
  s.release = (topic) => { const f = s.held.get(topic); s.held.delete(topic); s.holdJoin.delete(topic); f?.(); };
  s.removeChannel = (ch) => { const was = s.channels.delete(ch); ch.joined = false; if (was) ch.cb?.('CLOSED'); return Promise.resolve('ok'); };
  return s;
}

function setup({ fake = fakeSupabase(), appVersion = '0.2.0', storage = memStorage(), clock = fakeClock(), random = () => 0.999999 } = {}) {
  const m = createLinkMachine({ client: fake, userId: UID, appVersion, storage, clock, random });
  const got = []; const states = [];
  m.on('messages', (e) => got.push(e));
  m.on('state', (s) => states.push(s.state));
  return { m, fake, clock, storage, got, states, ids: () => got.flatMap((e) => e.messages.map((x) => x.id)) };
}

test('정상 시작: 최소 버전 → 중단 확인 → 등록 → u:<uid> 1개 구독 → 따라잡기 1회 → ready', async () => {
  const { m, fake, states } = setup();
  await m.start(); await flush();
  assert.equal(m.getState(), 'ready');
  assert.deepEqual(fake.log.map((l) => l.name), ['argo_min_app_version', 'msgr2_service_pause', 'msgr2_device_register', 'msgr2_catch_up']);
  assert.deepEqual(fake.log[0].args, { p_app: 'messenger' });
  assert.equal(fake.log[3].args.p_since_id, null, '처음 기기는 since 없이(서버가 방별 최근 200개)');
  assert.deepEqual(fake.liveTopics(), [`v2:u:${UID}`]);
  assert.equal([...fake.channels][0].opts.config.private, true);
  assert.deepEqual(states, ['connecting', 'registering', 'subscribing', 'catching_up', 'ready']);
  const reg = fake.log[2].args;
  assert.equal(reg.p_kind, 'app'); assert.equal(reg.p_app, 'messenger'); assert.equal(reg.p_app_version, '0.2.0');
  assert.equal(reg.p_link_min, null, '앱은 약속 범위를 싣지 않는다(U3: 실으면 msgr2_device_invalid)'); assert.equal(reg.p_link_max, null);
});

test('유휴 10분: 요청 0·타이머 0, 방송으로 온 글은 요청 없이 받는다', async () => {
  const { m, fake, clock, ids } = setup();
  await m.start(); await flush();
  const n = fake.log.length;
  await clock.advance(10 * MIN);
  assert.equal(fake.log.length, n, '쉬는 동안 REST·RPC 0');
  assert.equal(clock.pending(), 0, '주기 타이머 없음');
  const msg = fake.insertMessage({ body: 'hello' }); await flush();
  assert.deepEqual(ids(), [msg.id]);
  assert.equal(fake.log.length, n, '본문이 실린 방송은 조회 0');
  await clock.advance(10 * MIN);
  assert.equal(fake.log.length, n);
});

test('경우 11: 5분 끊김 → 간격 두고 재연결(끊긴 동안 REST 0) → 따라잡기 1회, 중복 0, 200 초과는 더 있음', async () => {
  const storage = memStorage();
  const { m, fake, clock, got, ids } = setup({ storage });
  fake.insertMessage({ room: ROOM_A, body: 'before' });
  await m.start(); await flush();
  assert.deepEqual(ids(), [100]);
  const before = fake.log.length;

  fake.net.down = true; fake.dropSockets(); await flush();
  assert.equal(m.getState(), 'disconnected');
  // 끊긴 동안 서버에 쌓인 글(방송은 못 받음): A 250개, B 3개
  fake.net.down = false; // 서버 쪽 쓰기는 되게 잠깐 열었다 닫는다(방송은 소켓이 없어 못 받는다)
  for (let i = 0; i < 250; i++) fake.insertMessage({ room: ROOM_A, body: `a${i}` });
  for (let i = 0; i < 3; i++) fake.insertMessage({ room: ROOM_B, body: `b${i}` });
  fake.net.down = true;
  await clock.advance(5 * MIN);
  assert.equal(fake.log.length, before, '끊긴 5분 동안 REST·RPC 0(가입 시도만 간격을 두고)');
  const tries = fake.joins.length;
  assert.ok(tries <= 1 + RECONNECT.maxAttempts + 1, `가입 시도가 상한 안: ${tries}`);
  assert.equal(m.getSnapshot().reason?.startsWith('gave_up'), true, '상한을 넘기면 타이머 없이 멈춘다');
  assert.equal(clock.pending(), 0);

  // 네트워크가 돌아옴 → online nudge → 재연결. 따라잡기 응답을 만들기 직전에 새 글 1개(방송과 따라잡기 양쪽에 실린다)
  fake.net.down = false;
  const mark = got.length;
  let racer = null;
  fake.hooks.msgr2_catch_up = () => { if (!racer) racer = fake.insertMessage({ room: ROOM_B, body: 'race' }); };
  assert.equal(m.nudge(), true);
  await flush();
  assert.equal(m.getState(), 'ready');
  const after = fake.log.slice(before).map((l) => l.name);
  assert.deepEqual(after, ['msgr2_catch_up'], '다시 붙을 때 요청은 따라잡기 1회뿐(등록은 하루 안이면 다시 안 함)');
  assert.equal(fake.log.at(-1).args.p_since_id, 100, '마지막으로 받은 글 id부터');
  const all = ids();
  assert.equal(new Set(all).size, all.length, '중복 0');
  const a = got.slice(mark).filter((e) => e.roomId === ROOM_A && e.source === 'catch_up');
  assert.equal(a.length, 1); assert.equal(a[0].messages.length, 200); assert.equal(a[0].more, true, '200 초과 = 더 있음');
  assert.ok(m.getSnapshot().moreRooms.includes(ROOM_A));
  const b = got.filter((e) => e.roomId === ROOM_B).flatMap((e) => e.messages.map((x) => x.body));
  assert.deepEqual(b.sort(), ['b0', 'b1', 'b2', 'race'].sort(), 'B 방 글 전부, race 글은 한 번만');
  assert.equal(Number(storage.getItem(LAST_ID_KEY(UID))), racer.id, '마지막 글 id는 로컬에 저장(서버 커서 행 없음)');
  assert.equal(fake.log.some((l) => /cursor|read/.test(l.name)), false);
});

test('재시작: 로컬에 둔 마지막 글 id부터 따라잡는다', async () => {
  const storage = memStorage(); storage.setItem(LAST_ID_KEY(UID), '150');
  const { m, fake } = setup({ storage });
  await m.start(); await flush();
  assert.equal(fake.log.find((l) => l.name === 'msgr2_catch_up').args.p_since_id, 150);
});

test('경우 10: 시작할 때 중단 스위치 켜짐 → paused, 등록·구독·조회 0, 보내기 0, 10분 요청 0', async () => {
  const fake = fakeSupabase({ paused: true });
  const { m, clock } = setup({ fake });
  await m.start(); await flush();
  assert.equal(m.getState(), 'paused');
  assert.deepEqual(fake.log.map((l) => l.name), ['argo_min_app_version', 'msgr2_service_pause']);
  assert.deepEqual(fake.joins, []);
  const r = await m.send({ roomId: ROOM_A, body: 'x' });
  assert.equal(r.ok, false); assert.equal(r.code, 'service_paused');
  assert.equal(m.nudge(), false, '확인 직후 nudge는 묻지 않는다(상한 간격 안)');
  await clock.advance(10 * MIN);
  assert.equal(fake.log.length, 2, '중단 중 요청 0');
  assert.equal(m.nudge(), true, '사건(online)이 오면 상한 간격 뒤 한 번만 묻는다');
  assert.equal(m.nudge(), false); await flush();
  assert.deepEqual(fake.log.slice(2).map((l) => l.name), ['msgr2_service_pause']);
  assert.equal(m.getState(), 'paused');
  fake.db.paused = false;
  await m.setForeground(false); await m.setForeground(true); await flush();
  assert.equal(m.getState(), 'ready', '풀린 뒤 앞으로 오면 다시 묻고 연결한다');
  assert.deepEqual(fake.log.slice(3).map((l) => l.name), ['msgr2_service_pause', 'msgr2_device_register', 'msgr2_catch_up']);
});

test('경우 10: u: 방송으로 중단 → 받은 글 표지·본문 없는 글도 조회 0, 보내기 0 / 풀림 방송 → 따라잡기 1회', async () => {
  const { m, fake, clock, ids } = setup();
  await m.start(); await flush();
  const n = fake.log.length;
  fake.broadcast(`v2:u:${UID}`, 'pause', { paused: true }); await flush();
  assert.equal(m.getState(), 'paused');
  fake.db.paused = true;
  fake.insertMessage({ body: 'during' }); fake.insertMessage({ bodyless: true }); await flush();
  const r = await m.send({ roomId: ROOM_A, body: 'x' });
  assert.equal(r.code, 'service_paused');
  await clock.advance(10 * MIN);
  assert.equal(fake.log.length, n, '중단 중 조회·보내기 요청 0');
  assert.deepEqual(ids(), []);
  assert.deepEqual(fake.liveTopics(), [`v2:u:${UID}`], 'u: 소켓은 열린 채(DB 요청 아님) 풀림을 기다린다');
  fake.db.paused = false;
  fake.broadcast(`v2:u:${UID}`, 'pause', { paused: false }); await flush();
  assert.equal(m.getState(), 'ready');
  assert.deepEqual(fake.log.slice(n).map((l) => l.name), ['msgr2_catch_up']);
  assert.equal(ids().length, 2, '중단 중 놓친 글은 풀린 뒤 따라잡기로');
});

test('경우 10: 보내기가 service_paused로 거부되면 paused로 두고 다시 보내지 않는다', async () => {
  const { m, fake } = setup();
  await m.start(); await flush();
  fake.fail['insert:msgr2_messages'] = [{ error: { code: 'P0001', message: 'service_paused' }, status: 400 }];
  const r = await m.send({ roomId: ROOM_A, body: 'x' });
  assert.equal(r.ok, false); assert.equal(r.code, 'service_paused'); assert.equal(r.attempts, 1);
  assert.equal(m.getState(), 'paused');
  assert.equal(fake.count('insert:msgr2_messages'), 1);
});

test('경우 5: 최소 버전 미만 → update_required, 등록·구독 0, 그 뒤 요청 0', async () => {
  const fake = fakeSupabase({ minVersion: '0.3.0' });
  const { m, clock } = setup({ fake, appVersion: '0.2.0' });
  await m.start(); await flush();
  assert.equal(m.getState(), 'update_required');
  assert.deepEqual(fake.log.map((l) => l.name), ['argo_min_app_version']);
  assert.deepEqual(fake.joins, []);
  assert.equal(fake.count('msgr2_device_register'), 0);
  await clock.advance(10 * MIN); await m.setForeground(false); await m.setForeground(true); m.nudge();
  assert.equal((await m.send({ roomId: ROOM_A, body: 'x' })).code, 'update_required');
  assert.equal(fake.log.length, 1);
});

test('경우 5: 버전 확인이 실패해도 등록 RPC가 같은 값으로 거부하면 update_required', async () => {
  const fake = fakeSupabase({ minVersion: '0.3.0' });
  fake.fail.argo_min_app_version = [{ error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }];
  const { m } = setup({ fake, appVersion: '0.2.0' });
  await m.start(); await flush();
  assert.equal(m.getState(), 'update_required');
  assert.deepEqual(fake.joins, []);
});

test('경우 19: u: 방송으로 이 기기 폐기 → 소켓 닫힘·signed_out, 그 뒤 요청·가입 0', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  const ev = []; m.on('event', (e) => ev.push(e));
  fake.broadcast(`v2:u:${UID}`, 'device_revoked', { device_id: 'dev-other' }); await flush();
  assert.equal(m.getState(), 'ready', '다른 기기 폐기는 목록 사건으로만');
  assert.equal(ev[0].event, 'device_revoked');
  const n = fake.log.length; const j = fake.joins.length;
  fake.broadcast(`v2:u:${UID}`, 'device_revoked', { device_id: 'dev-1' }); await flush();
  assert.equal(m.getState(), 'signed_out');
  assert.deepEqual(fake.liveTopics(), [], '소켓 닫힘');
  fake.insertMessage(); await m.setForeground(false); await m.setForeground(true); m.nudge();
  assert.equal((await m.send({ roomId: ROOM_A, body: 'x' })).code, 'device_revoked');
  await clock.advance(10 * MIN);
  assert.equal(fake.log.length, n); assert.equal(fake.joins.length, j); assert.equal(clock.pending(), 0);
});

test('경우 19: 사용자 전체 폐기(all) 방송과 device_revoked 오류도 signed_out', async () => {
  const a = setup(); await a.m.start(); await flush();
  a.fake.broadcast(`v2:u:${UID}`, 'device_revoked', { all: true }); await flush();
  assert.equal(a.m.getState(), 'signed_out');

  const b = setup(); b.fake.fail.msgr2_catch_up = [{ error: { code: 'P0001', message: 'device_revoked' }, status: 400 }];
  await b.m.start(); await flush();
  assert.equal(b.m.getState(), 'signed_out'); assert.deepEqual(b.fake.liveTopics(), []);
});

test('경우 19: U1 자리 함수 오류(msgr2_device_invalid) → 다시 등록 → 등록이 device_revoked면 signed_out', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  fake.fail['insert:msgr2_messages'] = [{ error: { code: '42501', message: 'msgr2_device_invalid' }, status: 403 }];
  fake.db.revokedSession = true;
  const r = await m.send({ roomId: ROOM_A, body: 'x' });
  assert.equal(r.ok, false); assert.equal(r.code, 'device_unknown'); assert.equal(r.attempts, 1);
  await clock.advance(RECONNECT.baseMs);
  assert.equal(m.getState(), 'signed_out');
  assert.equal(fake.count('msgr2_device_register'), 2);
});

test('재연결 간격: 지수로 늘고 상한 60초, 상한 횟수를 넘으면 타이머 없이 멈춘다(가입 실패 동안 REST 0)', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  const n = fake.log.length;
  fake.net.down = true; fake.dropSockets(); await flush();
  const at = [];
  const orig = fake.channel; fake.channel = (topic, o) => { at.push(clock.now()); return orig(topic, o); };
  await clock.advance(30 * MIN);
  const gaps = at.map((t, i) => t - (i ? at[i - 1] : at[0] - 1000));
  assert.deepEqual(gaps, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(at.length, RECONNECT.maxAttempts);
  assert.ok(Math.max(...gaps) <= RECONNECT.maxMs);
  assert.equal(clock.pending(), 0); assert.match(m.getSnapshot().reason, /^gave_up/);
  assert.equal(fake.log.length, n, '가입이 실패하는 동안 따라잡기·등록 요청 0');
});

test('nudge는 대기 중인 간격을 건너뛰지 않는다 — 멈춘 뒤에도 마지막 시도에서 상한 간격이 지나야 1회', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  fake.net.down = true; fake.dropSockets(); await flush();
  await clock.advance(1000 + 2000); // 두 번 실패 → 다음은 4초 뒤
  const j = fake.joins.length;
  for (let i = 0; i < 20; i++) assert.equal(m.nudge(), false);
  await flush();
  assert.equal(fake.joins.length, j, '대기 중 nudge 20번 → 가입 시도 0');
  await clock.advance(3999); assert.equal(fake.joins.length, j);
  await clock.advance(1); assert.equal(fake.joins.length, j + 1, '간격이 지나면 정확히 1번');
  await clock.advance(30 * MIN); // 상한 횟수를 넘겨 멈춤
  assert.match(m.getSnapshot().reason, /^gave_up/);
  assert.equal(m.nudge(), true, '멈춘 뒤 오래 지났으면 1회 시도'); await flush();
  assert.match(m.getSnapshot().reason, /^gave_up/, '그 1회가 실패하면 바로 다시 멈춘다(새 연속 시도 없음)');
  assert.equal(clock.pending(), 0);
  const g = fake.joins.length;
  assert.equal(m.nudge(), false, '마지막 시도 직후 nudge는 무시'); await flush();
  assert.equal(fake.joins.length, g);
  fake.net.down = false;
  await clock.advance(RECONNECT.maxMs);
  assert.equal(m.nudge(), true); await flush();
  assert.equal(fake.joins.length, g + 1);
  assert.equal(m.getState(), 'ready');
});

test('뒤로 감: 소켓 닫힘·타이머 0·요청 0 / 앞으로 옴: 구독 → 따라잡기 1회만', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  const n = fake.log.length;
  await m.setForeground(false); await flush();
  assert.equal(m.getState(), 'background');
  assert.deepEqual(fake.liveTopics(), []);
  fake.insertMessage(); fake.insertMessage({ room: ROOM_B });
  await clock.advance(30 * MIN);
  assert.equal(fake.log.length, n); assert.equal(clock.pending(), 0);
  await m.setForeground(true); await flush();
  assert.equal(m.getState(), 'ready');
  assert.deepEqual(fake.log.slice(n).map((l) => l.name), ['msgr2_catch_up']);
  // 하루가 지난 뒤 앞으로 오면 등록을 한 번 더(서버 만료 30일)
  await m.setForeground(false); await clock.advance(25 * 60 * MIN); await m.setForeground(true); await flush();
  assert.deepEqual(fake.log.slice(n + 1).map((l) => l.name), ['msgr2_device_register', 'msgr2_catch_up']);
});

test('보내기 멱등: 서버에 들어간 뒤 답이 끊겨도 같은 client_msg_id로 다시 보내 한 벌만', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  fake.fail['insert:msgr2_messages'] = [{ error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0, commit: true }];
  const p = m.send({ roomId: ROOM_A, body: 'once', clientMsgId: 'cm-1' });
  await clock.advance(SEND_RETRY.maxMs);
  const r = await p;
  assert.equal(r.ok, true); assert.equal(r.duplicate, true); assert.equal(r.attempts, 2);
  assert.equal(fake.db.messages.filter((x) => x.client_msg_id === 'cm-1').length, 1);
  const again = await m.send({ roomId: ROOM_A, body: 'once', clientMsgId: 'cm-1' });
  assert.equal(again.ok, true); assert.equal(again.duplicate, true);
  assert.equal(fake.db.messages.filter((x) => x.client_msg_id === 'cm-1').length, 1);
});

test('보내기 재시도: 다시 보낼 코드(503·429)만 간격·상한 안에서, 그 밖은 1회', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  fake.fail['insert:msgr2_messages'] = Array.from({ length: 10 }, () => ({ error: { message: 'Service Unavailable' }, status: 503 }));
  const t0 = clock.now();
  const p = m.send({ roomId: ROOM_A, body: 'x' });
  await clock.advance(10 * MIN);
  const r = await p;
  assert.equal(r.ok, false); assert.equal(r.code, 'internal'); assert.equal(r.attempts, SEND_RETRY.maxAttempts);
  assert.equal(fake.count('insert:msgr2_messages'), SEND_RETRY.maxAttempts, '상한 5회');
  void t0;
  fake.fail['insert:msgr2_messages'] = [{ error: { message: 'Too Many Requests' }, status: 429 }];
  const p2 = m.send({ roomId: ROOM_A, body: 'y' }); await clock.advance(SEND_RETRY.maxMs);
  assert.equal((await p2).ok, true);
  const before = fake.count('insert:msgr2_messages');
  for (const err of [{ error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 }, { error: { code: 'P0001', message: 'tier_denied' }, status: 400 }]) {
    fake.fail['insert:msgr2_messages'] = [err];
    const r3 = await m.send({ roomId: ROOM_A, body: 'z' });
    assert.equal(r3.ok, false); assert.equal(r3.attempts, 1);
  }
  assert.equal(fake.count('insert:msgr2_messages'), before + 2, '다시 보내지 않는 거부는 1회');
  assert.equal(m.getState(), 'ready');
});

test('업로드(U6a): 글을 먼저 넣고 msgr2_attachment_add가 준 경로에만 올린다 — 올리기가 끊겨 다시 보내도 글·첨부 행·파일 한 벌', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  fake.fail['upload:msgr'] = [{ error: { name: 'StorageUnknownError', message: 'Failed to fetch' } }]; // 첫 파일 올리기가 끊긴다(행은 이미 있다)
  const files = [{ name: 'a.png', mime: 'image/png', bytes: 3, data: 'AAA' }, { name: 'b/c.txt', mime: 'text/plain', bytes: 1, data: 'B' }];
  const p = m.send({ roomId: ROOM_A, body: 'files', clientMsgId: 'cm-f', files });
  await clock.advance(SEND_RETRY.maxMs);
  const r = await p;
  assert.equal(r.ok, true, JSON.stringify(r));
  const msg = fake.db.messages.filter((x) => x.client_msg_id === 'cm-f'); assert.equal(msg.length, 1, '글 한 벌');
  const atts = fake.db.attachments.filter((x) => x.message_id === msg[0].id); assert.equal(atts.length, 2, '첨부 행 한 벌(서버가 (글, 순번) 멱등)');
  assert.deepEqual([...fake.db.files.keys()].sort(), [`sp/${ROOM_A}/${msg[0].id}/0-a.png`, `sp/${ROOM_A}/${msg[0].id}/1-b_c.txt`], '서버가 정한 경로에만');
  assert.deepEqual(r.attachments.map((x) => x.path), [`sp/${ROOM_A}/${msg[0].id}/0-a.png`, `sp/${ROOM_A}/${msg[0].id}/1-b_c.txt`]);
  assert.equal(fake.count('insert:msgr2_attachments'), 0, '첨부 표에 직접 넣지 않는다(U1이 막는다)');
  const order = fake.log.filter((l) => ['insert:msgr2_messages', 'msgr2_attachment_add', 'upload:msgr'].includes(l.name)).map((l) => l.name);
  assert.equal(order[0], 'insert:msgr2_messages', '글이 먼저');
});

test('업로드(U6a): 첫 파일은 올라갔는데 둘째 첨부 RPC가 끊김 → 다시 보내면 첫 파일은 409(이미 있음)를 성공으로 보고 둘째만 올린다', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  let n = 0; fake.hooks.msgr2_attachment_add = () => { n++; if (n === 2) fake.fail.msgr2_attachment_add = [{ error: { message: 'upstream' }, status: 503 }]; };
  const files = [{ name: 'a.png', mime: 'image/png', bytes: 3, data: 'AAA' }, { name: 'b.txt', mime: 'text/plain', bytes: 1, data: 'B' }];
  const p = m.send({ roomId: ROOM_A, body: 'two', clientMsgId: 'cm-h', files });
  await clock.advance(SEND_RETRY.maxMs);
  const r = await p;
  assert.equal(r.ok, true, JSON.stringify(r));
  const id = fake.db.messages.find((x) => x.client_msg_id === 'cm-h').id;
  assert.equal(fake.db.attachments.filter((a) => a.message_id === id).length, 2);
  assert.equal(fake.db.files.size, 2);
  const ups = fake.log.filter((l) => l.name === 'upload:msgr').map((l) => l.path);
  assert.deepEqual(ups, [`sp/${ROOM_A}/${id}/0-a.png`, `sp/${ROOM_A}/${id}/0-a.png`, `sp/${ROOM_A}/${id}/1-b.txt`], '첫 파일은 다시 시도(409 = 성공), 바이트를 덮어쓰지 않는다');
  assert.equal(fake.db.files.get(`sp/${ROOM_A}/${id}/0-a.png`), 'AAA');
});

test('업로드(U6a): 첨부 RPC가 거부하면(남의 글 등) 다시 보내지 않고 실패로 낸다', async () => {
  const { m, fake } = setup();
  await m.start(); await flush();
  fake.fail.msgr2_attachment_add = [{ error: { code: '42501', message: 'msgr2_message_not_found' }, status: 403 }];
  const r = await m.send({ roomId: ROOM_A, body: 'x', clientMsgId: 'cm-g', files: [{ name: 'a.png', mime: 'image/png', bytes: 1, data: 'A' }] });
  assert.equal(r.ok, false); assert.equal(fake.count('upload:msgr'), 0); assert.equal(fake.count('msgr2_attachment_add'), 1, '재시도 0');
});

test('본문이 큰 글(방송에 id만) → 그 글 하나만 1회 읽는다', async () => {
  const { m, fake, ids } = setup();
  await m.start(); await flush();
  const n = fake.log.length;
  const big = fake.insertMessage({ bodyless: true }); await flush();
  assert.deepEqual(fake.log.slice(n).map((l) => l.name), ['select:msgr2_messages']);
  assert.deepEqual(ids(), [big.id]);
});

test('배지: 다른 사람 글은 보고 있지 않은 방에서만 센다, 방을 열면 지운다', async () => {
  const { m, fake } = setup();
  const badges = []; m.on('badge', (b) => badges.push(b.total));
  await m.start(); await flush();
  m.setActiveRoom(ROOM_A);
  fake.insertMessage({ room: ROOM_A }); fake.insertMessage({ room: ROOM_B }); fake.insertMessage({ room: ROOM_B }); fake.insertMessage({ room: ROOM_B, author: UID });
  await flush();
  assert.deepEqual(m.getSnapshot().badge, { total: 2, rooms: { [ROOM_B]: 2 } });
  m.setActiveRoom(ROOM_B);
  assert.equal(m.getSnapshot().badge.total, 0);
  assert.equal(badges.at(-1), 0);
  assert.equal(fake.log.some((l) => l.kind === 'rest'), false, '배지는 요청 없이 계산');
});

test('일 화면: 볼 때만 wk:<일>·pr:<주인>을 구독하고, 뒤로 가면 닫았다가 다시 붙을 때 다시 가입', async () => {
  const { m, fake } = setup();
  const prog = []; m.on('progress', (p) => prog.push(p));
  await m.start(); await flush();
  const off = m.watchWork('w-1', { owner: OTHER }); await flush();
  assert.deepEqual(fake.liveTopics(), [`pr:${OTHER}`, `v2:u:${UID}`, 'v2:wk:w-1'].sort());
  fake.broadcast('v2:wk:w-1', 'progress', { stage: 'tool' }); await flush();
  assert.deepEqual(prog.map((p) => p.payload.stage), ['tool']);
  await m.setForeground(false); assert.deepEqual(fake.liveTopics(), []);
  await m.setForeground(true); await flush();
  assert.deepEqual(fake.liveTopics(), [`pr:${OTHER}`, `v2:u:${UID}`, 'v2:wk:w-1'].sort());
  off(); assert.deepEqual(fake.liveTopics(), [`v2:u:${UID}`]);
});

// ── 분리 검수 지적 반영(1~5) ─────────────────────────────────────────────────
test('검수 1: 따라잡기가 계속 실패해도 간격이 커지고 상한 횟수에서 멈춘다(붙자마자 0으로 돌아가지 않는다)', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  fake.fail.msgr2_catch_up = Array.from({ length: 100 }, () => ({ error: { message: 'boom' }, status: 500 }));
  fake.dropSockets(); await flush();
  await clock.advance(10 * MIN);
  assert.ok(fake.count('msgr2_catch_up') <= 1 + RECONNECT.maxAttempts, `10분 따라잡기 ${fake.count('msgr2_catch_up')}회`);
  assert.match(m.getSnapshot().reason, /^gave_up/); assert.equal(clock.pending(), 0);
  // 만료 토큰 401 같은 일시 거부도 바로 포기하지 않고 간격을 두고 다시 붙는다(재검수 1) — 회복되면 ready
  const b = setup(); b.fake.fail.msgr2_catch_up = [1, 2, 3].map(() => ({ error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 }));
  await b.m.start(); await b.clock.advance(10 * MIN);
  assert.equal(b.fake.count('msgr2_catch_up'), 4); assert.equal(b.m.getState(), 'ready'); assert.equal(b.clock.pending(), 0);
  const c = setup(); c.fake.fail.msgr2_catch_up = Array.from({ length: 100 }, () => ({ error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 }));
  await c.m.start(); await c.clock.advance(30 * MIN);
  assert.ok(c.fake.count('msgr2_catch_up') <= 1 + RECONNECT.maxAttempts, '계속 거부돼도 상한 안'); assert.match(c.m.getSnapshot().reason, /^gave_up/); assert.equal(c.clock.pending(), 0);
});

test('검수 2: id만 온 글을 못 읽은 사이 뒤 글이 와도, 다시 붙은 따라잡기가 그 글부터 가져온다', async () => {
  const storage = memStorage();
  const { m, fake, clock, ids } = setup({ storage });
  await m.start(); await flush();
  fake.fail['select:msgr2_messages'] = [{ error: { message: 'upstream' }, status: 503 }];
  const big = fake.insertMessage({ bodyless: true }); const next = fake.insertMessage({ body: 'after' });
  await flush();
  assert.deepEqual(ids(), [next.id]);
  assert.equal(Number(storage.getItem(LAST_ID_KEY(UID))), big.id - 1, '로컬 기준도 빈 곳 앞(재시작해도 안 빠진다)');
  await clock.advance(RECONNECT.maxMs);
  assert.equal(m.getState(), 'ready');
  assert.equal(fake.log.filter((l) => l.name === 'msgr2_catch_up').at(-1).args.p_since_id, big.id - 1);
  assert.deepEqual(ids().sort((a, b) => a - b), [big.id, next.id], '빠짐 0·중복 0');
  assert.equal(Number(storage.getItem(LAST_ID_KEY(UID))), next.id);
});

test('검수 3: 중단 중 소켓이 끊기면 소켓만 간격 두고 다시 열고(중단 표지 1회), 풀림 방송을 받는다', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  fake.broadcast(`v2:u:${UID}`, 'pause', { paused: true }); fake.db.paused = true; await flush();
  const n = fake.log.length;
  fake.dropSockets(); await flush();
  assert.equal(m.getState(), 'paused');
  await clock.advance(60 * MIN);
  assert.deepEqual(fake.liveTopics(), [`v2:u:${UID}`], '소켓 다시 열림');
  assert.deepEqual(fake.log.slice(n).map((l) => l.name), ['msgr2_service_pause'], '끊김 1번 = 중단 표지 1회, 그 밖 REST 0');
  assert.equal(m.getState(), 'paused'); assert.equal(clock.pending(), 0);
  fake.db.paused = false;
  fake.broadcast(`v2:u:${UID}`, 'pause', { paused: false }); await flush();
  assert.equal(m.getState(), 'ready');
  assert.deepEqual(fake.log.slice(n + 1).map((l) => l.name), ['msgr2_catch_up']);
});

test('검수 4: 이미 받은 글의 고침·지움 방송은 갱신으로 낸다', async () => {
  const { m, fake, got } = setup();
  await m.start(); await flush();
  const msg = fake.insertMessage({ body: 'v1' }); await flush();
  fake.broadcast(`v2:u:${UID}`, 'msg', { message: { ...msg, body: 'v2', edited_at: '2026-10-17T07:00:00Z' } });
  fake.broadcast(`v2:u:${UID}`, 'msg', { message: { id: msg.id, room_id: msg.room_id, deleted_at: '2026-10-17T07:01:00Z' } });
  fake.broadcast(`v2:u:${UID}`, 'msg', { message: msg }); // 같은 새 글 다시 — 중복 0
  await flush();
  const ups = got.filter((e) => e.source === 'update').map((e) => e.messages[0]);
  assert.deepEqual(ups.map((x) => x.body ?? 'deleted'), ['v2', 'deleted']);
  assert.equal(got.filter((e) => e.source === 'broadcast').length, 1);
  assert.equal(m.getSnapshot().badge.total, 1, '갱신은 배지를 늘리지 않는다');
});

test('검수 5: 보내기 재시도 대기 중 뒤로 가면 더 보내지 않는다', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  fake.fail['insert:msgr2_messages'] = Array.from({ length: 10 }, () => ({ error: { message: 'x' }, status: 503 }));
  const p = m.send({ roomId: ROOM_A, body: 'x' }); await flush();
  assert.equal(fake.count('insert:msgr2_messages'), 1);
  await m.setForeground(false);
  const r = await p;
  await clock.advance(10 * MIN);
  assert.equal(r.ok, false); assert.equal(r.code, 'background');
  assert.equal(fake.count('insert:msgr2_messages'), 1);
});

test('검수 3: 소켓이 끊긴 사이 풀림 방송을 놓쳐도, 다시 연 직후 중단 표지 1회로 풀린 것을 안다', async () => {
  const { m, fake, clock } = setup();
  await m.start(); await flush();
  fake.broadcast(`v2:u:${UID}`, 'pause', { paused: true }); fake.db.paused = true; await flush();
  const n = fake.log.length;
  fake.dropSockets(); fake.db.paused = false; await flush(); // 풀림 방송은 소켓이 없어 못 받음
  await clock.advance(60 * MIN);
  assert.equal(m.getState(), 'ready');
  assert.deepEqual(fake.log.slice(n).map((l) => l.name), ['msgr2_service_pause', 'msgr2_catch_up']);
  assert.equal(clock.pending(), 0);
});

// ── 검수 2(2026-10-17 15:58) 반영 — U3 등록 거부 규칙 ─────────────────────────────
test('검수2-1: 등록 값 모양 오류(22023 msgr2_device_invalid)는 로그아웃이 아니라 멈춤(gave_up:invalid), 재시도 0', async () => {
  const fake = fakeSupabase();
  fake.fail.msgr2_device_register = [{ error: { code: '22023', message: 'msgr2_device_invalid' }, status: 400 }];
  const { m, clock } = setup({ fake });
  await m.start(); await clock.advance(10 * MIN);
  assert.equal(m.getState(), 'disconnected'); assert.equal(m.getSnapshot().reason, 'gave_up:invalid');
  assert.equal(fake.count('msgr2_device_register'), 1); assert.equal(clock.pending(), 0);
  // 보내기·조회 경로의 U1 자리 함수 오류(42501 msgr2_device_invalid)는 그대로 "다시 등록" 갈래
  const b = setup(); await b.m.start(); await flush();
  b.fake.fail['insert:msgr2_messages'] = [{ error: { code: '42501', message: 'msgr2_device_invalid' }, status: 403 }];
  assert.equal((await b.m.send({ roomId: ROOM_A, body: 'x' })).code, 'device_unknown');
  await b.clock.advance(RECONNECT.baseMs);
  assert.equal(b.m.getState(), 'ready'); assert.equal(b.fake.count('msgr2_device_register'), 2);
});

test('검수2-2: 다시 로그인해야 하는 등록 거부 3종 → signed_out(login_required), 소켓·재시도 0', async () => {
  const cases = [
    ['10분 지난 세션의 새 기기(device_login_required)', fakeSupabase({ session: { id: 'sess-old', ageMin: 30 } })],
    ['JWT에 session_id 없음(msgr2_session_required)', fakeSupabase({ session: { id: null, ageMin: 0 } })],
    ['같은 세션이 다른 종류로 등록됨(msgr2_device_kind_locked)', (() => { const f = fakeSupabase(); f.db.bySession.set('sess-1', { id: 'dev-r', kind: 'runner', app: 'desktop' }); return f; })()],
  ];
  for (const [label, fake] of cases) {
    const { m, clock } = setup({ fake });
    await m.start(); await clock.advance(10 * MIN); await m.setForeground(false); await m.setForeground(true); m.nudge(); await flush();
    assert.equal(m.getState(), 'signed_out', label); assert.equal(m.getSnapshot().reason, 'login_required', label);
    assert.equal(fake.count('msgr2_device_register'), 1, `${label}: 재시도 0`);
    assert.deepEqual(fake.joins, [], `${label}: 소켓 0`); assert.equal(clock.pending(), 0);
    assert.equal((await m.send({ roomId: ROOM_A, body: 'x' })).ok, false);
    assert.equal(fake.log.filter((l) => l.kind === 'rest').length, 0);
  }
  const fresh = setup({ fake: fakeSupabase({ session: { id: 'sess-new', ageMin: 5 } }) });
  await fresh.m.start(); await flush();
  assert.equal(fresh.m.getState(), 'ready', '10분 안 세션은 새 기기로 등록된다');
});

test('검수2-3: 등록의 만료 토큰 401(PGRST301)은 간격·상한 안에서 다시 붙는다', async () => {
  const fake = fakeSupabase();
  fake.fail.msgr2_device_register = [1, 2].map(() => ({ error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 }));
  const { m, clock } = setup({ fake });
  await m.start(); await flush();
  assert.equal(m.getState(), 'disconnected');
  await clock.advance(10 * MIN);
  assert.equal(m.getState(), 'ready'); assert.equal(fake.count('msgr2_device_register'), 3); assert.equal(clock.pending(), 0);
  const c = fakeSupabase(); c.fail.msgr2_device_register = Array.from({ length: 50 }, () => ({ error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 }));
  const x = setup({ fake: c }); await x.m.start(); await x.clock.advance(30 * MIN);
  assert.ok(c.count('msgr2_device_register') <= 1 + RECONNECT.maxAttempts); assert.match(x.m.getSnapshot().reason, /^gave_up/);
});

test('U6a next_since: 따라잡기 기준은 서버 next_since — 최근 글은 다음 따라잡기에 다시 와도 중복 0, 재시작도 그 기준부터', async () => {
  const fake = fakeSupabase(); const storage = memStorage();
  for (let i = 0; i < 5; i++) fake.insertMessage({ body: `m${i}` }); // id 100..104
  fake.db.nextSince = 102; // 103·104는 60초 안 — 서버가 기준을 102에서 멈춘다
  const a = setup({ fake, storage });
  await a.m.start(); await flush();
  assert.deepEqual(a.ids(), [100, 101, 102, 103, 104]);
  assert.equal(storage.getItem(LAST_ID_KEY(UID)), '102', '저장하는 기준 = next_since(받은 최대 id 104가 아니다)');
  assert.equal(a.m.getSnapshot().lastId, 104, '화면용 최대 id는 그대로');
  a.fake.dropSockets(); await a.clock.advance(RECONNECT.maxMs);
  const calls = a.fake.log.filter((l) => l.name === 'msgr2_catch_up');
  assert.equal(calls.at(-1).args.p_since_id, 102, '다시 붙은 따라잡기는 102부터(103·104가 다시 온다)');
  assert.deepEqual(a.ids(), [100, 101, 102, 103, 104], '다시 온 103·104는 중복으로 걸러진다');
  a.m.stop();
  const b = setup({ fake: fakeSupabase(), storage }); await b.m.start(); await flush();
  assert.equal(b.fake.log.find((l) => l.name === 'msgr2_catch_up').args.p_since_id, 102, '재시작도 저장한 기준부터');
});

test('U6a next_since: 커밋이 늦은 작은 id 글 — 끊긴 사이 보인 102를 다음 따라잡기가 가져온다(최대 id 기준이면 빠진다)', async () => {
  const fake = fakeSupabase();
  fake.insertMessage({ body: 'a' }); fake.insertMessage({ body: 'b' }); // 100, 101
  fake.db.nextSince = 101;
  const { m, clock, ids } = setup({ fake });
  await m.start(); await flush();
  // 104가 먼저 커밋되어 방송으로 오고, 102·103은 늦게 커밋된다(방송은 끊긴 사이에 지나갔다)
  const late = [{ id: 102 }, { id: 103 }].map((x) => ({ ...x, room_id: ROOM_A, author_kind: 'user', author_user_id: OTHER, body: 'late', created_at: new Date().toISOString() }));
  fake.db.nextId = 104; fake.insertMessage({ body: 'fast' }); await flush();
  fake.dropSockets(); fake.db.messages.push(...late); fake.db.nextSince = 104;
  await clock.advance(RECONNECT.maxMs);
  assert.deepEqual(ids().sort((x, y) => x - y), [100, 101, 102, 103, 104], '늦게 커밋된 102·103을 놓치지 않는다');
});

test('U6a v2:s: — setSpaces로 받은 팀 공간을 ready에서 구독해 그 토픽의 글을 받고, 뒤로 가면 닫고 앞으로 오면 다시 가입, 유휴 요청 0', async () => {
  const SP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const { m, fake, clock, ids } = setup();
  m.setSpaces([SP, SP]); // 중복은 한 번
  await m.start(); await flush();
  assert.deepEqual(fake.liveTopics(), [`v2:s:${SP}`, `v2:u:${UID}`].sort());
  const msg = { id: 300, room_id: ROOM_B, author_kind: 'user', author_user_id: OTHER, body: '큰 방', created_at: new Date().toISOString() };
  fake.db.messages.push(msg); fake.broadcast(`v2:s:${SP}`, 'msg', { message: msg }); await flush();
  assert.ok(ids().includes(300));
  fake.broadcast(`v2:s:${SP}`, 'pause', { paused: true }); await flush();
  assert.equal(m.getState(), 'ready', 's: 토픽의 중단·폐기 표지는 무시(u:만 믿는다)');
  const before = fake.log.length; await clock.advance(10 * MIN);
  assert.equal(fake.log.length, before, '유휴 10분 요청 0');
  await m.setForeground(false); assert.deepEqual(fake.liveTopics(), [], '뒤로 가면 닫힘');
  await m.setForeground(true); await flush();
  assert.deepEqual(fake.liveTopics(), [`v2:s:${SP}`, `v2:u:${UID}`].sort(), '앞으로 오면 다시 가입');
  m.setSpaces([]); assert.deepEqual(fake.liveTopics(), [`v2:u:${UID}`], '공간을 비우면 닫힘');
});

test('#1077 검수 1: v2:s:는 u:와 함께 열고, 따라잡기는 s: 가입이 끝난 뒤 1회 — 그 사이 온 큰 방 글을 놓치지 않는다', async () => {
  const SP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const fake = fakeSupabase(); fake.holdJoin.add(`v2:s:${SP}`);
  const { m, ids } = setup({ fake }); m.setSpaces([SP]);
  await m.start(); await flush();
  assert.equal(fake.count('msgr2_catch_up'), 0, 's: 가입 전에는 따라잡지 않는다');
  // 가입을 기다리는 사이 큰 방에 글이 들어간다(방송은 아직 못 받는다)
  fake.db.messages.push({ id: 400, room_id: ROOM_B, author_kind: 'user', author_user_id: OTHER, body: '사이 글', created_at: new Date().toISOString() });
  fake.release(`v2:s:${SP}`); await flush();
  assert.equal(fake.count('msgr2_catch_up'), 1, '가입이 끝나면 따라잡기 1회');
  assert.ok(ids().includes(400), '사이 글을 따라잡기가 가져온다');
  assert.equal(m.getState(), 'ready');
});

test('#1077 검수 2: 가입이 거부된 공간은 닫고 다시 붙지 않는다 — 10분 유휴 동안 재가입·요청 0, 따라잡기는 그대로', async () => {
  const SP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; const OK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const fake = fakeSupabase(); fake.denyJoin.add(`v2:s:${SP}`);
  const { m, clock } = setup({ fake }); m.setSpaces([SP, OK]);
  await m.start(); await flush();
  assert.equal(m.getState(), 'ready'); assert.equal(fake.count('msgr2_catch_up'), 1);
  assert.deepEqual(fake.liveTopics(), [`v2:s:${OK}`, `v2:u:${UID}`].sort(), '거부된 공간은 닫힘');
  assert.equal([...fake.channels].filter((c) => c.topic === `v2:s:${SP}`).length, 0, '거부된 채널은 removeChannel(재가입 타이머가 없다)');
  const joins = fake.joins.length; const reqs = fake.log.length;
  for (let i = 0; i < 6; i++) { fake.tickRejoin(); await clock.advance(10 * 1000); } // 10초마다 재가입 시도가 있었다면 늘었을 것
  await clock.advance(10 * MIN);
  assert.equal(fake.joins.length, joins, '재가입 0'); assert.equal(fake.log.length, reqs, '요청 0');
  // 다시 연결하면 한 번 더 시도한다(그때도 거부면 닫힘)
  fake.dropSockets(); await clock.advance(RECONNECT.maxMs);
  assert.equal(fake.joins.filter((t) => t === `v2:s:${SP}`).length, 2, '연결마다 한 번');
});

test('#1077 검수 3: 서버가 거부할 첨부(개수·크기·이름)는 글을 넣기 전에 멈춘다 — 요청 0', async () => {
  const { m, fake } = setup();
  await m.start(); await flush();
  const before = fake.log.length;
  const big = { name: 'a.bin', mime: 'application/octet-stream', bytes: ATTACH_LIMITS.maxBytes + 1, data: 'x' };
  const many = Array.from({ length: ATTACH_LIMITS.maxFiles + 1 }, (_, i) => ({ name: `f${i}.txt`, bytes: 1, data: 'x' }));
  for (const files of [[big], many, [{ name: '.', bytes: 1, data: 'x' }], [{ name: 'n'.repeat(ATTACH_LIMITS.maxName + 1), bytes: 1, data: 'x' }]]) {
    const r = await m.send({ roomId: ROOM_A, body: 'x', files });
    assert.equal(r.ok, false); assert.equal(r.code, 'invalid_attachment');
  }
  assert.equal(fake.log.length, before, '글·첨부·업로드 요청 0');
  assert.equal(fake.db.messages.filter((x) => x.body === 'x').length, 0, '본문만 남지 않는다');
  const ok = await m.send({ roomId: ROOM_A, body: 'ok', files: [{ name: 'n'.repeat(ATTACH_LIMITS.maxName), bytes: ATTACH_LIMITS.maxBytes, data: 'x' }] });
  assert.equal(ok.ok, true, '경계값은 보낸다');
});

test('#1077 재검수: 중단이 풀리면(방송·다시 연 직후 확인) v2:s:를 다시 열고 따라잡기 1회', async () => {
  const SP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const { m, fake } = setup(); m.setSpaces([SP]);
  await m.start(); await flush();
  assert.deepEqual(fake.liveTopics(), [`v2:s:${SP}`, `v2:u:${UID}`].sort());
  fake.broadcast(`v2:u:${UID}`, 'pause', { paused: true }); await flush();
  assert.equal(m.getState(), 'paused'); assert.deepEqual(fake.liveTopics(), [`v2:u:${UID}`], '중단 중 s: 닫힘');
  const c0 = fake.count('msgr2_catch_up');
  fake.broadcast(`v2:u:${UID}`, 'pause', { paused: false }); await flush();
  assert.equal(m.getState(), 'ready');
  assert.deepEqual(fake.liveTopics(), [`v2:s:${SP}`, `v2:u:${UID}`].sort(), '풀리면 s: 다시 열림');
  assert.equal(fake.count('msgr2_catch_up'), c0 + 1, '따라잡기 1회');
});

test('#1077 재검수: 소켓이 끊긴 사이 풀림을 놓쳐도 다시 연 직후 확인(pauseCheckLive)으로 풀리면 v2:s:도 다시 열린다', async () => {
  const SP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const { m, fake, clock } = setup(); m.setSpaces([SP]);
  await m.start(); await flush();
  fake.broadcast(`v2:u:${UID}`, 'pause', { paused: true }); fake.db.paused = true; await flush();
  fake.dropSockets(); fake.db.paused = false; await flush();
  await clock.advance(60 * MIN);
  assert.equal(m.getState(), 'ready');
  assert.deepEqual(fake.liveTopics(), [`v2:s:${SP}`, `v2:u:${UID}`].sort());
});
