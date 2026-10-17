// agent-link — 본체가 메신저 서버와 약속 v1(contract/v1.mjs)로 에이전트 일을 주고받는 얇은 부품(설계 2026-10-17 3절, D6).
// 이 파일은 메신저 규칙(누가 시킬 수 있나·문맥·넘김·오류 문구)을 모른다. 서버가 offer에 실어 준 것만 따른다.
// Argo 코드에 의존하지 않는다: 서버 연결(transport)과 턴 실행(host)은 밖에서 넣는다(src/agent-link-host.mjs).
//
// transport = {
//   rpc(name, args) → Promise<{ data, error }>            // supabase-js rpc 모양. error = { code?, message?, status? }
//   subscribe(topic, onEnvelope, onStatus) → { close() }   // 비공개 broadcast 채널. onStatus('connected'|'disconnected')
//   broadcast(topic, envelope) → Promise<void>             // 저장하지 않는 방송(work.progress)
//   put(url, bytes, mime) → Promise<void>                  // 서명 업로드 URL에 파일 올리기
// }
// host = {
//   canAccept(offer) → boolean                             // 이 기기에 러너가 있어 받을 수 있나(받을 수 없으면 accept하지 않는다)
//   runTurn(offer, ctx) → Promise<{ text, files?, handoffs?, usage? }>
//   onEvent?(name, detail)                                 // 로그·화면용(update_required·device_invalid·paused·lease_lost 등)
// }
// ctx(runTurn에 넘기는 것) = { signal, tier, progress(stage, note), requestApproval(req), effect(key, kind, fn), upload(name, bytes, mime) }
//
// 안전 규칙(계약 README "본체 의무"):
// - lease_gen(리스 세대)은 이 프로세스 메모리에만 둔다. 재시작한 본체는 세대가 없어 옛 일을 이어받지 못한다(자동 재실행 0, 경우 8).
// - 따라잡기(msgr2_link_pending)로 받은 봉투 가운데 이 프로세스가 시작하지 않은 일은 offer만 받는다.
// - 되돌릴 수 없는 일은 effect intent가 서버에 기록된 뒤에만 실행한다(D13). intent가 거부되면 실행하지 않는다.
import {
  LINK_V, SUPPORTED, DIRECTION, REJECT_CODES, validateEnvelope, tierAllows, unsupportedReply,
} from './contract/v1.mjs';

export const LEASE_RENEW_MS = 5 * 60 * 1000; // 리스 10분, 5분마다 연장(설계 5절)
export const PROGRESS_MIN_MS = 2000; // 진행 방송은 2초에 한 번까지(같은 단계·문구면 보내지 않음)
export const RETRY = Object.freeze({ baseMs: 1000, maxMs: 30000, attempts: 6 });

export class LinkError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** 서버 답을 { ok, code, retry, data }로 읽는다. 네트워크·5xx·429는 다시 보낼 수 있는 일시 오류로 본다. */
export function readReply({ data, error } = {}) {
  if (error) {
    const st = Number(error.status ?? 0);
    const transient = !error.code || st === 429 || st >= 500 || error.code === 'rate_limited' || error.code === 'internal';
    return { ok: false, code: error.code || (st === 429 ? 'rate_limited' : 'internal'), retry: transient, data: null };
  }
  if (data && data.ok === false) {
    const code = String(data.code || 'internal');
    return { ok: false, code, retry: REJECT_CODES[code]?.retry ?? false, data };
  }
  return { ok: true, code: null, retry: false, data: data ?? {} };
}

export function createLink({ transport, host, uid, device, agentIds = null, clock = defaultClock, uuid = () => crypto.randomUUID() }) {
  if (!transport || !host || !uid || !device) throw new Error('createLink: transport, host, uid, device required');
  const works = new Map(); // work id → { offer, seq, leaseGen, abort, approvals: Map, renewTimer, done }
  const seen = new Set(); // 받은 봉투 id(방송·따라잡기 중복 제거)
  let sub = null;
  let stopped = false;
  let paused = false;
  let syncSeq = 0;
  let lastSyncKey = null;
  const ev = (name, detail) => { try { host.onEvent?.(name, detail); } catch { /* 표시 실패는 일을 막지 않는다 */ } };

  const envelope = (w, type, data) => ({
    v: LINK_V, id: uuid(), work: w ? w.offer.work : null, seq: w ? ++w.seq : ++syncSeq, type,
    agent: w ? w.offer.agent : null, device, at: new Date(clock.now()).toISOString(), data,
  });

  // 같은 봉투(같은 id·seq)를 다시 보내는 것만 재시도한다 — 서버가 (work, 보낸 쪽, seq)로 중복을 막는다(경우 21).
  async function send(env) {
    const chk = validateEnvelope(env, { from: 'runner' });
    if (!chk.ok) throw new LinkError(chk.code, chk.errors.join('; '));
    let delay = RETRY.baseMs;
    for (let i = 1; ; i++) {
      let r;
      try { r = readReply(await transport.rpc('msgr2_link_send', { envelope: env })); }
      catch (e) { r = { ok: false, code: 'internal', retry: true, data: null, cause: e }; }
      if (r.ok) return r.data;
      if (fatal(r.code)) throw new LinkError(r.code);
      if (!r.retry || i >= RETRY.attempts || stopped) throw new LinkError(r.code);
      await clock.sleep(Math.min(delay, RETRY.maxMs));
      delay *= 2;
    }
  }

  // 기기·버전·중단 거부는 링크 전체를 멈춘다(다시 보내도 같은 답이다).
  function fatal(code) {
    if (code === 'link_version_unsupported') { ev('update_required', { code }); stop(); return true; }
    if (code === 'device_revoked' || code === 'device_expired' || code === 'device_unknown') { ev('device_invalid', { code }); stop(); return true; }
    if (code === 'service_paused') { paused = true; ev('paused', { code }); return true; }
    return false;
  }

  function onEnvelope(env, { catchUp = false } = {}) {
    if (stopped || !env || typeof env !== 'object') return;
    if (env.id && seen.has(env.id)) return;
    if (env.id) { seen.add(env.id); if (seen.size > 5000) seen.delete(seen.values().next().value); }
    const chk = validateEnvelope(env, { from: 'server' });
    if (!chk.ok) {
      if (chk.code === 'unsupported_type') return unknownType(env);
      ev('envelope_rejected', { code: chk.code, type: env.type });
      return;
    }
    if (env.device && env.device !== device) return; // 다른 기기에 간 봉투
    if (agentIds && !agentIds.has(env.agent)) return; // 이 본체에 없는 에이전트
    const w = works.get(env.work);
    if (env.type === 'work.offer') return w ? undefined : startWork(env);
    if (!w) { if (catchUp) ev('ignored_foreign', { type: env.type, work: env.work }); return; } // 재시작 전의 일·다른 프로세스의 일
    if (env.type === 'work.cancel') return cancelWork(w, env.data.reason);
    if (env.type === 'work.approval_decision') {
      const p = w.approvals.get(env.data.approval_id);
      if (p) { w.approvals.delete(env.data.approval_id); p(env.data.decision); }
    }
  }

  // 모르는 type: 이 프로세스가 진행 중인 일이면 무시한다(같은 v 안의 type 추가로 진행 중 일이 죽지 않게, C0 미룸).
  // 그 밖에는 계약대로 work.error{unsupported}로 답한다(서버는 offered에서 기록만 한다).
  function unknownType(env) {
    ev('unknown_type', { type: env.type });
    if (works.has(env.work)) return;
    // seq는 이 프로세스가 맡은 일의 번호(1부터)와 겹치지 않게 시각으로 잡는다
    const reply = unsupportedReply(env, { id: uuid(), seq: Math.floor(clock.now()), device, at: new Date(clock.now()).toISOString() });
    if (reply) send(reply).catch(() => {});
  }

  async function startWork(offer) {
    if (paused) return;
    if (Date.parse(offer.data.expires_at) <= clock.now()) return;
    let can = false;
    try { can = await host.canAccept(offer); } catch { can = false; }
    if (!can || works.has(offer.work)) return; // 받을 수 없으면 accept하지 않는다 — 다른 기기가 받을 수 있다
    const w = { offer, seq: 0, leaseGen: null, abort: new AbortController(), approvals: new Map(), renewTimer: null, done: false };
    works.set(offer.work, w);
    let acc;
    try { acc = await send(envelope(w, 'work.accept', {})); }
    catch (e) { works.delete(offer.work); ev('accept_failed', { work: offer.work, code: e.code }); return; }
    w.leaseGen = Number.isInteger(acc?.lease_gen) ? acc.lease_gen : null;
    scheduleRenew(w);
    runWork(w);
  }

  function scheduleRenew(w) {
    if (w.done || stopped) return;
    w.renewTimer = clock.setTimeout(async () => {
      if (w.done || stopped) return;
      try {
        const r = await send(envelope(w, 'work.accept', w.leaseGen != null ? { lease_gen: w.leaseGen } : {}));
        if (Number.isInteger(r?.lease_gen)) w.leaseGen = r.lease_gen;
        scheduleRenew(w);
      } catch (e) {
        // 리스를 잃었거나(lease_held·not_lease_holder) 일이 닫혔다(work_closed): 멈춘다. 결과를 다른 기기와 겹쳐 내지 않는다.
        if (['lease_held', 'not_lease_holder', 'work_closed', 'work_not_found'].includes(e.code)) {
          ev('lease_lost', { work: w.offer.work, code: e.code });
          w.abort.abort(new LinkError(e.code));
        } else scheduleRenew(w); // 일시 오류: 다음 주기에 다시(리스 10분 안에 회복하면 이어진다)
      }
    }, LEASE_RENEW_MS);
  }

  function cancelWork(w, reason) {
    ev('cancelled', { work: w.offer.work, reason });
    w.cancelled = true;
    w.abort.abort(new LinkError('cancelled'));
    for (const p of w.approvals.values()) p('reject');
    w.approvals.clear();
  }

  function finish(w) {
    w.done = true;
    if (w.renewTimer) clock.clearTimeout(w.renewTimer);
    works.delete(w.offer.work);
  }

  function makeCtx(w) {
    const tier = w.offer.data.limits.tier;
    let lastProg = { at: -Infinity, key: '' };
    return {
      signal: w.abort.signal,
      tier,
      offer: w.offer.data,
      progress(stage, note) {
        const key = `${stage}|${note ?? ''}`;
        const t = clock.now();
        if (key === lastProg.key || t - lastProg.at < PROGRESS_MIN_MS || w.done) return;
        lastProg = { at: t, key };
        const env = envelope(w, 'work.progress', note ? { stage, note: String(note).slice(0, 200) } : { stage });
        Promise.resolve(transport.broadcast(`wk:${w.offer.work}`, env)).catch(() => {});
      },
      async requestApproval({ approval_id = uuid(), action, risk, summary, effect_key = null, expires_at }) {
        if (!tierAllows(tier, 'work.approval_request')) throw new LinkError('tier_denied');
        const decided = new Promise((resolve) => w.approvals.set(approval_id, resolve));
        await send(envelope(w, 'work.approval_request', { approval_id, action, risk, summary, effect_key, expires_at }));
        return decided;
      },
      // 되돌릴 수 없는 일: intent가 서버에 기록돼야 fn을 실행한다. 결과(done·failed)는 실패해도 다시 실행하지 않는다.
      async effect(effect_key, kind, fn) {
        if (!tierAllows(tier, 'work.effect')) throw new LinkError('tier_denied');
        if (w.abort.signal.aborted) throw new LinkError('cancelled');
        await send(envelope(w, 'work.effect', { effect_key, state: 'intent', ...(kind ? { kind } : {}) }));
        let out, ok = false;
        try { out = await fn(); ok = true; return out; }
        finally {
          await send(envelope(w, 'work.effect', { effect_key, state: ok ? 'done' : 'failed', ...(kind ? { kind } : {}) }))
            .catch((e) => ev('effect_report_failed', { work: w.offer.work, effect_key, code: e.code }));
        }
      },
      async upload(name, bytes, mime = 'application/octet-stream') {
        if (!tierAllows(tier, 'work.result', { files: ['x'] })) throw new LinkError('tier_denied');
        const r = readReply(await transport.rpc('msgr2_link_upload_slot', { work: w.offer.work, name, bytes: bytes.byteLength ?? bytes.length }));
        if (!r.ok) throw new LinkError(r.code);
        await transport.put(r.data.url, bytes, mime);
        return r.data.slot_id;
      },
    };
  }

  async function runWork(w) {
    let out, err;
    try { out = await host.runTurn(w.offer, makeCtx(w)); }
    catch (e) { err = e; }
    try {
      // 취소·리스 잃음·링크 멈춤: 아무것도 내지 않는다(다른 기기와 겹쳐 내지 않고, 취소된 일에 결과를 붙이지 않는다)
      if (w.cancelled || w.abort.signal.aborted || stopped) return;
      if (err || !out) {
        const code = err?.code && typeof err.code === 'string' && /^[a-z][a-z0-9_]*$/.test(err.code) ? err.code : 'internal';
        await send(envelope(w, 'work.error', { code, runner: err?.runner ?? null, ...(err?.retry_at ? { retry_at: err.retry_at } : {}) }));
        return;
      }
      const data = {
        text: String(out.text ?? '').slice(0, 20000),
        files: Array.isArray(out.files) ? out.files.slice(0, 20) : [],
        handoffs: Array.isArray(out.handoffs) ? out.handoffs.slice(0, 8) : [],
        ...(out.usage ? { usage: out.usage } : {}),
      };
      if (data.files.length && !tierAllows(w.offer.data.limits.tier, 'work.result', data)) data.files = [];
      await send(envelope(w, 'work.result', data));
    } catch (e) {
      ev('report_failed', { work: w.offer.work, code: e.code });
    } finally {
      finish(w);
    }
  }

  async function catchUp() {
    let r;
    try { r = readReply(await transport.rpc('msgr2_link_pending', {})); }
    catch { return; }
    if (!r.ok) { fatal(r.code); return; }
    const list = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.envelopes) ? r.data.envelopes : [];
    for (const env of list) onEnvelope(env, { catchUp: true });
  }

  function start() {
    stopped = false;
    sub = transport.subscribe(`w:${uid}`, (env) => onEnvelope(env), (status) => {
      if (status === 'connected') catchUp(); // (재)접속마다 한 번 따라잡는다 — 예비 조회·폴링은 없다(D7)
    });
    return api;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    try { sub?.close(); } catch { /* 닫기 실패 무시 */ }
    for (const w of works.values()) { w.abort.abort(new LinkError('stopped')); if (w.renewTimer) clock.clearTimeout(w.renewTimer); }
  }

  /** agent.sync: 목록이 바뀌었을 때만 보낸다(같은 목록이면 요청 0). */
  async function syncAgents(agents) {
    const key = JSON.stringify(agents);
    if (key === lastSyncKey) return { sent: false };
    const env = { ...envelope(null, 'agent.sync', { agents }), agent: null };
    const data = await send(env);
    lastSyncKey = key;
    return { sent: true, data }; // data.agents = [{ id, ws, slug }] — 서버 id ↔ 로컬 에이전트(U2가 답에 싣는다)
  }

  const api = {
    start, stop, syncAgents, catchUp,
    // 시험·화면용
    get active() { return [...works.keys()]; },
    get paused() { return paused; },
    get stopped() { return stopped; },
    supported: SUPPORTED,
    _onEnvelope: onEnvelope,
  };
  return api;
}

export { DIRECTION };
