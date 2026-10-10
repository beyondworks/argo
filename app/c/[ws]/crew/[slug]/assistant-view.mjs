// 하트비트(코드 이름 assistant) 표시 판정(순수) — 에이전트 카드 하트비트 탭(보기 전용, assistant-section.jsx)·루틴 화면 하트비트 칸(관리, routines/heartbeat-card.jsx)과
// 테스트가 같이 쓴다. 입력은 설정 API 보기(src/assistant/settings.mjs assistantSettingsView).

/** 시각 선택지 — 30분 간격 48개. 저장값이 칸 밖(손으로 고친 08:15 등)이면 그 값도 넣어 선택이 사라지지 않게 한다. */
export const HALF_HOURS = Object.freeze(Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`));
export const timeChoices = (cur) => (!cur || HALF_HOURS.includes(cur) ? HALF_HOURS : [...HALF_HOURS, cur].sort());
/** 숫자 선택지 — 저장값이 목록 밖(새 버전이 저장한 값)이면 그 값도 넣는다. */
export const numChoices = (list, cur) => (cur == null || list.includes(cur) ? list : [...list, cur].sort((a, b) => a - b));

/** 이 에이전트 카드에서 본 하트비트.
    mine = 이 에이전트가 지금 하트비트(엔진이 돌리는 쪽), other = 다른 하트비트(같은 회사의 다른 에이전트 또는 다른 회사), waiting = 이 회사 설정은 이 에이전트로
    켜져 있지만 다른 회사의 하트비트가 맡고 있다(켠 시각이 더 늦은 쪽이 맡는다 — 두 기기에서 거의 같은 때 켠 경우). */
export function assistantRole(view, ws, slug) {
  const cur = view?.current ?? null;
  const mine = !!cur && cur.ws === ws && cur.agent === slug;
  return { mine, other: cur && !mine ? cur : null, waiting: !mine && !!view?.config?.enabled && view.config.agent === slug };
}

/** 이 회사에서 본 하트비트 상태 — 루틴 화면 하트비트 칸이 무엇을 그릴지.
    'on'     — 지금 하트비트(계정마다 하나)가 이 회사다 → 관리(일시 정지·끄기·값 바꾸기).
    'other'  — 지금 하트비트가 다른 회사다(이 회사가 꺼짐·일시 정지·두 기기 경쟁으로 밀림이어도) → 그 사실 + 이 회사에서 만들기(만들면 그쪽은 꺼짐).
    'paused' — 이 회사 설정이 봉인된 꺼짐이고 담당 에이전트가 적혀 있다(일시 정지 — 설정이 남아 있다. 옛 버전의 '하트비트 끄기'도 여기).
    'none'   — 그 밖(파일 없음·끄기로 지움·다른 회사로 옮기며 꺼짐·봉인이 안 맞음) → 만들기. */
export function heartbeatState(view, ws) {
  const cur = view?.current ?? null;
  if (cur) return cur.ws === ws ? 'on' : 'other';
  const c = view?.config;
  return c && !c.enabled && c.agent ? 'paused' : 'none';
}

/** 문제 줄 — 상태 코드 목록(화면이 사전 assistant.st.<code>로 그린다). 순서 = 보여 줄 순서.
    엔진 상태 파일의 코드(calendar_error 등)는 이 기기가 실행 기기일 때만 의미가 있다(상태 파일은 기기 로컬). 로그인·끈 목록·다른 회사는 지금 값으로 다시 판정한다.
    로그인은 이 기기의 기기 세션으로 판정하므로 이 기기가 실행 기기이거나 실행 중인 기기가 없을 때만 보인다 — 다른 기기·옛 버전 기기가 실행 중이면 그 기기의 로그인은 여기서 알 수 없다.
    slug를 주면 그 에이전트 카드 기준(카드 탭), null이면 회사 기준(루틴 화면 — 이 회사의 지금 하트비트). */
export function statusNotes(view, ws, slug = null) {
  const out = [];
  if (view?.unsealed) out.push('unsealed');
  const c = view?.config;
  const cur = view?.current ?? null;
  const mine = slug == null ? !!cur && cur.ws === ws : assistantRole(view, ws, slug).mine;
  const waiting = !mine && !!c?.enabled && !!c.agent && (slug == null || c.agent === slug);
  if (waiting) out.push('other_company');
  if (!mine) return out;
  const s = view.status ?? {};
  if (!s.login && (s.runner === 'this_device' || s.runner === 'no_runner')) out.push('login_required');
  if (s.muted) out.push('muted');
  if (s.runner === 'runner_outdated') out.push('runner_outdated');
  if (s.runner === 'this_device' && ['calendar_error', 'deliver_failed', 'personal_room_unavailable'].includes(s.code)) out.push(s.code);
  return out;
}

const MAIL_CODES = new Set(['login_required', 'mail_no_origin', 'office_outdated', 'mail_rate_limited', 'mail_expired', 'mail_error', 'no_mail_account', 'deliver_failed', 'personal_room_unavailable']);

/** 상태 칸 문장(순수) — 카드 탭과 루틴 화면이 같은 문장을 쓴다. t = 사전, fmt(ms) = 시각 표기.
    반환 { here, runner, lastCheck, today, mail(메일을 볼 때만, 아니면 null) }. */
export function statusTexts(view, { t, fmt }) {
  const s = view?.status ?? {};
  const c = view?.config ?? {};
  const here = s.runner === 'this_device';
  const runner = here ? (s.device ? t('assistant.runnerHere', { device: s.device }) : t('assistant.runnerHereBare'))
    : s.runner === 'other_device' ? t('assistant.runnerOther', { device: s.device || '—' })
      : s.runner === 'runner_outdated' ? t('assistant.runnerOld', { device: s.device || '—' })
        : t('assistant.runnerNone');
  const n = s.instantToday ?? 0;
  const today = !here ? t('assistant.onRunner')
    : s.instantSure === false ? t('assistant.todayUnsure', { n }) // 다른 기기가 보낸 수를 아직 모름(방에서 복구 실패)
      : n > s.dailyCap ? t('assistant.todayOver', { n, cap: s.dailyCap }) : t('assistant.todayUnder', { n, cap: s.dailyCap });
  const lastCheck = !here ? t('assistant.onRunner') : s.readAt ? fmt(s.readAt) : t('assistant.lastCheckNone');
  // 메일 확인 상태 — 마지막 확인 시각, 미리 보기면 기록한 수, 문제가 있으면 그 문장(src/assistant/mail.mjs mailStatusView)
  let mail = null;
  if (c.mail && c.mail !== 'off') {
    const ms = s.mail;
    mail = !here ? t('assistant.onRunner')
      : !ms?.checkedAt && !ms?.code ? t('assistant.lastCheckNone')
        : [ms.checkedAt ? fmt(ms.checkedAt) : null,
          c.mail === 'shadow' ? t('assistant.mailShadow', { days: ms.shadow?.days ?? 0, n: ms.shadow?.total ?? 0 }) : null,
          ms.code && ms.code !== 'ok' ? t(`assistant.mailSt.${MAIL_CODES.has(ms.code) ? ms.code : 'mail_error'}`) : null].filter(Boolean).join(' · ');
  }
  return { here, runner, lastCheck, today, mail };
}
