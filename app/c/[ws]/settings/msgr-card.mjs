// 설정 '메신저 연결' 카드 표시 규칙 — JSX 없는 순수 함수(CX-12, 2026-10-05).
// 개인 공간(2026-09-30 유건) 이후 조직 없이도 내 크루가 메신저 개인 공간에 연결된다. 그런데 카드는 조직 등록만 세어 조직이 없으면
// '연결 필요' + '조직을 만들거나 초대받으세요'를 보이고 연결 상태(실행기)를 숨겼다.

export const MESSENGER_PAGE = 'https://argo.ceo/messenger'; // 맥·윈도우·iOS·Android 받기 안내(앱 스토어 포함) 한 곳
export const MESSENGER_WAITLIST = 'https://argo.ceo/messenger#waitlist'; // 메신저 중단 중(랜딩 '출시 예정', #1053) — 받기 대신 출시 알림 신청

/** '메신저 받기' 단추(0.1.113) — 서버 중단 스위치(msgr_service_pause)가 켜져 있으면 받을 수 있는 앱이 없으므로 '출시 알림 받기'로 바꾸고 랜딩 신청란으로 보낸다.
    paused = GET /api/companies/[ws]/msgr-archive 응답의 paused(이관 확인 때 함께 읽은 값 — 새 주기 호출 없음). 모르면(로드 전·옛 서버·오류) 꺼짐과 같다(지금 단추 그대로). */
/** 메신저가 쉬는 동안(서버 중단 스위치 켜짐) 설정 › 연결 화면의 세 칸 문구(0.1.113, 유건 캡처 2026-10-16) — 꺼짐·모름이면 null·종전 키(지금과 똑같이).
    descKey = 'Argo 메신저 연결' 카드 설명(쓸 수 있다고 읽히는 안내 대신 쉬는 중) · showHelp = 조직·연결 안내 문단과 '팀과 함께 쓰려면 조직을…' 줄을 보일까
    runtimeKey = 응답 상태 문구를 바꿀 키(null이면 종전 판정 — 쉬는 동안 브리지는 30분에 한 번만 확인해 '응답 없음·자동 복구'가 고장처럼 보였다) · runtimeButton = 다시 연결·다시 확인 단추를 보일까
    notifyNoteKey = '알림 받을 메신저' 칸 아래 안내(저장된 체크 값은 바꾸지 않는다) · chipKey = 머리 칩을 '쉬는 중'(회색)으로 바꿀 키(null이면 종전 연결됨·개인 공간·연결 필요). paused = GET msgr-archive 응답의 paused(이관 확인 때 읽은 값 — 새 호출 없음). */
export function msgrPausedView(paused) {
  const on = paused === true;
  return {
    descKey: on ? 'settings.msgr.pausedHelp' : 'settings.msgr.downloadHelp',
    showHelp: !on,
    runtimeKey: on ? 'settings.msgr.runtime.paused' : null,
    runtimeButton: !on,
    notifyNoteKey: on ? 'settings.notify.msgrPaused' : null,
    chipKey: on ? 'settings.msgr.connection.paused' : null,
  };
}

export function msgrGetLink(paused) {
  return paused === true ? { href: MESSENGER_WAITLIST, labelKey: 'settings.msgr.getWaitlist' } : { href: MESSENGER_PAGE, labelKey: 'settings.msgr.get' };
}

/** 머리 칩 — 'connected'(조직에 등록됨) · 'personal'(조직은 없지만 개인 공간에 연결됨) · 'notConnected' */
export function msgrConnectionChip({ regCount = 0, personalCount = 0 } = {}) {
  if (regCount > 0) return 'connected';
  if (personalCount > 0) return 'personal';
  return 'notConnected';
}

/** 실행기 상태 영역을 보일까 — 조직 여부와 상관없이 로그인했고 크루가 있으면(개인 공간도 실행기가 답한다). */
export function msgrShowRuntime({ signedIn = false, agentCount = 0 } = {}) {
  return !!signedIn && agentCount > 0;
}

/** 서버 응답(GET /api/companies/[ws]/msgr)을 카드가 읽는 판정 한 곳 — st = 응답 JSON({ signedIn, orgs, crews, personalCount, runtime }) 또는 null(로드 전).
    regCount = 선택한 조직(orgId)에 활성 등록된 크루 수 · polling = 8초 실행기 상태 폴이 도는가(로그인했고 활성 조직 크루가 하나라도 있을 때 — 개인 공간만 쓰는 사용자는 안 돈다).
    폴 조건과 "자동으로 다시 확인" 문구가 같은 판정을 쓴다(UL7). */
export function msgrCardView({ st, orgId = '', agents = [], soonSince = null, now = Date.now() } = {}) {
  const crews = Array.isArray(st?.crews) ? st.crews : [];
  const regCount = agents.filter((a) => crews.some((r) => r.org_id === orgId && r.slug === a.slug && r.status === 'active')).length;
  const personalCount = st?.personalCount ?? 0;
  // 곧 연결 상한(D3 검수 미룸, D4와 함께 2026-10-15): 처음 본 뒤 SOON_CAP_MS가 지나도 그대로면(첫 심박이 안 옴) 종전 문구로 돌아가고 폴도 멈춘다 — 8초 GET 최대 15회.
  //   soonSince = 화면이 곧 연결을 처음 본 시각(MsgrCard 상태). 넘기지 않으면(옛 호출) 상한 없이 종전 판정.
  const soon = pauseSoon(st) && (soonSince == null || now - soonSince < SOON_CAP_MS);
  return {
    regCount, personalCount, soon,
    chip: msgrConnectionChip({ regCount, personalCount }),
    showRuntime: msgrShowRuntime({ signedIn: st?.signedIn, agentCount: agents.length }),
    // 곧 연결 상태(D3)도 폴한다 — 첫 심박으로 풀리는 순간(보통 몇 초)을 카드가 본다. 풀리면 active 행이 생겨 종전 폴로 이어진다(같은 8초 주기)
    polling: !!st?.signedIn && (crews.some((r) => r.status === 'active') || soon),
  };
}

export const SOON_CAP_MS = 120_000;

/** 탭으로 돌아왔을 때 연결 카드를 다시 읽을까(앱↔메신저 연결 감사 D4, 2026-10-15) — 메신저에서 조직을 만들거나 로그인하고 돌아와도 카드가 옛 판정
    ('다른 계정으로 로그인'만)을 보였다. 보이는 탭에서만, focus·visibilitychange가 같이 튀므로 gapMs(5초) 안 중복은 접는다(SyncCard 결제 재조회와 같은 접기).
    부하: 설정 화면을 연 기기 1대 × 탭 복귀 횟수만큼 GET(주기 호출 0). */
export function tabReturnDue({ visible, now, last, gapMs = 5000 }) {
  return !!visible && now - last >= gapMs;
}

/** 이 기기가 곧 연결되는 중인가(앱↔메신저 연결 감사 D3, 2026-10-15) — 무료 계정 첫 연결은 첫 기기 심박 전이라 서버 이유가 app·off인데, 이 앱이 바로 그 최신 앱이다.
    이 회사 브리지가 응답 중(runtime alive)이고 이 앱이 서버 최소 버전 이상(GET pauseAppOk)이면 참 — 업데이트 안내 대신 "곧 연결됩니다".
    개발 빌드(최소 버전 미만)·브리지 응답 없음·옛 응답(pauseAppOk 없음)·limit·room은 거짓(종전 문구). */
export function pauseSoon(st) {
  return !!st?.signedIn && st?.pauseAppOk === true && st?.runtime?.state === 'alive' && (st?.pauseReason === 'app' || st?.pauseReason === 'off');
}

/** 무료 계정 한도로 서버가 멈춘 행(status paused)의 줄 문구 — 사람이 해제한 '파견 해제됨'과 구별한다(화면 검수 B, 2026-10-11).
    reason = GET 응답 pauseReason(서버 msgr_my_agent_pause의 이유): limit 4명 한도 · app/off 최신 앱이 켜져 있지 않음 · room 새 앱 켜짐 + 자리 남음(지금 연결할 수 있음)
    · 그 밖(모름·Pro로 바뀌는 중) 멈춤만. soon = pauseSoon(st) — 이 기기(최신 앱)가 응답 중이면 app·off를 "곧 연결됩니다"로(D3) */
export function pausedLabelKey(reason, { soon = false } = {}) {
  if (reason === 'limit') return 'settings.msgr.paused.limit';
  if (reason === 'app' || reason === 'off') return soon ? 'settings.msgr.paused.soon' : 'settings.msgr.paused.app';
  if (reason === 'room') return 'settings.msgr.paused.room';
  return 'settings.msgr.paused';
}

/** 조직이 없는(개인 공간만 쓰는) 사용자의 개인 공간 줄(검수 스택 화면 4차, 2026-10-11) — 무료 4명 한도로 멈춘 다섯 번째를 켤 곳이 없었다.
    rows = 에이전트마다 개인 행 상태 문구 키(연결 'settings.msgr.connection.personal' · 멈춤 pausedLabelKey · 해제 notRegistered · 행 없음 notInMessenger),
    missing = 연결할 것(멈춘 개인 행만 — 메신저에서 사람이 해제한 available은 묶지 않는다, 재검수 LOW-1), show = 조직이 없고 멈춘 개인 행이 있고 무료 한도 이유가 있을 때만
    (pauseReason이 없으면 Pro·관문 꺼짐 — 종전 카드 그대로, 재검수 LOW-2). */
export function personalCardView({ st, agents = [], soon = pauseSoon(st) } = {}) { // soon — 화면이 상한(SOON_CAP_MS)을 적용한 판정(msgrCardView.soon)을 넘긴다
  const rowsAll = Array.isArray(st?.personal) ? st.personal : [];
  const rows = agents.map((a) => {
    const row = rowsAll.find((r) => r.slug === a.slug) ?? null;
    const labelKey = !row ? 'settings.msgr.notInMessenger' : row.status === 'active' ? 'settings.msgr.connection.personal'
      : row.status === 'paused' ? pausedLabelKey(st?.pauseReason, { soon }) : 'settings.msgr.notRegistered';
    return { slug: a.slug, row, labelKey };
  });
  const missing = rows.filter((r) => r.row?.status === 'paused').map((r) => r.slug);
  return { rows, missing, connected: rows.filter((r) => r.row?.status === 'active').length, show: !!st?.signedIn && !st?.orgs?.length && missing.length > 0 && !!st?.pauseReason };
}

/** 첫 응답 대기 문구 — 폴이 도는 때만 "자동으로 다시 확인"을 말한다. 안 돌면 사용자가 '다시 확인'을 누르라고 한다(폴을 늘리지 않는다 — DB·서버 부하). */
export function runtimeWaitingKey(polling) {
  return polling ? 'settings.msgr.runtime.waiting' : 'settings.msgr.runtime.waitingManual';
}

/** 실행기 상태 영역의 단추 하나(2차 L6) — 문구가 시키는 행동과 단추를 맞춘다. 'login'(로그인 링크) | 'reconnect'(다시 연결) | 'recheck'(다시 확인) | null.
    offline·company는 문구가 "다시 연결"을 시키므로 다시 연결 하나, login은 로그인, 그 밖은 8초 폴이 안 돌 때만 다시 확인(폴이 돌면 자동 확인이라 단추 없음), alive는 없음. */
export function runtimeAction(state, { polling }) {
  if (state === 'alive') return null;
  if (state === 'login') return 'login';
  if (state === 'offline' || state === 'company') return 'reconnect';
  return polling ? null : 'recheck';
}

/** 메신저에 에이전트가 하나도 없을 때(내 행 0개 — GET 응답 setup이 있을 때만) 이유 한 줄과 단추 하나(2026-10-13 사례: 카드는 '첫 응답을 기다리는 중'만 보였다).
    → { reason, action } | null. reason: 'owner'(이 회사를 만든 계정이 아님) · 'account'(이 계정으로 메신저에 로그인한 적 없음 — 메신저와 다른 계정)
    · 'pending'(계정은 맞고 이 기기의 실행기가 아직 에이전트를 메신저에 올리지 않음). action: 'login'(계정 바꾸기) | 'connect'(지금 연결).
    순서는 브리지 자동 켜기 조건(autoEnableMsgr)과 같다 — 소유자 → 조직 멤버이거나 메신저 프로필. 프로필을 못 읽었으면(null) 계정 문제로 단정하지 않는다. */
export function msgrSetupReason({ st } = {}) {
  const s = st?.signedIn ? st.setup : null;
  if (!s) return null;
  if (!s.owner) return { reason: 'owner', action: 'login' };
  if (!st.orgs?.length && s.profile === false) return { reason: 'account', action: 'login' };
  return { reason: 'pending', action: 'connect' };
}

/** 이유 상자가 있을 때도 실행기 상태를 보일까(#979 검수 2 MEDIUM-2) — 브리지가 이미 켜졌는데 막힌 경우(login·owner·company·offline·reconnecting)는
    실행기 상태 문구가 원인이다. 그것까지 숨기면 원인이 사라진다. 이유 상자가 없으면 종전대로(showRuntime이 정한다). 'waiting'(아직 아무 응답 없음)은 이유 상자가 대신 말한다. */
export function msgrRuntimeBesideSetup({ st, setupWhy } = {}) {
  if (!setupWhy) return true;
  const state = st?.runtime?.state;
  return !!st?.setup?.bridge && !!state && state !== 'waiting';
}
