// 메신저 축소판 A+(2026-10-19 유건 승인) 화면 판단 — 순수 모듈(React·Supabase 없음, test/aplus-model.test.mjs가 잠근다).
// A+ = ① 내 Argo 에이전트별 1:1 ② 사람은 나 혼자인 '내 에이전트 회의방'(라운드 2 고정) ③ 내 PC의 Argo가 직접 부르는 외부 봇(헤르메스·오픈클로).
// 채널·조직·파견·사람 채팅은 이번 범위가 아니다 — A+ 셸에는 그 화면이 없다(서버도 막는다). 메신저는 Pro 전용, 무료는 서버를 쓰지 않는다.

export const MEETING_MIN = 2; // 1명이면 1:1과 같다
export const MEETING_MAX = 5; // 위험 R11 — 서버도 S ≤ 5를 강제한다
export const MEETING_ROUNDS = 2; // room.mjs DELEGATION_LIMITS.on.rounds — 회의방은 2 고정(풀림 4는 쓰지 않음)
export const TITLE_MAX = 60;
export const BOT_KINDS = Object.freeze(['hermes', 'openclaw']); // 봇 주소·키는 서버에 없고 내 PC Argo에만 있다(약속 v1.1, #1116) — 앱은 연결을 안내만 한다

/** 서버 판정 플랜('pro'|'trial'|'free'|null) → 'open'(메신저 사용) | 'free'(Pro 안내, 서버 요청 0) | 'unknown'(확인 못 함, 사람이 다시 확인). */
export function accessOf(plan) {
  if (plan === 'pro' || plan === 'trial') return 'open';
  if (plan === 'free') return 'free';
  return 'unknown';
}

/** 내 에이전트 → 1:1 목록 줄. 남의 에이전트·은퇴(retired)는 빼고, 멈춘(paused) 에이전트는 남기되 보내기를 막는다.
    rooms: agentId → { roomId, at(마지막 글 시각 ms), unread }. 최근 대화 순, 대화가 없으면 이름순. */
export function agentRows(agents = [], { uid, rooms = {} } = {}) {
  const collator = new Intl.Collator('ko');
  return agents
    .filter((a) => a && a.owner_user_id === uid && a.status !== 'retired')
    .map((a) => {
      const r = rooms[a.id] ?? {};
      return { id: a.id, name: a.display_name || a.slug || '?', role: a.role_text || '', paused: a.status === 'paused', bot: a.hosting === 'bot', roomId: r.roomId ?? null, at: r.at ?? 0, unread: r.unread ?? 0, last: r.last ?? '' };
    })
    .sort((x, y) => (y.at - x.at) || collator.compare(x.name, y.name));
}

/** 회의 참가자 고르기 — 상한에서는 더 넣지 않는다(capped). 이미 고른 것은 뺀다. */
export function togglePick(picked = [], id, max = MEETING_MAX) {
  if (picked.includes(id)) return { picked: picked.filter((x) => x !== id), capped: false };
  if (picked.length >= max) return { picked, capped: true };
  return { picked: [...picked, id], capped: false };
}

/** 회의방 만들기 입력 문제 → 사전 키 접미어 | null. agents: 고를 수 있는(멈추지 않은) 내 에이전트 수. */
export function meetingDraftProblem({ title = '', picked = [], available = Infinity } = {}) {
  if (available < MEETING_MIN) return 'fewAgents';
  const t = String(title).trim();
  if (!t) return 'title';
  if (t.length > TITLE_MAX) return 'titleLong';
  if (new Set(picked).size !== picked.length) return 'dup';
  if (picked.length < MEETING_MIN) return 'min';
  if (picked.length > MEETING_MAX) return 'max';
  return null;
}

/** 회의 진행(서버·본체가 주는 값) → 진행 줄. run: null | { state: 'running'|'done'|'cancelled'|'cancelling'|'failed', round, answered, total }.
    round는 1..MEETING_ROUNDS로 자른다(서버가 더 큰 값을 줘도 2를 넘겨 그리지 않는다). */
export function meetingView(run) {
  if (!run || !run.state) return { state: 'idle', canCancel: false, canSend: true };
  const total = Math.max(0, Math.min(MEETING_MAX, Number(run.total) || 0));
  const round = Math.max(1, Math.min(MEETING_ROUNDS, Number(run.round) || 1));
  const answered = Math.max(0, Math.min(total, Number(run.answered) || 0));
  const state = ['running', 'done', 'cancelled', 'cancelling', 'failed'].includes(run.state) ? run.state : 'failed';
  return { state, round, rounds: MEETING_ROUNDS, answered, total, canCancel: state === 'running', canSend: state !== 'running' && state !== 'cancelling' };
}

/** 회의 참가자로 고를 수 있는가 — 멈춤·외부 봇은 안 된다(서버 msgr2_meeting_no_bot, #1117). */
export const meetingPickable = (row) => !row.paused && !row.bot;

/** 봇 상태 → 'connected' | 'off' | 'unknown'. 서버에는 봇 상태 표가 없어 그 봇의 마지막 일로 판단한다:
    마지막 일이 bot_unreachable로 실패 = 꺼짐, 끝까지 됨 = 연결됨, 일이 없거나 그 밖 = 확인 못 함. status를 직접 주면(가짜 원본) 그 값. */
export function botStatusOf(bot) {
  const s = bot?.status;
  if (s === 'connected') return 'connected';
  if (s === 'off' || s === 'disconnected' || s === 'stopped') return 'off';
  const w = bot?.lastWork;
  if (w?.state === 'failed' && w.error_code === 'bot_unreachable') return 'off';
  if (w?.state === 'done') return 'connected';
  return 'unknown';
}

/** 서버가 읽을 때 계산하는 지금 상태(_msgr2_effective_state, 20261018000000_msgr2_work.sql)와 같은 계산. 원래 값은 바뀌지 않으므로 앱도 이렇게 읽어야
    기한 지난 offered(내 PC Argo가 꺼져 있음)·리스가 끝난 일이 '진행 중'으로 굳지 않는다(재검수 높음). */
export function effectiveState(w, now = Date.now()) {
  const st = w?.state ?? null;
  const exp = Date.parse(w?.expires_at ?? ''); const lease = Date.parse(w?.lease_until ?? '');
  if (st === 'offered' && Number.isFinite(exp) && exp <= now) return 'expired';
  if (['accepted', 'running', 'awaiting_approval'].includes(st) && !w.has_result && Number.isFinite(lease) && lease <= now) return 'stalled';
  return st;
}

/** 서버 일의 지금 상태 → 회의 진행 상태. expired·stalled·failed는 끝남(보내기 허용). */
export function runStateOf(workState) {
  if (['offered', 'accepted', 'running', 'awaiting_approval'].includes(workState)) return 'running';
  if (workState === 'done') return 'done';
  if (workState === 'cancelled') return 'cancelled';
  if (!workState) return null;
  return 'failed';
}

/** 회의 취소 RPC(msgr2_work_cancel)가 돌려준 상태 → 진행 상태. 이미 끝난 일이면 그 상태(끝남 — 보내기 허용), 취소했으면 cancelled. */
export const afterCancel = (st) => runStateOf(st === 'cancelled' ? 'cancelled' : st) ?? 'cancelled';

/** 회의 진행을 글로 채운다: 그 일(workId)의 에이전트 글 meta.round 중 가장 큰 라운드, 그 라운드에 답한 에이전트 수.
    run.workId가 없으면(가짜 원본·옛 값) 주어진 round·answered를 그대로 쓴다. */
export function deriveRun(run, msgs = []) {
  if (!run?.workId) return run;
  const posts = msgs.filter((m) => m.workId === run.workId && Number(m.round) >= 1);
  if (!posts.length) return { ...run, round: 1, answered: 0 };
  const round = Math.max(...posts.map((m) => Number(m.round)));
  return { ...run, round, answered: new Set(posts.filter((m) => Number(m.round) === round).map((m) => m.author)).size };
}

const ERR_CODES = ['msgr2_lite_only', 'msgr2_meeting_full', 'msgr2_meeting_no_bot', 'msgr2_pro_required', 'msgr2_meeting_agents', 'msgr2_agent_not_allowed', 'bot_unreachable', 'bot_limit'];
/** 서버 거부·일 오류 코드 → 사전 키(ap.err.*) | null. 메시지 안에 코드가 들어 있어도 찾는다(PostgREST message = 예외 이름). */
export function errorKey(e) {
  const text = typeof e === 'string' ? e : `${e?.code ?? ''} ${e?.message ?? ''}`;
  const hit = ERR_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(text));
  return hit ? `aplus.err.${hit}` : null;
}

const LIMITS = ['pro', 'need_update', 'bot_turns', 'bot_hops', 'agent_minute', 'streak'];
/** 서버가 상한에 걸려 방에 넣는 안내 글(meta.code 'work.limit', meta.limit) → 사전 키 | null(그 밖의 system 글). */
export function limitKey(meta) {
  if (meta?.code !== 'work.limit') return null;
  return `aplus.limit.${LIMITS.includes(meta.limit) ? meta.limit : 'other'}`;
}

/** 화면 폭 → 배치. 390(휴대폰) = 한 칸 + 아래 탭, 그 이상 = 왼쪽 목록 + 오른쪽 대화. */
export const layoutOf = (width) => (width < 640 ? 'phone' : 'split');

/** 서버가 아직 열지 않은 기능(회의방·외부 봇 — 서버 스위치로 차례로 연다)의 오류인가. 화면은 오류가 아니라 '아직 열리지 않음'으로 그린다. */
export const notOpenYet = (e) => /\b(aplus_not_ready|feature_closed|PGRST202|PGRST204|42703)\b/.test(String(e?.code ?? '') + ' ' + String(e?.message ?? '')); // 함수·열이 아직 없음(#1117 병합 전 서버)
