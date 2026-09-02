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
  // 숨김 러너(gemini)만 연결된 회사는 "가용 없음" — 배너·명판·턴 오류가 한목소리(분리 검수 HIGH-1: 셋이 서로 다른 말을 했다)
  return Object.values(runners ?? {}).some((r) => r.company?.connected && !r.company?.invalid && !r.hidden);
}

/** 연결된 것이 숨김 러너뿐인가 — "Gemini는 더 이상 제공되지 않습니다 — 다른 러너를 연결해 주세요" 분기용 */
export function onlyHiddenConnected(runners) {
  const on = Object.values(runners ?? {}).filter((r) => r.company?.connected && !r.company?.invalid);
  return on.length > 0 && on.every((r) => r.hidden);
}

/** 저장 자격이 있는데 무효(재연결 필요)인 러너가 있는가 — "미연결"과 "끊김" 안내 문구 분기용. */
export function runnerNeedsReconnect(runners) {
  return Object.values(runners ?? {}).some((r) => r.company?.connected && r.company?.invalid);
}

/** 서버 자동 선택(pickRunner = RUNNER_AUTH 정의 순) 순서 — "자동" 표시가 실제 실행 러너와 어긋나지 않게.
    카탈로그(/api/runners = RUNNERS 순)는 kimi·glm 순서가 달라 첫 authed를 그냥 집으면 오표시가 난다. */
export const PICK_ORDER = ['claude', 'codex', 'glm', 'kimi', 'openrouter', 'grok', 'antigravity']; // gemini 숨김(2026-09-03) — 자동 선택 대상 아님

/** 연결(유효)된 러너의 표시 이름 목록 — 명판 '엔진' 표기의 단일 진실.
    'Claude Agent SDK' 하드코딩이 Gemini만 연결한 사용자에게 "클로드로 떠 있다" 혼란을 준
    실사고(2026-07-20)의 교체재. 이름은 서버 runnerStatus가 실어 준다(name 필드). */
export function usableRunnerNames(runners) {
  return Object.entries(runners ?? {})
    .filter(([, r]) => r.company?.connected && !r.company?.invalid && !r.hidden) // 숨김 러너(gemini)는 명판에 안 세운다
    .sort(([a], [b]) => PICK_ORDER.indexOf(a) - PICK_ORDER.indexOf(b))
    .map(([id, r]) => r.name || id);
}


/** 활동 이벤트 → 러너별 최신 턴 상태(P1-1, 순수). events는 최신순(readEvents 계약).
    중단 판정은 aborted **필드** 우선 + 레거시 문자열 폴백 — 문자열 동등 비교 단독은 이벤트 문구
    다국어화에 fail-open이다(검수 관점3·5, thread aborted 필드 선례). */
export function lastTurnByRunner(events) {
  const by = {};
  for (const e of events ?? []) {
    if (e?.type !== 'turn' || !e.runner || (e.runner in by)) continue;
    by[e.runner] = { ok: e.ok !== false, aborted: e.aborted === true || e.error === '사장 지시로 중단' };
  }
  return by;
}

/** 활동 이벤트 → 러너별 최신 검진 실패(P1-2 주기 검진, 순수). 턴 실패(lastTurnByRunner)와 **별개
    소스**다: 턴은 "쓰다 실패했다", 검진은 "지금 자격이 죽어 있다". 성공 검진은 이벤트로 남지 않으므로
    (실패만 기록) 여기 없다는 것이 곧 "최근 확정 실패 없음"이다. */
export function lastHealthFailByRunner(events) {
  const by = {};
  for (const e of events ?? []) {
    if (e?.type !== 'runner-health' || !e.runner || (e.runner in by)) continue;
    by[e.runner] = { ok: e.ok !== false ? true : false, reason: e.reason ?? null };
  }
  return by;
}

/** 검진 실패 사유 → i18n 키(순수). 설정 카드와 활동 화면이 **같은 함수**를 쓴다 — 매핑이 두 곳에
    복제되면 한쪽만 고쳐져 크레딧 소진에 "Gemini 라이선스" 문구가 뜬다(#380 검수: 매핑 뒤바꾸기
    변이가 전 스위트 초록이었다 — 커버리지 0이던 자리). */
export function healthFailMessageKey(reason) {
  if (reason === 'gemini-license') return 'settings.runners.geminiLicenseBlocked';
  if (reason === 'credit' || reason === 'tier') return 'settings.runners.checkCreditTier';
  return 'settings.runners.healthFailed';
}
