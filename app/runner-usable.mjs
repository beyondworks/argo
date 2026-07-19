// 러너 가용 판정(순수) — runner-connect.jsx(온보딩 게이트·데크 배너·홈 안내)가 쓰고,
// node 테스트가 직접 임포트할 수 있도록 JSX 없는 모듈로 분리(test/runner-gate.test.mjs).

/** 러너 상태 dict(runnerStatus 응답)에서 쓸 수 있는 러너가 하나라도 있는가.
    판정 = **사장이 명시적으로 연결한 자격(유효)뿐** — 호스트 로그인 감지(hostAuthed)는 가용이 아니다
    (유건 지시 2026-07-19: 러너를 억지로 찾아 자동 연결하지 않는다. 감지는 "이 컴퓨터 로그인 사용"
    옵트인 안내로만 쓰고, 옵트인하면 host 타입 자격으로 connected에 잡힌다. 실사용: 새 기기에서
    호스트 Claude 흔적이 '연결중'으로 오표시 → 회사 생성 통과 → 키체인 접근 불가로 전 기능 사망).
    hostInstalled도 요구하지 않는다 — CLI 미설치 잔여는 첫 턴 credButNoCli 안내가 받는다.
    (이력: Claude만 판정 → 07-18 전 러너 → 07-19 hostInstalled 제거 → 07-19 명시 연결 정본화) */
export function anyRunnerUsable(runners) {
  return Object.values(runners ?? {}).some((r) => r.company?.connected && !r.company?.invalid);
}

/** 저장 자격이 있는데 무효(재연결 필요)인 러너가 있는가 — "미연결"과 "끊김" 안내 문구 분기용. */
export function runnerNeedsReconnect(runners) {
  return Object.values(runners ?? {}).some((r) => r.company?.connected && r.company?.invalid);
}
