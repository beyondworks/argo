// 활동 화면 '다시 실행' 판정 — JSX 없는 순수 함수(node --test가 직접 import해 검증한다).
// F5(2026-10-05): '다시 실행'이 메신저(손님 포함) 턴을 사장 직접 턴으로 데스크톱 1:1에서 다시 돌렸다 — 손님 요청이 사장 권한
// (풀 오토 등)으로 승격되고, 답도 메신저가 아니라 데스크톱 대화에 붙었다. 사장이 직접 시킨 턴만 그 자리에서 다시 돌린다.

const OWNER_SOURCES = new Set(['deck', 'routine', 'trial', 'room', 'compete']); // 사장이 직접 시킨 턴(데크 1:1·루틴·시운전·회의실·경쟁 시안)

/** 'rerun' = 버튼을 보인다 · 'messenger' = 숨기고 "메신저에서 다시 보내 주세요" · 'none' = 숨긴다(다른 크루가 건 턴 등). */
export function rerunMode(e) {
  if (e?.type !== 'turn' || !e.msg) return 'none';
  const src = e.source ?? 'deck'; // 옛 이벤트(source 없음)는 데크 턴 기본값과 같다(chat.mjs)
  if (src === 'messenger') return 'messenger';
  if (e.from) return 'none'; // 다른 크루가 건 턴(위임·쪽지·세션 메시지) — 사장 직접 턴으로 승격하지 않는다
  if (src === 'crewmail') return e.fromRole === 'captain' ? 'rerun' : 'none'; // 사장이 보낸 쪽지만
  return OWNER_SOURCES.has(src) ? 'rerun' : 'none';
}
