// 로컬 능력 — **설치 시점부터 전권**이다. 토글은 없다(유건 지시 2026-07-30).
//
// 왜 없앴나: 실사용 신고 최다 클러스터가 "권한 때문에 막힌다"였다(QA 41건 중 11건, 제보자 7명 —
// docs/qa-feedback-backlog-2026-07-27.md P0-1). 능력을 꺼두고 사장이 하나씩 켜게 하는 모델은
// "프롬프트 한 줄로 AI 직원에게 일을 시킨다"는 목적지와 정면으로 부딪혔다 — 크루가 일을 못 하는 게
// 기본값이었다.
//
// Hermes Agent의 YOLO 설계를 이식했다(~/.hermes/hermes-agent/tools/approval.py 실측):
//   ① **하드라인이 전권보다 먼저 판정된다.** Hermes 주석 그대로 — "yolo를 켠다는 건 파일과 서비스를
//      맡긴다는 뜻이지, 디스크를 밀거나 전원을 내려도 된다는 뜻이 아니다"(approval.py:1400 부근,
//      하드라인 검사가 yolo 분기보다 위에 있다). Argo의 하드라인은 permission-gate.mjs의 금지 구역
//      (앱 코드·타사 데이터·회사 금고·벤더 자격)이고, 전권과 무관하게 먼저 걸린다.
//   ② **전권 플래그는 상수라 프로세스 안에서 바꿀 수 없다.** Hermes는 YOLO를 import 시점에 동결하며
//      이유를 이렇게 적었다 — "매 호출마다 env를 읽으면 프로세스 안에서 도는 스킬이 그 변수를 세팅해
//      즉시 모든 검사를 우회할 수 있다(프롬프트 인젝션 승격 경로)". Argo는 정확히 그 사고를 겪었다:
//      능력이 전부 꺼진 크루가 capabilities.json에 {"bypass":true}를 써넣자 **다음 턴에** 셸을 획득했다
//      (2026-07-27 격리 재현). 파일에서 읽지 않는 상수로 만들면 그 승격 경로 자체가 사라진다.
//
// 그래서 이 파일은 값을 읽지 않는다. 켜고 끄는 API도 없다 — 없는 스위치는 조작될 수 없다.
export const CAPABILITIES = Object.freeze({ fs: true, browser: true, shell: true, bypass: true });

/** 능력 조회 — 항상 전권. 인자는 받지 않는다(값이 회사별로 갈리지 않는다).
    async 유지: chat.mjs·permission-gate.mjs가 await로 부르고, 호출부를 바꾸지 않기 위해서다. */
export async function loadCapabilities() {
  return CAPABILITIES;
}
