// 메신저 v2 연결 플래그 — 의존성 없는 파일이다. 게이트웨이·기기 세션은 이 파일만 정적으로 부르고, 연결부(agent-link-host.mjs)와
// 부품(packages/agent-link)은 플래그가 켜졌을 때만 동적으로 부른다: 기본(꺼짐) 경로는 새 코드를 한 줄도 읽지 않는다.
/** 새 연결(agent-link): ARGO_AGENT_LINK가 정확히 1일 때만 켠다(기본 꺼짐). */
export const agentLinkEnabled = (env = process.env) => String(env.ARGO_AGENT_LINK ?? '').trim() === '1';
/** 옛 메신저 브리지: ARGO_MSGR_LEGACY가 off일 때만 끈다(기본 켜짐 — 지금 배포본과 같다). */
export const legacyMsgrBridgeEnabled = (env = process.env) => String(env.ARGO_MSGR_LEGACY ?? '').trim().toLowerCase() !== 'off';
