// A+ 실제 원본 — v2 서버(msgr2_*)와 연결 상태 기계(link/machine.mjs). 화면(APlusApp.jsx)은 이 모양만 안다(가짜는 fake.mjs).
// 읽기는 화면을 열 때·사건이 왔을 때만 한 번씩(주기 조회 없음 — 쉬는 동안 서버 요청 0). 보내기·실시간은 기계로만.
// 회의방·외부 봇의 서버 RPC와 약속 v1.1은 'Argo M2 - 워커'가 정한다 — 확정 전에는 aplus_not_ready로 답해 화면이 '아직 열리지 않음'을 그린다.
// 무료 계정은 plan() 한 번 뒤 start()를 부르지 않는다(기계·등록·구독 0).
import { createV2Runtime } from '../v2/runtime.mjs';
import { loadRoom } from '../v2/data.mjs';
import { planOf } from '../pro-checkout.mjs';

const ok = (r) => { if (r?.error) throw Object.assign(new Error(r.error.message || 'request failed'), { code: r.error.code, status: r.status }); return r?.data ?? null; };
const notReady = () => Object.assign(new Error('aplus_not_ready'), { code: 'aplus_not_ready' });

/** raw = 원래 supabase 클라이언트, uid = 로그인 계정, appVersion = 이 앱 판. */
export function createAPlusSource({ raw, uid, appVersion = null }) {
  let rt = null;
  const listeners = new Map();
  const offs = [];
  const emit = (type, payload) => { for (const fn of listeners.get(type) ?? []) { try { fn(payload); } catch { /* 화면 쪽 오류 */ } } };
  const ready = async () => { if (!rt) throw notReady(); await rt.ready(); };
  const toMsg = (m) => ({ id: m.id, author: m.author_kind === 'user' ? (m.author_user_id === uid ? 'me' : m.author_user_id) : m.author_agent_id, body: m.body ?? '', at: Date.parse(m.created_at ?? '') || Date.now(), kind: m.kind });
  return {
    uid,
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type)?.delete(fn); },
    online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    machine: () => rt?.machine ?? null,
    async plan() { try { return planOf(ok(await raw.rpc('my_plan'))); } catch { return null; } },
    /** Pro일 때만 — 기기 등록·u:<나> 구독을 시작한다. */
    async start() {
      if (rt) return;
      rt = createV2Runtime({ raw, client: raw, uid, appVersion });
      offs.push(rt.machine.on('messages', (e) => emit('messages', { roomId: e.roomId, messages: e.messages.map(toMsg) })));
      offs.push(rt.machine.on('state', (s) => emit('state', s)));
      offs.push(rt.machine.on('badge', (b) => emit('badge', b)));
      await rt.machine.start();
    },
    stop() { for (const off of offs.splice(0)) off(); rt?.dispose(); rt = null; },
    async agents() {
      await ready();
      return ok(await raw.from('msgr2_agents').select('id, owner_user_id, display_name, slug, role_text, status').eq('owner_user_id', uid).neq('status', 'retired')) ?? [];
    },
    /** 1:1 방은 에이전트를 고를 때 연다(msgr2_agent_dm_open — 있으면 그 방, 없으면 만든다). 목록 미리보기는 안 읽은 수(기계 배지)만 — 방마다 조회하지 않는다. */
    async dms() { return {}; },
    async openDm(agentId) { await ready(); return ok(await raw.rpc('msgr2_agent_dm_open', { p_agent: agentId }))?.room_id ?? null; },
    async messages(roomId) { await ready(); rt.machine.setActiveRoom?.(roomId); const r = await loadRoom(raw, roomId); return r.messages.filter((m) => !m.deleted_at).map(toMsg); },
    async send(roomId, body) { if (!rt) return { ok: false, code: 'aplus_not_ready' }; return rt.machine.send({ roomId, body }); },
    async meetings() { throw notReady(); },
    async createMeeting() { throw notReady(); },
    async cancelMeeting() { throw notReady(); },
    async bots() { throw notReady(); },
    async addBot() { throw notReady(); },
  };
}
