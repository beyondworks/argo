// 크루 계약 1-a·1-b(2026-09-29) — OpenClaw 예약 작업 ↔ 메신저 "업무 > 자동화", 위험 작업 승인 ↔ 메신저 결재 카드,
// 1-b: 버전·승인 모드 보고, "모든 예약 작업 보기"(서버 설정), 전달 상태·방 지정, 에이전트가 올리는 결재 + 결정 뒤 재개·후속 보고.
// Hermes 어댑터(integrations/hermes-argo-msgr/adapter.py "크루 계약 1-a/1-b")와 같은 계약이다. 순수 JS — 플러그인과 node 단위 테스트가 같이 쓴다.
// OpenClaw 쪽 접근은 호출자가 넘긴다: 예약 작업은 게이트웨이 서비스의 ctx.getCron()(list/update/remove — OpenClaw가 플러그인에 주는
// 공식 스케줄러 핸들, 저장소 파일을 직접 고치지 않는다), 승인 결정은 resolveApprovalOverGateway.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseMessengerDisposition } from './api.js';

export const CHANNEL = 'argo-msgr';
export const ROUTINES_EVERY_MS = 60_000;      // 예약 작업 읽기 주기. 네트워크는 스냅샷이 바뀌었을 때만(+1시간마다 한 번 재확인)
export const ROUTINES_RESEND_MS = 3_600_000;
export const STATUS_MIN_MS = 600_000;         // last_run_at·last_status는 10분에 한 번만(자주 도는 작업이 DB 쓰기를 만들지 않게)
export const SCRIPT_PROMPT = '(스크립트 작업 / script job)';
export const AGENT_APPROVAL_KEEP_MS = 30 * 24 * 3_600_000; // 결정이 안 온 에이전트 결재 재개 정보는 30일 뒤 지운다(늦게 오면 "다시 말해 달라" 후속 보고로 끝난다)
// 후속 보고 문구 — Hermes 어댑터와 같다(한국어\n/ 영어)
export const FOLLOWUP_LATE = '결정이 늦게 도착해 명령은 실행되지 않았습니다(에이전트의 승인 대기 시간이 지났습니다). 필요하면 다시 요청해 주세요.\n'
  + '/ The decision arrived after the agent stopped waiting, so the command was not run. Ask again if it is still needed.';
export const FOLLOWUP_LOST_APPROVED = '결재가 승인됐습니다. 이어서 진행하려면 이 대화에서 다시 말씀해 주세요.\n/ Approved — ask again here to continue.';
export const FOLLOWUP_LOST_REJECTED = '결재가 반려되어 진행하지 않습니다.\n/ Rejected — not proceeding.';
/** 후속 보고 본문: 한 줄 표지(MSGR: done|handoff)는 parseMessengerDisposition 규칙으로, 모델이 줄 끝에 붙인 표지(백틱 포함)도 뗀다. */
export function followupText(value) {
  const body = parseMessengerDisposition(String(value ?? '')).text.trimEnd();
  return body.replace(/[ \t]*`?MSGR: (?:handoff|done)`?[ \t]*$/, '').trimEnd() || body;
}
export const FOLLOWUP_FAILED = '결재 뒤 작업을 이어서 하지 못했습니다(에이전트 오류). 이어서 진행하려면 다시 말씀해 주세요.\n/ The agent could not continue after the decision (error). Ask again to continue.';
export const FOLLOWUP_BUSY = '결재 결과를 에이전트에게 전달하지 못했습니다(대화가 계속 바쁩니다). 이어서 진행하려면 다시 말씀해 주세요.\n'
  + '/ Could not hand the decision to the agent (conversation stayed busy). Ask again to continue.';
export const NO_ACTIVE_REQUEST = 'No active Argo Messenger request in this conversation — approvals attach to the message you are answering';
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

/** 메신저로 안 보내는 작업의 전달 상태(1-b ③) — 'local' = 의도적으로 다른 곳에 보내거나 남긴다, 'none' = 결과를 보낼 곳이 없다.
 *  OpenClaw delivery(docs/automation/cron-jobs/delivery.md): mode none = 러너가 결과를 보내지 않음(운영자가 고른 것 — 실행 기록·세션에 남는다),
 *  webhook = URL로 보냄, announce(기본값) = 채널로 보냄. main 세션 작업은 주 대화에, current·session:<id> 작업은 묶인 대화에 결과가 남는다
 *  (docs/automation/cron-jobs/payloads.md). isolated 작업이 announce인데 채널(또는 'last')·대상·묶인 대화(sessionKey)가 없으면 보낼 곳이
 *  정해지지 않은 것이다 — OpenClaw도 "last -> no route, will fail-closed"로 표시한다(2026.9.6 격리 실측). Hermes의 deliver=origin·출처 없음과
 *  같은 자리라 소유자가 메신저에서 방을 고를 수 있다. */
export function jobDelivery(job) {
  const d = job?.delivery;
  if (d && typeof d === 'object') {
    if (d.mode === 'none' || d.mode === 'webhook') return 'local';
    if (d.channel && d.channel !== 'last') return 'local'; // 다른 채널(또는 다른 봇 계정의 이 채널)로 보낸다
    if (String(d.to ?? '').trim()) return 'local';        // 대상이 적혀 있다(제공자 접두어 대상 등)
  }
  const target = String(job?.sessionTarget ?? '');
  if (target === 'main' || target === 'current' || target.startsWith('session:')) return 'local';
  return String(job?.sessionKey ?? '').trim() ? 'local' : 'none';
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

/** OpenClaw 작업 → setRoutines 행. 메신저 전달 작업이 아니면(channel === null) 기본은 null — mirrorAll이면 보이되 고칠 수 없다.
 *  다만 결과를 보낼 곳이 없는 작업(delivery 'none')은 원래 결과를 보내려던 작업이라 스위치와 무관하게 늘 보인다(소유자가 방을 고르게, 검수 4). */
export function jobToRow(job, { channel, tz = null, state = {}, mirrorAll = false, now = Date.now() } = {}) {
  if (channel === null && !mirrorAll && jobDelivery(job) !== 'none') return null;
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
  row.status = { ...(fresh ? status : prev.value) };
  if (channel === null) row.status.delivery = jobDelivery(job);
  return row;
}

/** 메신저 편집 patch → OpenClaw cron.update patch. 표현 못 하면 예외(→ routineEditDone failed).
 *  channel_id(1-b ③)는 그 작업의 전달 대상을 이 봇 계정의 그 방으로 바꾼다(OpenClaw CronDeliveryPatch — 적은 필드만 바뀐다). */
export function buildEditPatch(job, patch = {}, tz = null, { accountId = null } = {}) {
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
  if ('channel_id' in patch) {
    if (!UUID_RE.test(String(patch.channel_id ?? ''))) throw new Error('channel_id must be a channel id');
    out.delivery = { mode: 'announce', channel: CHANNEL, to: String(patch.channel_id), ...(accountId ? { accountId } : {}),
      ...(job?.delivery?.threadId != null ? { threadId: null } : {}) }; // 다른 채널의 스레드 id는 지운다
  }
  return out;
}

const redact = (s) => String(s).replace(/bot[^/\s]+\//g, 'bot***/').replace(/argo_bot_[A-Za-z0-9]+/g, 'argo_bot_***');

/** 예약 작업 미러 + 편집 반영(계정 하나). cronAccess() → {state:'ready', cron} | {state:'pending'} | {state:'unsupported', reason}. */
export class RoutineMirror {
  /** @param {any} opts */
  constructor({ api, cronAccess, accountId, ownsUnscoped = () => true, stateFile, tz = hostTimeZone, mirrorAll = () => String(process.env.ARGO_MSGR_MIRROR_ALL ?? '').trim() === '1',
    version = () => '', approvalMode = () => 'unknown', now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { api, cronAccess, accountId, ownsUnscoped, stateFile, tz, mirrorAll, version, approvalMode, now, log });
    this.state = null; this.sentDigest = null; this.sentAt = 0; this.unsupportedSent = null;
    this.serverMirrorAll = false; // 소유자가 메신저에서 켠 "모든 예약 작업 보기"(1-b ②, reportStatus 응답·config 이벤트)
    this.statusSent = null;       // 마지막으로 보고한 [version, approval_mode, mirror_all_applied]
  }
  /** 1-b ①: 버전·승인 모드·설정 반영값이 마지막 보고와 다를 때만 reportStatus(유휴 상태 호출 0). 응답의 mirror_all을 바로 반영한다. */
  async reportStatus() {
    const cur = [String(this.version() || 'unknown'), String(this.approvalMode() || 'unknown'), this.serverMirrorAll];
    if (this.statusSent && stableStringify(cur) === stableStringify(this.statusSent)) return 'unchanged';
    const res = (await this.api.reportStatus({ version: cur[0], approval_mode: cur[1], mirror_all_applied: cur[2] })) ?? {};
    this.statusSent = cur;
    await this.applyMirrorAll(res.mirror_all === true);
    return 'sent';
  }
  /** 1-b ②: 서버 설정이 바뀌면 미러를 바로 다시 보내고(강제), 반영했다고 다시 보고한다(서버가 config 이벤트를 그만 준다). */
  async applyMirrorAll(on) {
    const next = on === true;
    if (next === this.serverMirrorAll) return false;
    this.serverMirrorAll = next;
    await this.sync(true);
    await this.reportStatus();
    return true;
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
    const now = this.now(), iso = new Date(now).toISOString(), tz = this.tz(), mirrorAll = this.serverMirrorAll || this.mirrorAll(); // 환경 변수 방식도 OR로 유지
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
      const edit = ev?.patch && typeof ev.patch === 'object' ? ev.patch : {};
      const routeOnly = ev?.op === 'update' && Object.keys(edit).length === 1 && 'channel_id' in edit;
      if (verdict === 'failed') error = 'routine_not_found';
      // 서버도 막지만 어댑터가 한 번 더 — 메신저 전달 작업만 고치고, 보낼 곳이 없는 작업(delivery 'none')은 방 지정만 받는다(1-b ③)
      else if (this.channelOf(job) === null && !(routeOnly && jobDelivery(job) === 'none')) error = 'not_editable';
      else if (verdict === 'superseded') status = 'superseded';
      else {
        if (ev.op === 'delete') await access.cron.remove(id);
        else {
          const patch = buildEditPatch(job, edit, this.tz(), { accountId: this.accountId });
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

/** 결재 도구 스키마(1-b ④) — 설명은 Hermes _APPROVAL_SCHEMA와 같은 뜻. OpenClaw 도구 매개변수는 JSON Schema(TypeBox Compile이 그대로 받는다). */
export const APPROVAL_TOOL = 'argo_request_approval';
export const APPROVAL_TOOL_DESCRIPTION = 'Ask a human in Argo Messenger to approve something before you do it (spending, sending messages to outsiders, '
  + 'deleting or changing important data, anything you were told needs approval). Posts an approval card on the message '
  + 'you are answering. The decision arrives later in this same conversation, then you continue and report. After calling it, '
  + 'tell the person you requested approval and end your turn — do not do the work until approved.';
export const APPROVAL_TOOL_PARAMETERS = { type: 'object', properties: {
  title: { type: 'string', description: 'What needs approval, one short line (e.g. "Spend $400 on this week\'s ads")' },
  reason: { type: 'string', description: 'Why, and what will happen once approved (optional)' } }, required: ['title'] };
export const APPROVAL_TOOL_NEXT = 'Approval card posted. Tell the person you requested approval and end this turn. '
  + 'The decision will arrive in this conversation; only then continue.';

/** 결정 뒤 재개 턴에 넣는 합성 메시지(Hermes와 같은 문구). */
export function agentDecisionPrompt(status, title, who) {
  return status === 'approved'
    ? `[Argo Messenger — approval decided] Your approval request "${title}" was APPROVED by ${who}. `
      + 'Carry out the approved work now and report the result. Your reply is posted as the follow-up on the approval card.'
    : `[Argo Messenger — approval decided] Your approval request "${title}" was REJECTED by ${who}. `
      + 'Do not carry out that work. Reply briefly to acknowledge; your reply is posted as the follow-up on the approval card.';
}

/** 재개에 필요한 원문 정보만(본문은 저장하지 않는다). */
function sourceInfo(m) {
  const chat = m?.chat ?? {}, from = m?.from ?? {};
  return { message_id: m?.message_id ?? null, thread_root: m?.thread_root ?? null, delegated: Boolean(m?.delegated),
    chat: { id: chat.id ?? null, kind: chat.kind ?? null, name: chat.name ?? null }, from: { id: from.id ?? null, name: from.name ?? null } };
}

const skey = (s) => String(s ?? '').trim().toLowerCase(); // 세션 키 비교(대소문자 무시)
const latest = (list) => list.reduce((best, m) => (!best || Number(m.message_id) > Number(best.message_id) ? m : best), null);
const permanentError = (e) => Number(e?.status) >= 400 && Number(e?.status) < 500 && ![408, 429].includes(Number(e?.status));

/** 위험 작업 승인 ↔ 메신저 결재 카드(계정 하나). resolve({externalId, kind, decision})가 OpenClaw에 결정을 돌려준다.
 *  1-b: 에이전트가 올리는 결재(requestAgent) → 결정되면 resume({approvalId, info, text})로 같은 대화에서 재개 → 그 턴의 답을 후속 보고로.
 *  재개 턴은 spawn으로 띄우고 기다리지 않는다(폴 루프가 이벤트를 기다리므로 — 재개 턴이 또 승인을 기다려도 결정 이벤트를 받아야 한다).
 *  세션 단위 순서(검수 H1): 이 플러그인이 띄운 턴이 그 세션에서 돌고 있으면 재개 턴은 끝날 때까지 기다리고(10초 간격, 5분 상한),
 *  재개 턴이 도는 동안 같은 세션에 온 새 글은 재개 턴이 끝난 뒤에 넣는다(답 수집이 섞여 후속 보고로 새지 않게). */
export class ApprovalBridge {
  /** @param {any} opts */
  constructor({ api, resolve, resume = null, agentStateFile = null, spawn = null, now = () => Date.now(), log = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), busyWaitMs = 10_000, busyWaitTries = 30, followupRetryMs = [1_000, 3_000] }) {
    Object.assign(this, { api, resolve, resume, agentStateFile, now, log, sleep, busyWaitMs, busyWaitTries, followupRetryMs });
    this.spawn = spawn ?? ((fn) => { Promise.resolve().then(fn).catch((e) => this.log(`argo-msgr: approval resume failed — ${redact(e?.message ?? e)}`)); });
    this.sources = new Map();   // message_id → 실행 중인 원문(execution_attempt 포함)
    this.sessions = new Map();  // message_id → 그 원문을 처리하는 OpenClaw 세션 키(dispatch sessionKey)
    this.approvals = new Map(); // 메신저 approval_id → {approvalId, externalId, kind, card}
    this.byExternal = new Map(); // OpenClaw 승인 요청 id → 메신저 approval_id
    this.agents = null;         // 에이전트 결재 id → {sessionKey, source, title, at} (파일에 저장 — 재시작 뒤에도 재개)
    this.agentsLoad = null;     // 첫 읽기 promise(동시에 여러 곳에서 읽어도 한 번만, 검수 L4)
    this.followed = new Set();  // 후속 보고를 이미 올린 결재 id
    this.turns = new Map();     // 세션 키 → 이 플러그인이 띄워 진행 중인 턴 수(일반 수신·재개)
    this.resuming = new Map();  // 세션 키 → 진행 중인 재개 턴(끝나면 풀리는 promise)
    this.parents = new Map();   // 세션 키 → 재개 중인 부모 결재 {approvalId, source} — 그 턴의 카드는 부모의 원문에 붙는다(검수 3·M-3)
  }
  static approvalIdFor(externalId) { return `oc-${createHash('sha256').update(String(externalId)).digest('hex').slice(0, 24)}`; } // 같은 요청을 다시 올려도 같은 카드(서버 멱등)
  track(m, sessionKey = null) {
    if (!m?.execution_attempt || m.message_id == null) return;
    this.sources.set(Number(m.message_id), m);
    if (sessionKey) this.sessions.set(Number(m.message_id), String(sessionKey));
  }
  done(m) { this.sources.delete(Number(m?.message_id)); this.sessions.delete(Number(m?.message_id)); }

  // ── 세션 단위 턴 순서(검수 H1) ──
  /** 턴 시작을 기록하고, 끝낼 때 부를 함수를 돌려준다(두 번 불러도 한 번만 센다). */
  beginTurn(sessionKey) {
    const k = skey(sessionKey);
    if (!k) return () => {};
    this.turns.set(k, (this.turns.get(k) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const n = (this.turns.get(k) ?? 1) - 1;
      if (n > 0) this.turns.set(k, n); else this.turns.delete(k);
    };
  }
  isBusy(sessionKey) { return (this.turns.get(skey(sessionKey)) ?? 0) > 0; }
  /** 새 글을 넣기 전에: 그 세션에서 재개 턴이 돌고 있으면 끝날 때까지 기다린다. */
  async afterResume(sessionKey) {
    const k = skey(sessionKey);
    for (let p = this.resuming.get(k); p; p = this.resuming.get(k)) await p;
  }
  /** 도구를 만들 가치가 있는가 — 그 세션에 처리 중인 메신저 원문이나 재개 중인 부모 결재가 있을 때만(예약 작업 실행 등에서는 숨긴다). */
  hasCurrentSource(sessionKey) { return this.sourcesForSession(sessionKey).length > 0 || this.parents.has(skey(sessionKey)); }

  /** 승인 대기는 에이전트 실행 안에서 오므로 원문을 직접 모른다 — 그 채팅에서 아직 답하지 않은 실행 중 가장 최근 것(1-a, 세션 키 없는 요청). */
  sourceForChat(chatId) { return latest([...this.sources.values()].filter((m) => String(m?.chat?.id) === String(chatId))); }
  sourcesForSession(sessionKey) {
    const k = skey(sessionKey);
    if (!k) return [];
    const out = [];
    for (const [id, sk] of this.sessions) { const m = this.sources.get(id); if (m && skey(sk) === k) out.push(m); }
    return out;
  }
  /** 셸·플러그인 승인 카드. 세션 키가 있으면 그 세션의 원문(없으면 재개 중인 부모 결재의 원문)에만 붙인다 — 다른 대화의 원문으로 새지 않게.
   *  세션 키가 없는 요청은 1-a대로 그 채팅의 최근 원문. 붙일 곳이 없으면 카드를 만들지 않는다(OpenClaw 기존 경로로 둔다). */
  async request({ externalId, kind, chatId, sessionKey = null, command, reason }) {
    let where = null;
    if (sessionKey) {
      const m = latest(this.sourcesForSession(sessionKey));
      const parent = m ? null : this.parents.get(skey(sessionKey));
      if (m) where = { execution_attempt: m.execution_attempt };
      else if (parent) where = { parent_approval_id: parent.approvalId };
    } else {
      const m = this.sourceForChat(chatId);
      if (m) where = { execution_attempt: m.execution_attempt };
    }
    if (!where) return null;
    const approvalId = ApprovalBridge.approvalIdFor(externalId);
    const res = (await this.api.requestApproval({ ...where, approval_id: approvalId, command, reason: reason ?? null })) ?? {};
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

  // ── 1-b ④: 에이전트가 올리는 결재 ─────────────────────────────────────────
  async loadAgents() {
    this.agentsLoad ??= (async () => {
      try { this.agents = this.agentStateFile ? (JSON.parse(await readFile(this.agentStateFile, 'utf8')) ?? {}) : {}; } catch { this.agents = {}; }
    })();
    await this.agentsLoad;
  }
  async saveAgents() { // 0600, 원자적 교체. 토큰·본문은 넣지 않는다. 실패해도 결재 흐름은 막지 않는다(재시작 뒤 재개만 못 한다)
    if (!this.agentStateFile) return;
    const cutoff = this.now() - AGENT_APPROVAL_KEEP_MS;
    for (const [id, v] of Object.entries(this.agents ?? {})) if (!(Date.parse(v?.at ?? '') >= cutoff)) delete this.agents[id];
    try {
      await mkdir(dirname(this.agentStateFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.agentStateFile}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(this.agents ?? {}), { mode: 0o600, flag: 'wx' });
      await rename(tmp, this.agentStateFile);
    } catch (e) { this.log(`argo-msgr: agent approvals not saved — ${redact(e?.message ?? e)}`); }
  }
  /** 결재 도구: 이 턴이 처리 중인 메신저 원문에 결재 카드를 붙인다(검수 H2 — 원문을 정확히 정할 때만).
   *  세션 키가 같은 원문 중에서, 도구 문맥의 요청자(requesterSenderId)가 있으면 발신자가 같은 것만. 그룹 채널은 모든 글이 한 세션이라
   *  요청자가 반드시 맞아야 한다. 후보가 정확히 하나가 아니면 거절. 재개 턴(원문 없음)은 재개 중인 부모 결재의 원문에 붙인다. */
  async requestAgent({ sessionKey, requesterSenderId = null, title, reason }) {
    const t = String(title ?? '').trim().slice(0, 300);
    if (!t) throw new Error('title is required');
    const r = reason == null ? null : String(reason).trim().slice(0, 1000) || null;
    const list = this.sourcesForSession(sessionKey);
    const sender = requesterSenderId == null || requesterSenderId === '' ? null : String(requesterSenderId);
    let m = null, parent = null;
    if (list.length) {
      const group = list.some((x) => x?.chat?.kind !== 'dm');
      // 재검수 LOW-4: 요청자가 없는 실행(같은 DM 세션에 묶인 예약 작업 등)은 DM이어도 거절 — 대기 중인 사람의 원문에 붙지 않게
      const cands = sender ? list.filter((x) => String(x?.from?.id ?? '') === sender) : [];
      if (cands.length === 1) m = cands[0];
    } else parent = this.parents.get(skey(sessionKey)) ?? null;
    if (!m && !parent) { const e = new Error(NO_ACTIVE_REQUEST); e.status = 409; throw e; }
    const approvalId = `ag-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const where = m ? { execution_attempt: m.execution_attempt } : { parent_approval_id: parent.approvalId };
    const res = (await this.api.requestApproval({ kind: 'agent', ...where, approval_id: approvalId, title: t, reason: r })) ?? {};
    await this.loadAgents();
    this.agents[approvalId] = { sessionKey: (m && this.sessions.get(Number(m.message_id))) ?? (sessionKey ? String(sessionKey) : null),
      source: m ? sourceInfo(m) : parent.source, title: t, at: new Date(this.now()).toISOString() };
    await this.saveAgents();
    return { approval_id: approvalId, status: res.status ?? 'pending', card_message_id: res.message_id ?? null };
  }
  /** 후속 보고: 결재 한 건에 한 번만. 일시 오류는 짧게 재시도(서버가 같은 요청이면 같은 글을 돌려준다, 검수 L3), 영구 거절(4xx)은 바로 멈춘다.
   *  실패는 기록만 하고 삼킨다(수신·답장을 막지 않는다). 올리면 그 결재로 재개 중인 세션의 부모 연결을 지운다(검수 3). */
  async followup(approvalId, text) {
    if (this.followed.has(approvalId)) return null;
    text = followupText(text); // 넘김 표지는 사람에게 보이지 않게(줄 끝에 붙인 표지 포함 — 2026-09-30 효원 실측)
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.api.sendFollowup(approvalId, text);
        this.followed.add(approvalId);
        for (const [k, p] of this.parents) if (p.approvalId === approvalId) this.parents.delete(k);
        return res ?? {};
      } catch (e) {
        if (permanentError(e) || attempt >= this.followupRetryMs.length) {
          this.log(`argo-msgr: follow-up for ${approvalId} failed — ${redact(e?.message ?? e)}`);
          return null;
        }
        await this.sleep(this.followupRetryMs[attempt]);
      }
    }
  }
  async resumeAgent(approvalId, ev, info) {
    const status = ev?.status;
    if (status === 'approved' && ev.resume !== true) return 'noop'; // 서버 재판정 실패(동의 철회·전달 불가 등) — 이어서 할 수도 보고할 수도 없다
    if (status !== 'approved' && status !== 'rejected') return 'noop';
    if (!info?.source || typeof this.resume !== 'function') { // 재시작 등으로 원래 대화를 잃었다 — 사람에게 알리고 끝낸다
      await this.followup(approvalId, status === 'approved' ? FOLLOWUP_LOST_APPROVED : FOLLOWUP_LOST_REJECTED);
      return 'lost';
    }
    const text = agentDecisionPrompt(status, info.title || ev.action || '', ev.decided_by_name || 'the approver');
    this.spawn(async () => {
      const k = skey(info.sessionKey);
      // 그 세션에서 이 플러그인이 띄운 턴(일반 수신·다른 재개)이 돌고 있으면 끝날 때까지 기다린다 — 폴 루프는 막지 않는다(spawn 안)
      for (let tries = 0; k && (this.isBusy(k) || this.resuming.has(k)); tries++) {
        if (tries >= this.busyWaitTries) { await this.followup(approvalId, FOLLOWUP_BUSY); return; }
        await this.sleep(this.busyWaitMs);
      }
      const end = this.beginTurn(k);
      let release = () => {};
      const running = new Promise((r) => { release = r; });
      if (k) {
        this.resuming.set(k, running);
        if (status === 'approved') this.parents.set(k, { approvalId, source: info.source });
      }
      let answer = '', failed = false, files = null;
      try { // resume은 문자열(답) 또는 { text, names, attach }(답에 파일이 붙은 경우 — attach(후속 보고 글 id)가 파일을 그 글에 올린다)
        const out = await this.resume({ approvalId, info, text });
        if (out && typeof out === 'object') { answer = String(out.text ?? '').trim(); files = out; }
        else answer = String(out ?? '').trim();
      }
      catch (e) { failed = true; this.log(`argo-msgr: resumed turn for ${approvalId} failed — ${redact(e?.message ?? e)}`); }
      finally {
        end();
        if (this.resuming.get(k) === running) this.resuming.delete(k);
        release();
        // 재검수 MEDIUM: 예외가 나도 부모 연결을 푼다 — 남아 있으면 24시간 동안 같은 세션의 다른 실행이 옛 원문에 카드를 붙인다
        if (this.parents.get(k)?.approvalId === approvalId) this.parents.delete(k);
      }
      if (files?.names?.length && typeof files.attach === 'function' && !failed) {
        // 후속 보고가 아직이면 이제 올린다(글 없이 파일만이면 파일 이름으로) — 그 글에 파일을 붙인다. 후속 보고가 실패하면 파일도 올리지 않는다.
        const res = await this.followup(approvalId, answer || files.names.join(', '));
        if (res?.message_id) await files.attach(Number(res.message_id)).catch((e) => this.log(`argo-msgr: follow-up files for ${approvalId} failed — ${redact(e?.message ?? e)}`));
        else this.log(`argo-msgr: follow-up files for ${approvalId} not sent — no follow-up message`);
      } else if (answer) await this.followup(approvalId, answer);
      else if (failed) await this.followup(approvalId, FOLLOWUP_FAILED); // 결정한 사람이 아무 안내 없이 기다리지 않게
    });
    return status === 'approved' ? 'resumed' : 'rejected';
  }

  /** approval_decided: 먼저 선점 ack — claimed일 때만 진행한다(최대 한 번 재개, H3).
   *  셸·플러그인 결재: 승인+resume일 때만 allow-once로 OpenClaw에 돌려준다. OpenClaw가 이미 기다리기를 멈췄으면(대기 정보 없음·resolve 실패·
   *  applied:false) 승인된 결정은 늦게 도착했다고 후속 보고로 알린다(1-a L-12 후속, 검수 L1). 에이전트 결재(ev.agent): 같은 대화로 재개(1-b ④). */
  async onDecided(ev) {
    const aid = String(ev?.approval_id ?? '');
    const ack = (await this.api.ackApproval(aid)) ?? {};
    if (ev?.agent) {
      await this.loadAgents();
      const info = this.agents[aid] ?? null;
      if (info) { delete this.agents[aid]; await this.saveAgents(); }
      if (!ack.claimed) return 'skipped'; // 다른 어댑터·재시도가 선점했다
      return this.resumeAgent(aid, ev, info);
    }
    const entry = this.approvals.get(aid);
    this.forget(aid); // 먼저 잊는다 — 결정 뒤 코어가 부르는 updateEntry가 이미 결정된 카드를 만료로 닫으려 하지 않게
    if (!ack.claimed) return 'skipped'; // 다른 어댑터·재시도가 선점했다
    const allow = ev.status === 'approved' && ev.resume === true;
    let late = !entry; // 재시작 뒤라 대기 중인 요청이 없다
    if (entry) {
      try {
        const res = await this.resolve({ externalId: entry.externalId, kind: entry.kind, decision: allow ? 'allow-once' : 'deny' });
        if (res && typeof res === 'object' && res.applied === false) { // OpenClaw가 받았지만 이미 끝난 요청이라 적용하지 않았다
          const a = res.approval ?? {};
          // 재검수 LOW-6: 다른 화면에서 이미 승인돼 실행됐으면 "실행되지 않았다"는 틀린 안내 — 승인으로 끝난 기록이면 알리지 않는다
          late = !(['approved', 'allowed'].includes(String(a.status ?? '')) || String(a.decision ?? '').startsWith('allow'));
          if (!late) return allow ? 'allow-once' : 'deny';
        }
      } catch (e) { late = true; this.log(`argo-msgr: approval ${aid} could not be handed to OpenClaw — ${redact(e?.message ?? e)}`); }
    }
    if (!late) return allow ? 'allow-once' : 'deny';
    if (allow) {
      this.log(`argo-msgr: approval ${aid} decided after OpenClaw stopped waiting — command was not run`);
      await this.followup(aid, FOLLOWUP_LATE);
    }
    return 'late';
  }
  /** OpenClaw 쪽 대기가 끝났는데(시간 초과·다른 곳에서 결정) 카드가 열려 있으면 expireApproval로 닫는다. */
  async expire(externalId) {
    const aid = this.byExternal.get(String(externalId));
    if (!aid) return false;
    try { await this.api.expireApproval(aid); } catch (e) { this.log(`argo-msgr: expireApproval ${aid} failed — ${redact(e?.message ?? e)}`); } finally { this.forget(aid); }
    return true;
  }
}
