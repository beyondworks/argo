// 에이전트 카드 "비서" 탭의 표시 판정(순수) — 화면(assistant-section.jsx)과 테스트가 같이 쓴다. 입력은 설정 API 보기(src/assistant/settings.mjs assistantSettingsView).

/** 시각 선택지 — 30분 간격 48개. 저장값이 칸 밖(손으로 고친 08:15 등)이면 그 값도 넣어 선택이 사라지지 않게 한다. */
export const HALF_HOURS = Object.freeze(Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`));
export const timeChoices = (cur) => (!cur || HALF_HOURS.includes(cur) ? HALF_HOURS : [...HALF_HOURS, cur].sort());

/** 이 에이전트 카드에서 본 비서.
    mine = 이 에이전트가 지금 비서(엔진이 돌리는 쪽), other = 다른 비서(같은 회사의 다른 에이전트 또는 다른 회사), waiting = 이 회사 설정은 이 에이전트로
    켜져 있지만 다른 회사의 비서가 맡고 있다(켠 시각이 더 늦은 쪽이 맡는다 — 두 기기에서 거의 같은 때 켠 경우). */
export function assistantRole(view, ws, slug) {
  const cur = view?.current ?? null;
  const mine = !!cur && cur.ws === ws && cur.agent === slug;
  return { mine, other: cur && !mine ? cur : null, waiting: !mine && !!view?.config?.enabled && view.config.agent === slug };
}

/** 문제 줄 — 상태 코드 목록(화면이 사전 assistant.st.<code>로 그린다). 순서 = 보여 줄 순서.
    엔진 상태 파일의 코드(calendar_error 등)는 이 기기가 실행 기기일 때만 의미가 있다(상태 파일은 기기 로컬). 로그인·끈 목록·다른 회사는 지금 값으로 다시 판정한다. */
export function statusNotes(view, ws, slug) {
  const out = [];
  if (view?.unsealed) out.push('unsealed');
  const { mine, waiting } = assistantRole(view, ws, slug);
  if (waiting) out.push('other_company');
  if (!mine) return out;
  const s = view.status ?? {};
  if (!s.login) out.push('login_required');
  if (s.muted) out.push('muted');
  if (s.runner === 'runner_outdated') out.push('runner_outdated');
  if (s.runner === 'this_device' && ['calendar_error', 'deliver_failed', 'personal_room_unavailable'].includes(s.code)) out.push(s.code);
  return out;
}
