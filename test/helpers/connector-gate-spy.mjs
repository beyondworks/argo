// 커넥터 쓰기 게이트(src/connectors.mjs callConnectorTool)가 **받은 인자**를 기록하는 로드 훅 — 테스트 전용, 제품 코드는 바꾸지 않는다.
// 왜 필요한가: 게이트는 mirrorCtx로 손님·오피스·크루 넘김을 한 번 더 걸러서, 호출부(chat.mjs)가 그런 턴에 fullAuto=true를 넘겨도
// 결과(결재·발송)는 같다 — 결과만 보는 테스트로는 호출부의 판정 줄이 지워져도 초록이다(4차 검수: 변이 통과 255건).
// 그래서 호출부가 게이트에 넘긴 값 자체를 본다. 모듈 안의 함수 선언은 다시 대입할 수 있고 ESM 바인딩은 살아 있어,
// 끝에 감싸기 한 줄을 붙이면 chat.mjs·cli-directives.mjs가 가져간 callConnectorTool도 이 감싸기를 부른다.
// 사용법: register(new URL('./helpers/connector-gate-spy.mjs', import.meta.url)) 뒤 동적 임포트. 기록 = globalThis.__connectorGateCalls
// ([{ server, tool, opts }]). node --test는 파일별 자식 프로세스라 다른 테스트로 새지 않는다.
const SPY = `
;{ const __orig = callConnectorTool;
  callConnectorTool = async function (wsId, serverId, tool, args, opts) { (globalThis.__connectorGateCalls ??= []).push({ server: serverId, tool, opts: { ...(opts ?? {}) } }); return __orig.apply(this, arguments); }; }
`;

export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (!url.endsWith('/src/connectors.mjs') || r.source == null) return r;
  return { ...r, source: `${Buffer.from(r.source).toString('utf8')}\n${SPY}` };
}
