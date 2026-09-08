// 외부 에이전트 표기(순수) — 사용자는 "HTTP"가 아니라 **어떤 에이전트인지**를 본다(유건 2026-09-08: "헤르메스 에이전트 연결중" 같은 표기).
// 크루 카드 frontmatter `agent: hermes | openclaw | custom`(원클릭 연결이 채운다). 포맷은 agent에서 유추하므로 사용자가 `format:`을 알 필요가 없다.
// 이름은 고유명사라 언어별 한 벌(i18n 사전 대신 여기 — 러너 카탈로그 name과 같은 관례), 상태 문구는 app/i18n.jsx(agent.state.*).
export const EXTERNAL_AGENTS = {
  hermes: { ko: '헤르메스 에이전트', en: 'Hermes agent', format: 'openai-chat', defaultEndpoint: 'http://127.0.0.1:8642/v1/chat/completions' }, // 게이트웨이 API 서버 실물(2026-09-08)
  openclaw: { ko: '오픈클로 에이전트', en: 'OpenClaw agent', format: 'argo' }, // 진입점 미확인(N-4) — 확인 뒤 포맷 확정
  custom: { ko: '외부 에이전트', en: 'External agent', format: 'argo' },
};
export const isExternalAgentCard = (meta) => String(meta?.runner ?? '').trim() === 'http';
export const externalAgentKind = (meta) => { const k = String(meta?.agent ?? '').trim().toLowerCase(); return EXTERNAL_AGENTS[k] ? k : 'custom'; };
export const endpointHost = (endpoint) => { try { return new URL(String(endpoint ?? '').trim().replace(/^["']|["']$/g, '')).host; } catch { return ''; } };
/** "헤르메스 에이전트" / "외부 에이전트(127.0.0.1:9000)" — custom만 호스트를 덧붙인다(어느 엔드포인트인지 구분). */
export function externalAgentLabel(meta, lang = 'ko') {
  const kind = externalAgentKind(meta); const def = EXTERNAL_AGENTS[kind]; const name = lang === 'en' ? def.en : def.ko;
  const host = kind === 'custom' ? endpointHost(meta?.endpoint) : '';
  return host ? `${name}(${host})` : name;
}
/** 실행 포맷 — 카드가 명시하면 그것, 아니면 agent 기본, 그것도 없으면 'argo'. */
export const externalAgentFormat = (meta) => String(meta?.format ?? '').trim() || EXTERNAL_AGENTS[externalAgentKind(meta)].format;
