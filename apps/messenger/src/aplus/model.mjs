// 메신저 축소판 A+(2026-10-19 유건 승인) 화면 판단 — 순수 모듈(React·Supabase 없음, test/aplus-model.test.mjs가 잠근다).
// A+ = ① 내 Argo 에이전트별 1:1 ② 사람은 나 혼자인 '내 에이전트 회의방'(라운드 2 고정) ③ 내 PC의 Argo가 직접 부르는 외부 봇(헤르메스·오픈클로).
// 채널·조직·파견·사람 채팅은 이번 범위가 아니다 — A+ 셸에는 그 화면이 없다(서버도 막는다). 메신저는 Pro 전용, 무료는 서버를 쓰지 않는다.

export const MEETING_MIN = 2; // 1명이면 1:1과 같다
export const MEETING_MAX = 5; // 위험 R11 — 서버도 S ≤ 5를 강제한다
export const MEETING_ROUNDS = 2; // room.mjs DELEGATION_LIMITS.on.rounds — 회의방은 2 고정(풀림 4는 쓰지 않음)
export const TITLE_MAX = 60;
export const BOT_KINDS = Object.freeze(['hermes', 'openclaw']);

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
      return { id: a.id, name: a.display_name || a.slug || '?', role: a.role_text || '', paused: a.status === 'paused', roomId: r.roomId ?? null, at: r.at ?? 0, unread: r.unread ?? 0, last: r.last ?? '' };
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

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;
/** 외부 봇 주소 검사(위험 R8): 루프백·사설망(Tailscale)만. 문제 → 'invalid' | 'scheme' | 'userinfo' | 'public' | null(괜찮음). */
export function botAddressProblem(input) {
  let u;
  try { u = new URL(String(input ?? '').trim()); } catch { return 'invalid'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'scheme';
  if (u.username || u.password) return 'userinfo'; // 키를 주소에 넣지 않는다 — 키는 내 PC Argo에만
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || LOOPBACK_V4.test(host)) return null;
  if (host.endsWith('.ts.net')) return null; // Tailscale MagicDNS
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127) return null; // Tailscale CGNAT 100.64.0.0/10
  return 'public';
}

/** 외부 봇 입력 문제 → 사전 키 접미어 | null. */
export function botDraftProblem({ kind, name = '', address = '' } = {}) {
  if (!BOT_KINDS.includes(kind)) return 'kind';
  if (!String(name).trim()) return 'name';
  const a = botAddressProblem(address);
  return a ? `addr.${a}` : null;
}

/** 봇 상태(본체가 알려 준 값) → 'connected' | 'off' | 'unknown'. 모르는 값은 확인 못 함으로. */
export function botStatusOf(bot) {
  const s = bot?.status;
  if (s === 'connected') return 'connected';
  if (s === 'off' || s === 'disconnected' || s === 'stopped') return 'off';
  return 'unknown';
}

/** 화면 폭 → 배치. 390(휴대폰) = 한 칸 + 아래 탭, 그 이상 = 왼쪽 목록 + 오른쪽 대화. */
export const layoutOf = (width) => (width < 640 ? 'phone' : 'split');

/** 서버가 아직 열지 않은 기능(회의방·외부 봇 — 서버 스위치로 차례로 연다)의 오류인가. 화면은 오류가 아니라 '아직 열리지 않음'으로 그린다. */
export const notOpenYet = (e) => /\b(aplus_not_ready|feature_closed|PGRST202)\b/.test(String(e?.code ?? '') + ' ' + String(e?.message ?? ''));
