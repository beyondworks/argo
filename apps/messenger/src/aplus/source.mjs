// A+ 실제 원본 — v2 서버(msgr2_*)와 연결 상태 기계(link/machine.mjs). 화면(APlusApp.jsx)은 이 모양만 안다(가짜는 fake.mjs).
// 읽기는 화면을 열 때·사건이 왔을 때만 한 번씩(주기 조회 없음 — 쉬는 동안 서버 요청 0). 보내기·실시간은 기계로만.
// 서버 모양은 #1117(P1)·약속 v1.1(#1116): 회의방 = msgr2_rooms.meeting + msgr2_meeting_create, 취소 = msgr2_work_cancel(그 회의의 일),
// 회의 글 = 에이전트별 글(meta.round 1..2), 외부 봇 = msgr2_agents.hosting 'bot'(주소·키는 서버에 없음), 상한 안내 = system 글 meta.limit.
// 그 전 서버(열·함수 없음, 42703·PGRST202)에서는 화면이 '아직 열리지 않음'을 그린다(notOpenYet).
// 무료 계정은 plan() 한 번 뒤 start()를 부르지 않는다(기계·등록·구독 0).
import { createV2Runtime, gaveUpOf } from '../v2/runtime.mjs';
import { bindLifecycle } from '../link/lifecycle.mjs';
import { loadRoom } from '../v2/data.mjs';
import { planOf } from '../pro-checkout.mjs';
import { runStateOf, effectiveState, afterCancel, errorKey } from './model.mjs';

const ok = (r) => { if (r?.error) throw Object.assign(new Error(r.error.message || 'request failed'), { code: r.error.code, status: r.status }); return r?.data ?? null; };
const notReady = () => Object.assign(new Error('aplus_not_ready'), { code: 'aplus_not_ready' });

/** raw = 원래 supabase 클라이언트, uid = 로그인 계정, appVersion = 이 앱 판. */
export function createAPlusSource({ raw, uid, appVersion = null }) {
  let rt = null;
  const listeners = new Map();
  const offs = [];
  const emit = (type, payload) => { for (const fn of listeners.get(type) ?? []) { try { fn(payload); } catch { /* 화면 쪽 오류 */ } } };
  const ready = async () => { if (!rt) throw notReady(); await rt.ready(); };
  const toMsg = (m) => ({ id: m.id, author: m.author_kind === 'user' ? (m.author_user_id === uid ? 'me' : m.author_user_id) : m.author_kind === 'system' ? 'system' : m.author_agent_id, body: m.body ?? '', at: Date.parse(m.created_at ?? '') || Date.now(), kind: m.kind, round: m.meta?.round ?? null, workId: m.work_id ?? null, meta: m.kind === 'system' ? m.meta ?? null : null });
  // 봇 일이 bot_unreachable·bot_limit 등으로 실패하면 그 방에 안내 줄 하나(글이 아니라 화면용 — 서버에 쓰지 않는다)
  const errNote = (w) => (w?.state === 'failed' && errorKey(w.error_code) ? { id: `werr-${w.id}`, author: 'system', kind: 'note', errKey: errorKey(w.error_code), at: Date.parse(w.updated_at ?? w.created_at ?? '') || Date.now() } : null);
  const meetingRooms = new Map(); // roomId → { workId, total } — 취소할 일, 사건으로 온 일의 진행
  // 진행 = 서버가 읽을 때 계산하는 상태와 같은 계산(effectiveState). until = 기한이 지나면 끝남으로 바뀌는 시각(offered만 — 리스는 본체가 늘리므로 다시 읽을 때만 본다)
  const runOf = (w, total) => ({ workId: w.id, state: runStateOf(effectiveState(w)), until: w.state === 'offered' ? Date.parse(w.expires_at ?? '') || null : null, total });
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
      offs.push(rt.machine.on('works', (e) => {
        for (const w of e.works) {
          const m = meetingRooms.get(e.roomId);
          if (m) { m.workId = w.id; emit('meeting', { roomId: e.roomId, run: runOf(w, m.total) }); }
          const note = errNote(w); if (note) emit('messages', { roomId: e.roomId, messages: [note] });
        }
      }));
      offs.push(bindLifecycle(rt.machine)); // 앱 앞·뒤·네트워크 복귀 — 뒤로 가면 소켓을 닫고(쉬는 동안 요청 0), 앞으로 오면 다시 붙는다(지금 셸과 같은 연결)
      await rt.machine.start();
    },
    /** 사람이 누른 다시 시도 — 다시 붙기를 그만둔(gave_up) 기계만 다시 붙인다. */
    retry() { if (rt && gaveUpOf(rt.machine.getSnapshot())) rt.retry(); },
    stop() { for (const off of offs.splice(0)) off(); rt?.dispose(); rt = null; },
    async agents() {
      await ready();
      return ok(await raw.from('msgr2_agents').select('id, owner_user_id, display_name, slug, role_text, status, hosting').eq('owner_user_id', uid).neq('status', 'retired')) ?? [];
    },
    /** 1:1 방은 에이전트를 고를 때 연다(msgr2_agent_dm_open — 있으면 그 방, 없으면 만든다). 목록 미리보기는 안 읽은 수(기계 배지)만 — 방마다 조회하지 않는다. */
    async dms() { return {}; },
    async openDm(agentId) { await ready(); return ok(await raw.rpc('msgr2_agent_dm_open', { p_agent: agentId }))?.room_id ?? null; },
    async messages(roomId) {
      await ready(); rt.machine.setActiveRoom?.(roomId);
      const r = await loadRoom(raw, roomId);
      const notes = r.works.map(errNote).filter(Boolean);
      return [...r.messages.filter((m) => !m.deleted_at).map(toMsg), ...notes].sort((a, b) => a.at - b.at);
    },
    async send(roomId, body) { if (!rt) return { ok: false, code: 'aplus_not_ready' }; return rt.machine.send({ roomId, body }); },
    /** 회의방 목록: 내 개인 공간의 meeting 방 + 참가 에이전트 + 방마다 마지막 일(진행 상태). 탭을 열 때 1회(요청 4). */
    async meetings() {
      await ready();
      const sp = ok(await raw.rpc('msgr2_my_personal_space'));
      const rooms = ok(await raw.from('msgr2_rooms').select('id, name, created_at, meeting').eq('space_id', sp).eq('meeting', true).is('archived_at', null)) ?? [];
      const ids = rooms.map((r) => r.id);
      const members = ids.length ? ok(await raw.from('msgr2_room_members').select('room_id, member_kind, member_id').in('room_id', ids).eq('member_kind', 'agent').is('removed_at', null)) ?? [] : [];
      const works = ids.length ? ok(await raw.from('msgr2_works').select('id, room_id, state, created_at, expires_at, lease_until, has_result').in('room_id', ids).order('created_at', { ascending: false }).limit(200)) ?? [] : [];
      return rooms.map((r) => {
        const agentIds = members.filter((m) => m.room_id === r.id).map((m) => m.member_id);
        const w = works.find((x) => x.room_id === r.id);
        meetingRooms.set(r.id, { workId: w?.id ?? null, total: agentIds.length });
        return { roomId: r.id, title: r.name, agentIds, run: w ? runOf(w, agentIds.length) : null, at: Date.parse(w?.created_at ?? r.created_at ?? '') || 0 };
      }).sort((a, b) => b.at - a.at);
    },
    async createMeeting({ title, agentIds }) { await ready(); return ok(await raw.rpc('msgr2_meeting_create', { p_name: title, p_agents: agentIds }))?.room_id ?? null; },
    /** 회의 취소 = 그 회의의 지금 일을 취소(msgr2_work_cancel). 본체가 참가자 턴을 모두 멈춘다(R10). */
    async cancelMeeting(roomId) {
      await ready();
      const m = meetingRooms.get(roomId); if (!m?.workId) return;
      emit('meeting', { roomId, run: { workId: m.workId, state: 'cancelling', total: m.total } });
      let st;
      try { st = ok(await raw.rpc('msgr2_work_cancel', { p_work: m.workId })); } catch (e) { emit('meeting', { roomId, run: { workId: m.workId, state: 'running', total: m.total } }); throw e; }
      // 이미 끝난 일(done·failed·expired)이면 서버는 쓰지 않고 그 상태만 돌려준다(방송 없음) — 돌려받은 값으로 바로 바꾼다(재검수: 'cancelling'에 갇힘)
      emit('meeting', { roomId, run: { workId: m.workId, state: afterCancel(st), total: m.total } });
    },
    /** 외부 봇: 내 에이전트 중 hosting 'bot'. 상태는 봇마다 마지막 일로(봇 상태 표는 서버에 없다). 탭을 열 때 1회(요청 2). */
    async bots() {
      await ready();
      const list = ok(await raw.from('msgr2_agents').select('id, display_name, slug, status').eq('owner_user_id', uid).eq('hosting', 'bot').neq('status', 'retired')) ?? [];
      const ids = list.map((b) => b.id);
      const works = ids.length ? ok(await raw.from('msgr2_works').select('agent_id, state, error_code, created_at').in('agent_id', ids).order('created_at', { ascending: false }).limit(100)) ?? [] : [];
      return list.map((b) => ({ id: b.id, name: b.display_name || b.slug || '?', kind: null, lastWork: works.find((w) => w.agent_id === b.id) ?? null }));
    },
  };
}
