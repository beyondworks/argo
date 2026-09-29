// 크루 계약 1-a(2026-09-29) — OpenClaw 예약 작업 ↔ 메신저 "업무 > 자동화", 위험 작업 승인 ↔ 메신저 결재 카드.
// Hermes 어댑터(integrations/hermes-argo-msgr/adapter.py "크루 계약 1-a")와 같은 계약이다. 순수 JS — 플러그인과 node 단위 테스트가 같이 쓴다.
// OpenClaw 쪽 접근은 호출자가 넘긴다: 예약 작업은 게이트웨이 서비스의 ctx.getCron()(list/update/remove — OpenClaw가 플러그인에 주는
// 공식 스케줄러 핸들, 저장소 파일을 직접 고치지 않는다), 승인 결정은 resolveApprovalOverGateway.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const CHANNEL = 'argo-msgr';
export const ROUTINES_EVERY_MS = 60_000;      // 예약 작업 읽기 주기. 네트워크는 스냅샷이 바뀌었을 때만(+1시간마다 한 번 재확인)
export const ROUTINES_RESEND_MS = 3_600_000;
export const STATUS_MIN_MS = 600_000;         // last_run_at·last_status는 10분에 한 번만(자주 도는 작업이 DB 쓰기를 만들지 않게)
export const SCRIPT_PROMPT = '(스크립트 작업 / script job)';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pad = (n) => String(n).padStart(2, '0');

export function hostTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

// 키 순서와 무관한 JSON(지문·해시용)
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** 결과를 이 봇 계정의 메신저로 보내는 작업이면 그 채널 id(없으면 ''), 아니면 null. 설계 D2 — 메신저 전달 작업만 기본으로 보이고 고칠 수 있다.
 *  delivery.accountId가 있으면 이 계정과 같아야 하고, 없으면 ownsUnscoped(이 계정이 유일하거나 기본 계정)일 때만 이 계정 것으로 본다. */
export function jobMsgrChannel(job, { accountId, ownsUnscoped = true } = {}) {
  const d = job?.delivery;
  if (!d || typeof d !== 'object' || d.mode === 'none' || d.mode === 'webhook') return null;
  const rawTo = String(d.to ?? '').trim();
  const ours = d.channel === CHANNEL || ((d.channel == null || d.channel === 'last') && rawTo.toLowerCase().startsWith(`${CHANNEL}:`));
  if (!ours) return null;
  const acct = typeof d.accountId === 'string' && d.accountId.trim() ? d.accountId.trim() : null;
  if (acct ? acct !== accountId : !ownsUnscoped) return null;
  const to = rawTo.replace(new RegExp(`^${CHANNEL}:`, 'i'), '').replace(/^(channel|chat):/i, '');
  return UUID_RE.test(to) ? to : '';
}

function cronField(v, lo, hi) { // 숫자 하나 또는 쉼표 목록만(범위·간격은 raw로)
  const out = [];
  for (const part of String(v).split(',')) {
    if (!/^\d+$/.test(part) || Number(part) < lo || Number(part) > hi) return null;
    out.push(Number(part));
  }
  return out;
}
function zoned(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** OpenClaw schedule {kind: cron|every|at|on-exit|stream} → 메신저 일정. 표현 못 하는 식은 raw(화면에서 일정은 읽기 전용).
 *  tz는 시간대가 없는 cron과 at 표시에 쓰는 게이트웨이 호스트 시간대(OpenClaw 문서: tz 없는 cron은 호스트 시간대로 돈다). */
export function scheduleToMsgr(schedule, tz = null) {
  const s = schedule && typeof schedule === 'object' ? schedule : {};
  const zone = s.tz || tz || null;
  const withTz = (d) => (zone ? { ...d, tz: zone } : d);
  const everyMs = Number(s.everyMs);
  if (s.kind === 'every' && everyMs > 0 && everyMs % 60_000 === 0) return { type: 'interval', everyMinutes: everyMs / 60_000 };
  if (s.kind === 'at' && s.at) {
    const ms = Date.parse(String(s.at));
    if (Number.isFinite(ms)) {
      try { return { type: 'once', ...zoned(ms, tz || 'UTC'), tz: tz || 'UTC' }; } catch { /* 모르는 시간대 → raw */ }
    }
  }
  const expr = String(s.expr ?? '').trim();
  const parts = expr.split(/\s+/);
  if (s.kind === 'cron' && parts.length === 5 && parts[2] === '*' && parts[3] === '*') {
    const mins = cronField(parts[0], 0, 59), hours = cronField(parts[1], 0, 23);
    if (mins && hours && mins.length === 1) {
      const times = [...new Set(hours)].sort((a, b) => a - b).map((h) => `${pad(h)}:${pad(mins[0])}`);
      if (parts[4] === '*') return withTz({ type: 'daily', time: times[0], times });
      const dows = cronField(parts[4], 0, 7);
      if (dows) {
        const d = [...new Set(dows.map((x) => x % 7))].sort((a, b) => a - b); // cron 7 = 일요일 = 0
        return withTz({ type: 'weekly', time: times[0], times, dows: d, dow: d[0] });
      }
    }
  }
  const raw = s.kind === 'cron' ? expr
    : s.kind === 'every' && everyMs > 0 ? `every ${everyMs}ms`
    : s.kind === 'on-exit' ? `on-exit ${String(s.command ?? '')}`.trim()
    : s.kind === 'at' ? `at ${String(s.at ?? '')}`.trim()
    : String(s.kind ?? '');
  return { type: 'raw', expr: raw, display: s.kind === 'cron' && s.tz ? `${raw} (${s.tz})` : raw };
}

/** 메신저 일정 → OpenClaw schedule(편집 반영용). 여러 시각은 분이 같을 때만(cron 한 줄로 표현), once는 지원하지 않는다(Hermes와 같다). */
export function msgrToOpenclawSchedule(s, fallbackTz = null) {
  const t = s?.type;
  const every = Number(s?.everyMinutes);
  if (t === 'interval' && Number.isInteger(every) && every > 0) return { kind: 'every', everyMs: every * 60_000 };
  if (t !== 'daily' && t !== 'weekly') return null;
  const list = Array.isArray(s.times) && s.times.length ? s.times : [s.time];
  const hm = list.map((x) => /^(\d{1,2}):(\d{2})$/.exec(String(x ?? ''))).map((m) => (m ? [Number(m[1]), Number(m[2])] : null));
  if (!hm.length || hm.some((x) => !x || x[0] > 23 || x[1] > 59) || new Set(hm.map((x) => x[1])).size !== 1) return null;
  const hours = [...new Set(hm.map((x) => x[0]))].sort((a, b) => a - b).join(',');
  const tz = s.tz || fallbackTz || null;
  const withTz = (d) => (tz ? { ...d, tz } : d);
  if (t === 'daily') return withTz({ kind: 'cron', expr: `${hm[0][1]} ${hours} * * *` });
  const dows = Array.isArray(s.dows) && s.dows.length ? s.dows : s.dow != null ? [s.dow] : [];
  if (!dows.length || !dows.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  return withTz({ kind: 'cron', expr: `${hm[0][1]} ${hours} * * ${[...new Set(dows)].sort((a, b) => a - b).join(',')}` });
}

const HUMAN_KEYS = ['name', 'description', 'enabled', 'schedule', 'payload', 'delivery'];
/** 사람이 바꾸는 필드만 — 실행 필드(state·nextRunAtMs·status·updatedAtMs)는 넣지 않는다(실행마다 '수정'으로 보이지 않게). */
export function jobFingerprint(job) {
  return sha256(stableStringify(Object.fromEntries(HUMAN_KEYS.map((k) => [k, job?.[k] ?? null]))));
}

/** Argo decideRoutineEdit와 같은 판정: 작업이 없으면 failed, 편집보다 나중에 사람이 고쳤으면 superseded, 아니면 apply. */
export function decideRoutineEdit(job, state, createdAt) {
  if (!job) return 'failed';
  const changed = Date.parse(state?.changed_at ?? '');
  const created = Date.parse(String(createdAt ?? ''));
  if (Number.isFinite(changed) && Number.isFinite(created) && changed > created) return 'superseded';
  return 'apply';
}

function jobPrompt(job) {
  const p = job?.payload ?? {};
  return String((p.kind === 'systemEvent' ? p.text : p.message ?? p.text) ?? '').trim();
}

/** OpenClaw 작업 → setRoutines 행. 메신저 전달 작업이 아니면(channel === null) 기본은 null — mirrorAll이면 보이되 고칠 수 없다. */
export function jobToRow(job, { channel, tz = null, state = {}, mirrorAll = false, now = Date.now() } = {}) {
  if (channel === null && !mirrorAll) return null;
  const prompt = jobPrompt(job) || SCRIPT_PROMPT;
  const title = String(job?.name ?? '').trim() || prompt.slice(0, 40);
  const st = job?.state ?? {};
  const row = {
    ext_id: String(job.id), title: title.slice(0, 200), prompt: prompt.slice(0, 20000), schedule: scheduleToMsgr(job.schedule, tz),
    enabled: job.enabled !== false, editable: channel !== null, channel_id: channel || null, updated_at: state?.changed_at ?? null,
  };
  const status = { last_run_at: Number.isFinite(st.lastRunAtMs) ? new Date(st.lastRunAtMs).toISOString() : null, last_status: st.lastRunStatus ?? null };
  const prev = state?.status_sent;
  // 처음 생긴 실행 기록은 바로, 그다음부터는 10분에 한 번(자주 도는 작업이 실행마다 쓰기를 만들지 않게)
  const prevAt = Date.parse(prev?.at ?? '');
  const fresh = !prev || !prev.value?.last_run_at || !Number.isFinite(prevAt) || now - prevAt >= STATUS_MIN_MS;
  row.status = fresh ? status : prev.value;
  return row;
}

/** 메신저 편집 patch → OpenClaw cron.update patch. 표현 못 하면 예외(→ routineEditDone failed). */
export function buildEditPatch(job, patch = {}, tz = null) {
  const out = {};
  if (typeof patch.title === 'string') out.name = patch.title;
  if (typeof patch.prompt === 'string') {
    const kind = job?.payload?.kind;
    if (kind === 'agentTurn') out.payload = { kind, message: patch.prompt };
    else if (kind === 'systemEvent') out.payload = { kind, text: patch.prompt };
    else throw new Error(`prompt is not editable for ${kind || 'this'} job`);
  }
  if (patch.schedule && typeof patch.schedule === 'object') {
    const sch = msgrToOpenclawSchedule(patch.schedule, job?.schedule?.tz ?? tz);
    if (!sch) throw new Error('schedule not representable in OpenClaw cron');
    out.schedule = sch;
  }
  if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
  return out;
}

const redact = (s) => String(s).replace(/bot[^/\s]+\//g, 'bot***/').replace(/argo_bot_[A-Za-z0-9]+/g, 'argo_bot_***');

/** 예약 작업 미러 + 편집 반영(계정 하나). cronAccess() → {state:'ready', cron} | {state:'pending'} | {state:'unsupported', reason}. */
export class RoutineMirror {
  /** @param {any} opts */
  constructor({ api, cronAccess, accountId, ownsUnscoped = () => true, stateFile, tz = hostTimeZone, mirrorAll = () => String(process.env.ARGO_MSGR_MIRROR_ALL ?? '').trim() === '1', now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { api, cronAccess, accountId, ownsUnscoped, stateFile, tz, mirrorAll, now, log });
    this.state = null; this.sentDigest = null; this.sentAt = 0; this.unsupportedSent = null;
  }
  channelOf(job) { return jobMsgrChannel(job, { accountId: this.accountId, ownsUnscoped: this.ownsUnscoped() }); }
  async load() {
    if (this.state) return;
    try { this.state = JSON.parse(await readFile(this.stateFile, 'utf8')) ?? {}; } catch { this.state = {}; }
  }
  async save() { // 작업별 지문·사람이 고친 시각(재시작 뒤에도 판정 유지). 토큰은 넣지 않는다.
    await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' });
    await rename(tmp, this.stateFile);
  }
  async sync(force = false) {
    await this.load();
    const access = await this.cronAccess();
    if (access.state === 'unsupported') { // 조용히 빠지지 않는다(설계 L7) — 사유가 바뀔 때만 한 번 보고, 행은 건드리지 않는다
      if (this.unsupportedSent !== access.reason) {
        await this.api.setRoutines({ unsupported: access.reason });
        this.unsupportedSent = access.reason;
      }
      return 'unsupported';
    }
    if (access.state !== 'ready') return 'pending';
    const jobs = await access.cron.list({ includeDisabled: true }); // 읽기 실패는 예외 → 빈 스냅샷을 보내지 않는다(L6)
    if (!Array.isArray(jobs)) throw new Error('OpenClaw cron list did not return an array');
    const now = this.now(), iso = new Date(now).toISOString(), tz = this.tz(), mirrorAll = this.mirrorAll();
    const rows = [], seen = new Set();
    for (const job of jobs) {
      const id = String(job?.id ?? '');
      if (!id) continue;
      seen.add(id);
      const st = (this.state[id] ??= {});
      const fp = jobFingerprint(job);
      if (st.fp && st.fp !== fp) st.changed_at = iso; // 사람이 고친 시각(메신저 편집 반영 포함 — Argo editedAt과 같은 뜻)
      st.fp = fp;
      const row = jobToRow(job, { channel: this.channelOf(job), tz, state: st, mirrorAll, now });
      if (!row) continue;
      if (stableStringify(row.status) !== stableStringify(st.status_sent?.value)) st.status_sent = { value: row.status, at: iso };
      rows.push(row);
    }
    for (const gone of Object.keys(this.state)) if (!seen.has(gone)) delete this.state[gone];
    await this.save();
    const digest = sha256(stableStringify(rows));
    if (!force && digest === this.sentDigest && now - this.sentAt < ROUTINES_RESEND_MS) return 'unchanged'; // 바뀐 게 없으면 네트워크 호출도 없다
    const res = (await this.api.setRoutines({ rows })) ?? {};
    this.unsupportedSent = null;
    // 서버 행 수가 다르면(재활성·서버에서 지워짐 등) 다음 주기에 다시 보낸다(M1)
    this.sentDigest = Number(res.total ?? rows.length) === rows.length ? digest : null;
    this.sentAt = now;
    return 'sent';
  }
  async applyEdit(ev) {
    await this.load();
    let status = 'failed', error = null;
    try {
      const access = await this.cronAccess();
      if (access.state !== 'ready') throw new Error('OpenClaw cron API unavailable');
      const id = String(ev?.ext_id ?? '');
      const job = ((await access.cron.list({ includeDisabled: true })) ?? []).find((j) => String(j?.id) === id) ?? null;
      const verdict = decideRoutineEdit(job, this.state[id], ev?.created_at);
      if (verdict === 'failed') error = 'routine_not_found';
      else if (this.channelOf(job) === null) error = 'not_editable'; // 서버도 막지만 어댑터가 한 번 더(메신저 전달 작업만 고친다)
      else if (verdict === 'superseded') status = 'superseded';
      else {
        if (ev.op === 'delete') await access.cron.remove(id);
        else {
          const patch = buildEditPatch(job, ev.patch ?? {}, this.tz());
          if (Object.keys(patch).length) await access.cron.update(id, patch);
        }
        status = 'applied';
      }
    } catch (e) {
      error = redact(e?.message ?? e).slice(0, 300);
    }
    await this.api.routineEditDone({ edit_id: ev?.edit_id, status, error });
    await this.sync(true); // 반영 결과를 바로 미러
    return status;
  }
}

/** 위험 작업 승인 ↔ 메신저 결재 카드(계정 하나). resolve({externalId, kind, decision})가 OpenClaw에 결정을 돌려준다. */
export class ApprovalBridge {
  /** @param {any} opts */
  constructor({ api, resolve, log = () => {} }) {
    Object.assign(this, { api, resolve, log });
    this.sources = new Map();   // message_id → 실행 중인 원문(execution_attempt 포함)
    this.approvals = new Map(); // 메신저 approval_id → {approvalId, externalId, kind, card}
    this.byExternal = new Map(); // OpenClaw 승인 요청 id → 메신저 approval_id
  }
  static approvalIdFor(externalId) { return `oc-${createHash('sha256').update(String(externalId)).digest('hex').slice(0, 24)}`; } // 같은 요청을 다시 올려도 같은 카드(서버 멱등)
  track(m) { if (m?.execution_attempt && m.message_id != null) this.sources.set(Number(m.message_id), m); }
  done(m) { this.sources.delete(Number(m?.message_id)); }
  /** 승인 대기는 에이전트 실행 안에서 오므로 원문을 직접 모른다 — 그 채팅에서 아직 답하지 않은 실행 중 가장 최근 것(Hermes와 같다). */
  sourceForChat(chatId) {
    let best = null;
    for (const m of this.sources.values()) if (String(m?.chat?.id) === String(chatId) && (!best || Number(m.message_id) > Number(best.message_id))) best = m;
    return best;
  }
  async request({ externalId, kind, chatId, command, reason }) {
    const m = this.sourceForChat(chatId);
    if (!m) return null; // 실행 중인 원문이 없으면 카드를 만들지 않는다(OpenClaw 기존 경로로 둔다)
    const approvalId = ApprovalBridge.approvalIdFor(externalId);
    const res = (await this.api.requestApproval({ execution_attempt: m.execution_attempt, approval_id: approvalId, command, reason: reason ?? null })) ?? {};
    const entry = { approvalId, externalId: String(externalId), kind, card: res.message_id != null ? String(res.message_id) : '' };
    this.approvals.set(approvalId, entry);
    this.byExternal.set(entry.externalId, approvalId);
    return entry;
  }
  forget(approvalId) {
    const e = this.approvals.get(approvalId);
    this.approvals.delete(approvalId);
    if (e) this.byExternal.delete(e.externalId);
  }
  has(externalId) { return this.byExternal.has(String(externalId)); }
  /** approval_decided: 먼저 선점 ack — claimed일 때만 OpenClaw에 결정을 돌려준다(최대 한 번 재개, H3). 승인+resume일 때만 허용. */
  async onDecided(ev) {
    const aid = String(ev?.approval_id ?? '');
    const ack = (await this.api.ackApproval(aid)) ?? {};
    const entry = this.approvals.get(aid);
    if (!ack.claimed || !entry) { this.forget(aid); return 'skipped'; } // 다른 어댑터·재시도가 선점했거나 재시작 뒤라 대기 중인 요청도 없다
    const decision = ev.status === 'approved' && ev.resume === true ? 'allow-once' : 'deny';
    this.forget(aid); // 먼저 잊는다 — 결정 뒤 코어가 부르는 updateEntry가 이미 결정된 카드를 만료로 닫으려 하지 않게
    await this.resolve({ externalId: entry.externalId, kind: entry.kind, decision });
    return decision;
  }
  /** OpenClaw 쪽 대기가 끝났는데(시간 초과·다른 곳에서 결정) 카드가 열려 있으면 expireApproval로 닫는다. */
  async expire(externalId) {
    const aid = this.byExternal.get(String(externalId));
    if (!aid) return false;
    try { await this.api.expireApproval(aid); } catch (e) { this.log(`argo-msgr: expireApproval ${aid} failed — ${redact(e?.message ?? e)}`); } finally { this.forget(aid); }
    return true;
  }
}
