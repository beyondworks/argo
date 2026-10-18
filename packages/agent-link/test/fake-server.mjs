// 약속 v1을 따르는 가짜 메신저 서버(U2가 아직 없어 부품 시험용). 상태 전이·리스 CAS·세대·중복·효과 키는 계약(contract/v1.mjs) 그대로 판정한다.
// 실제 서버(msgr2_link_send)와 같은 답 모양을 낸다: { ok:true, duplicate?, lease_gen?, lease_until? } | { ok:false, code }.
import { topicWork } from '../link.mjs';
import {
  validateEnvelope, nextState, effectiveState, tierAllows, LINK_V,
} from '../contract/v1.mjs';

const LEASE_MS = 10 * 60 * 1000;

export function createFakeServer({ now = () => Date.now(), uid = 'u' } = {}) {
  const works = new Map(); // id → { state, offer, lease: { device, gen, until }, has_result, tier }
  const sent = []; // 본체가 보낸 봉투(받아들인 것만)
  const log = []; // 모든 rpc 호출 { name, args, reply }
  const effects = new Map(); // effect_key → state
  const seqs = new Map(); // `${work}|${device}|${seq}` → envelope id
  const subs = new Map(); // topic → Set<{ onEnvelope, onStatus }>
  const broadcasts = []; // { topic, env }
  const pending = []; // 따라잡기로 돌려줄 서버→본체 봉투
  const slots = new Map();
  const agentIds = new Map();
  const files = new Map(); // `${bucket}/${path}` → 바이트(Storage 흉내)
  const downloads = []; // `${ws}/${slug}` → 서버 에이전트 id
  let gen = 0;
  let failNext = []; // 다음 rpc 호출에 넣을 일시 오류
  const opts = { paused: false, revoked: false, maxV: 1 };
  const uuid = () => crypto.randomUUID();

  function reply(name, args, r) { log.push({ name, args, reply: r }); return r; }

  function linkSend(env) {
    if (opts.revoked) return { data: { ok: false, code: 'device_revoked' } };
    if (opts.paused) return { data: { ok: false, code: 'service_paused' } };
    const chk = validateEnvelope(env, { from: 'runner', supported: { min: 1, max: opts.maxV } });
    if (!chk.ok) return { data: { ok: false, code: chk.code } };
    const key = `${env.work}|${env.device}|${env.seq}`;
    if (env.work && seqs.has(key)) {
      return seqs.get(key) === env.id ? { data: { ok: true, duplicate: true } } : { data: { ok: false, code: 'seq_conflict' } };
    }
    if (env.type === 'agent.sync') {
      seqs.set(`sync|${env.id}`, env.id); sent.push(env);
      // 서버 id ↔ 로컬 에이전트 대응표(1-3절 upsert 결과). 같은 (ws, slug)는 같은 id
      const agents = env.data.agents.map((a) => {
        const k = `${a.ws}/${a.slug}`;
        if (!agentIds.has(k)) agentIds.set(k, uuid());
        return { id: agentIds.get(k), ws: a.ws, slug: a.slug };
      });
      return { data: { ok: true, agents } };
    }
    const w = works.get(env.work);
    if (!w) return { data: { ok: false, code: 'work_not_found' } };
    const state = effectiveState({ state: w.state, expires_at: w.offer.data.expires_at, lease_until: w.lease ? new Date(w.lease.until).toISOString() : null, has_result: w.has_result }, now());
    const holder = w.lease && w.lease.device === env.device;
    if (!tierAllows(w.tier, env.type, env.data)) return { data: { ok: false, code: 'tier_denied' } };
    // 리스 주인이 아닌 기기의 봉투는 accept 외 전부 거부(설계 5절). stalled는 nextState가 같은 기기만 받는다.
    if (['accepted', 'running', 'awaiting_approval'].includes(state) && env.type !== 'work.accept' && !holder) {
      return { data: { ok: false, code: 'not_lease_holder' } };
    }
    if (env.type === 'work.effect') {
      if (env.data.state === 'intent' && effects.has(env.data.effect_key)) return { data: { ok: false, code: 'effect_exists' } };
      if (env.data.state !== 'intent' && !effects.has(env.data.effect_key)) return { data: { ok: false, code: 'effect_unknown' } };
    }
    const r = nextState(state, env.type, env.data, { sameDevice: !!holder, leaseGen: w.lease?.gen ?? null });
    if (!r.ok) return { data: { ok: false, code: r.code } };
    // 리스 CAS: 처음 accept는 리스가 없거나 끝났을 때만, 연장은 nextState가 세대를 확인했다
    const out = { ok: true };
    if (env.type === 'work.accept') {
      if (state === 'offered') {
        if (w.lease && w.lease.until > now()) return { data: { ok: false, code: 'lease_held' } };
        w.lease = { device: env.device, gen: ++gen, until: now() + LEASE_MS };
      } else w.lease.until = now() + LEASE_MS;
      out.lease_gen = w.lease.gen;
      out.attachments = w.attachments ?? w.offer.data.attachments; // 원글의 지금 첨부(#1076)
      out.lease_until = new Date(w.lease.until).toISOString();
    }
    if (env.type === 'work.effect') effects.set(env.data.effect_key, env.data.state);
    if (env.type === 'work.result') w.has_result = true;
    if (r.mark) w.mark = r.mark;
    w.state = r.to;
    seqs.set(key, env.id);
    sent.push(env);
    return { data: out };
  }

  const transport = {
    async rpc(name, args) {
      if (failNext.length) { const e = failNext.shift(); return reply(name, args, { data: null, error: e }); }
      if (name === 'msgr2_link_send') return reply(name, args, args.p_env ? linkSend(args.p_env) : { data: null, error: { code: 'PGRST202', message: 'no function with these argument names', status: 404 } }); // 실제 PostgREST처럼 이름이 다르면 함수가 없다
      if (name === 'msgr2_link_pending') return reply(name, args, { data: opts.revoked ? { ok: false, code: 'device_revoked' } : opts.paused ? { ok: false, code: 'service_paused' } : [...pending] });
      if (name === 'msgr2_link_upload_slot') {
        if (!args.p_work) return reply(name, args, { data: null, error: { code: 'PGRST202', status: 404 } });
        const w = works.get(args.p_work);
        if (!w || !tierAllows(w.tier, 'work.result', { files: ['x'] })) return reply(name, args, { data: { ok: false, code: 'tier_denied' } });
        const slot = uuid(); slots.set(slot, { ...args, put: false });
        return reply(name, args, { data: { ok: true, slot, bucket: 'msgr', path: `s/${args.p_work}/${slot}/${args.p_name}` } }); // 서버 모양(msgr2_link_upload_slot)
      }
      return reply(name, args, { data: null, error: { code: 'PGRST202', message: 'unknown rpc', status: 404 } });
    },
    subscribe(topic, onEnvelope, onStatus) {
      const s = { onEnvelope, onStatus };
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic).add(s);
      queueMicrotask(() => onStatus?.('connected'));
      return { close: () => subs.get(topic)?.delete(s) };
    },
    async broadcast(topic, env) { broadcasts.push({ topic, env }); },
    async download(bucket, path) {
      downloads.push(`${bucket}/${path}`);
      const f = files.get(`${bucket}/${path}`);
      if (!f) throw Object.assign(new Error('not found'), { code: 'download_failed' });
      return f;
    },
    async upload(bucket, path) { const id = path.split('/')[2]; if (slots.has(id)) slots.get(id).put = true; },
  };

  function push(env, { store = true } = {}) {
    if (store) pending.push(env);
    for (const s of subs.get(topicWork(uid)) || []) s.onEnvelope(env);
  }

  function offer({ agent, device = null, tier = 'owner', text = '보고서 써 줘', expiresIn = 30 * 60 * 1000, memory = true } = {}) {
    const work = uuid();
    const env = {
      v: LINK_V, id: uuid(), work, seq: 1, type: 'work.offer', agent, device, at: new Date(now()).toISOString(),
      data: {
        room: uuid(), topic: uuid(), from: { kind: 'user', id: uuid(), name: '유건' }, text, context: [], attachments: [], memory,
        limits: { tier, max_turn_s: 900, budget: null }, expires_at: new Date(now() + expiresIn).toISOString(),
      },
    };
    works.set(work, { state: 'offered', offer: env, lease: null, has_result: false, tier, serverSeq: 1 });
    return env;
  }

  function serverEnvelope(work, type, data) {
    const w = works.get(work);
    w.serverSeq += 1;
    return { v: LINK_V, id: uuid(), work, seq: w.serverSeq, type, agent: w.offer.agent, device: w.lease?.device ?? null, at: new Date(now()).toISOString(), data };
  }

  function cancel(work, by = { kind: 'user', id: uuid() }) {
    const w = works.get(work);
    const r = nextState(w.state, 'work.cancel');
    w.state = r.to;
    push(serverEnvelope(work, 'work.cancel', { by, reason: 'user' }));
  }

  function decide(work, approval_id, decision) {
    const w = works.get(work);
    const r = nextState(w.state, 'work.approval_decision', { decision });
    if (r.ok) w.state = r.to;
    push(serverEnvelope(work, 'work.approval_decision', { approval_id, decision, by: { kind: 'user', id: uuid() } }));
  }

  function reconnect() { for (const set of subs.values()) for (const s of set) s.onStatus?.('connected'); }

  return {
    transport, works, sent, log, agentIds, files, downloads, subs, effects, broadcasts, pending, slots, opts,
    offer, push, cancel, decide, reconnect, serverEnvelope,
    failNext: (...errs) => { failNext.push(...errs); },
    sentOf: (type, work) => sent.filter((e) => e.type === type && (!work || e.work === work)),
    rpcCount: (name) => log.filter((x) => x.name === name).length,
  };
}
