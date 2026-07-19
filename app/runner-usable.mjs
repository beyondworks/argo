// 러너 가용 판정(순수) — runner-connect.jsx(온보딩 게이트·데크 배너·홈 안내)가 쓰고,
// node 테스트가 직접 임포트할 수 있도록 JSX 없는 모듈로 분리(test/runner-gate.test.mjs).

/** 러너 상태 dict(runnerStatus 응답)에서 쓸 수 있는 러너가 하나라도 있는가.
    판정 = 자격 연결(유효) 또는 호스트 로그인. hostInstalled는 요구하지 않는다(유건 지시 2026-07-19) —
    ① OAuth 웹 브리지는 CLI 없이 자격을 만들 수 있고 ② GUI 기동 PATH 문제로 설치 감지가 오탐될 수 있어
    (실사용 신고: codex·gemini 연결됨인데 회사 만들기 비활성) 설치 여부로 입구를 막지 않는다.
    정말 CLI가 없는 잔여 케이스는 첫 턴의 credButNoCli 안내(resolveRunner)가 정확히 받는다.
    (이전 이력: Claude만 보던 판정 → 2026-07-18 전 러너 판정 → 2026-07-19 hostInstalled 요구 제거) */
export function anyRunnerUsable(runners) {
  return Object.values(runners ?? {}).some((r) => r.hostAuthed || (r.company?.connected && !r.company?.invalid));
}

/** 저장 자격이 있는데 무효(재연결 필요)인 러너가 있는가 — "미연결"과 "끊김" 안내 문구 분기용. */
export function runnerNeedsReconnect(runners) {
  return Object.values(runners ?? {}).some((r) => r.company?.connected && r.company?.invalid);
}
