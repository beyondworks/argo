// 설정 '메신저 연결' 카드 표시 규칙 — JSX 없는 순수 함수(CX-12, 2026-10-05).
// 개인 공간(2026-09-30 유건) 이후 조직 없이도 내 크루가 메신저 개인 공간에 연결된다. 그런데 카드는 조직 등록만 세어 조직이 없으면
// '연결 필요' + '조직을 만들거나 초대받으세요'를 보이고 연결 상태(실행기)를 숨겼다.

export const MESSENGER_PAGE = 'https://argo.ceo/messenger'; // 맥·윈도우·iOS·Android 받기 안내(앱 스토어 포함) 한 곳
export const OFFICE_URL = 'https://argo-office.vercel.app'; // 아르고 오피스(웹) — 설치를 전제하지 않는다(CX-13)

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
export function msgrCardView({ st, orgId = '', agents = [] } = {}) {
  const crews = Array.isArray(st?.crews) ? st.crews : [];
  const regCount = agents.filter((a) => crews.some((r) => r.org_id === orgId && r.slug === a.slug && r.status === 'active')).length;
  const personalCount = st?.personalCount ?? 0;
  return {
    regCount, personalCount,
    chip: msgrConnectionChip({ regCount, personalCount }),
    showRuntime: msgrShowRuntime({ signedIn: st?.signedIn, agentCount: agents.length }),
    polling: !!st?.signedIn && crews.some((r) => r.status === 'active'),
  };
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
