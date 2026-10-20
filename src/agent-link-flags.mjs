// 메신저 v2 연결 플래그 — 의존성 없는 파일이다. 게이트웨이·기기 세션은 이 파일만 정적으로 부르고, 연결부(agent-link-host.mjs)와
// 부품(packages/agent-link)은 플래그가 켜졌을 때만 동적으로 부른다.
// 0.1.115부터 기본값: 새 연결 켬·회의방 켬·옛 브리지 끔(공개 계획서 S4, 유건 승인 2026-10-20). 0.1.114 동작으로 돌리려면
// ARGO_AGENT_LINK=0 + ARGO_MSGR_LEGACY=on. 원격 끄기는 서버 스위치(msgr_settings 'msgr2_paused')로 한다 — 앱을 다시 발행하지 않는다.
const val = (v) => String(v ?? '').trim().toLowerCase();
const OFF = new Set(['0', 'off', 'false', 'no']);
const ON = new Set(['1', 'on', 'true', 'yes']);
/** 새 연결(agent-link): 기본 켬. ARGO_AGENT_LINK가 0·off·false·no면 끈다. */
export const agentLinkEnabled = (env = process.env) => !OFF.has(val(env.ARGO_AGENT_LINK));
/** 옛 메신저 브리지: 기본 끔. ARGO_MSGR_LEGACY가 1·on·true·yes일 때만 켠다. */
export const legacyMsgrBridgeEnabled = (env = process.env) => ON.has(val(env.ARGO_MSGR_LEGACY));
/** 메신저 v2 회의방·외부 봇 경로(A+): 새 연결이 켜져 있으면 기본 켬. ARGO_MSGR_MEETING이 0·off·false·no면 끈다(그때는 회의방 일도 1:1 경로).
    서버는 본체가 알린 기능(features)의 offer만 만든다 — 서버 스위치가 회의방을 열기 전에는 회의방 일이 오지 않는다. */
export const msgrMeetingEnabled = (env = process.env) => agentLinkEnabled(env) && !OFF.has(val(env.ARGO_MSGR_MEETING));
