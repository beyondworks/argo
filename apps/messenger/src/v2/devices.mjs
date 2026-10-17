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
export function v2StateBar(st) {
  if (!st) return null;
  if (st.state === 'paused') return 'v2.state.paused';
  if (st.state === 'update_required') return 'v2.state.update';
  return null;
}
/** signed_out의 이유 → 로그인 화면 안내 키. */
export const v2SignOutNotice = (st) => (st?.state === 'signed_out' ? (st.reason === 'login_required' ? 'v2.state.loginRequired' : 'v2.state.signedOut') : null);
