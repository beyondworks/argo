// 메신저 v2 기기 목록 보기 모델(U6c-2a ④) — msgr2_devices_list 행 → 카드 줄. 순수(시험에서 그대로 부른다).
const KINDS = ['app', 'runner', 'resident'];
const APPS = ['messenger', 'desktop'];
const STATES = ['active', 'expired', 'revoked'];

/** rows: msgr2_devices_list 행. 반환: 이 기기 먼저, 그다음 사용 중, 그다음 마지막 등록 최근순. 모르는 값은 안전한 쪽(other·revoked)으로. */
export function deviceRows(rows = [], { lang = 'ko', now = Date.now() } = {}) {
  const fmt = (iso) => { const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return ''; try { return new Date(t).toLocaleString(lang === 'en' ? 'en-US' : 'ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  return rows.map((r) => {
    const state = STATES.includes(r.state) ? r.state : 'revoked';
    return { id: r.id, kind: KINDS.includes(r.kind) ? r.kind : 'other', app: APPS.includes(r.app) ? r.app : 'other', version: r.app_version || '',
      when: fmt(r.registered_at ?? r.created_at), at: Date.parse(r.registered_at ?? r.created_at ?? '') || 0, state, active: state === 'active', current: r.is_current === true };
  }).sort((a, b) => (b.current - a.current) || (b.active - a.active) || (b.at - a.at));
}

/** 연결 상태 기계 상태 → 화면 위 안내 줄 키(없으면 null). 로그아웃(signed_out)은 안내 줄이 아니라 로그인 화면으로 간다. */
export function v2StateBar(st, stuck = null) {
  if (st?.state === 'disconnected' && String(st.reason ?? '').startsWith('gave_up:')) return 'v2.state.unreachable'; // 다시 붙기를 그만둠 — 다시 시도 단추(#1086 검수 1-②)
  if (stuck && st?.state !== 'paused' && st?.state !== 'update_required' && st?.state !== 'signed_out') return 'v2.state.unreachable'; // 등록 대기 상한(1-①)
  if (!st) return null;
  if (st.state === 'paused') return 'v2.state.paused';
  if (st.state === 'update_required') return 'v2.state.update';
  return null;
}
/** signed_out의 이유 → 로그인 화면 안내 키. */
export const v2SignOutNotice = (st) => (st?.state === 'signed_out' ? (st.reason === 'login_required' ? 'v2.state.loginRequired' : 'v2.state.signedOut') : null);

/** 모든 기기 로그아웃(순서·실패). 다른 기기를 먼저(이 기기를 먼저 폐기하면 그 뒤 요청이 거부된다), 마지막에 이 기기.
    다른 기기 폐기가 실패하면 던진다(멈추고 목록을 다시 읽는다). 이 기기 폐기가 실패하면 'self_failed' — 로컬로만 로그아웃하지 않는다(#1086 검수 2). 다 되면 'done'. */
export async function revokeAllDevices(view, revoke) {
  for (const d of view.filter((x) => x.active && !x.current)) await revoke(d.id);
  const me = view.find((x) => x.current && x.active);
  if (me && !(await revoke(me.id).then(() => true, () => false))) return 'self_failed'; // 이미 폐기됐으면 서버가 오류 없이 false를 준다
  return 'done';
}
