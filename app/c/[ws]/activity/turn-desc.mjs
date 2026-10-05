// 활동 화면 — 실패한 턴의 설명 줄. 사용자가 멈춘 턴은 저장된 원문(새 '사용자 지시로 중단', 옛 '사장 지시로 중단') 대신
// 화면 언어 문구를 보인다. 판정은 src/legacy-terms.mjs isAbortedTurnEvent(aborted 필드 먼저, 없던 옛 이벤트는 문자열) —
// runner-usable·failure-digest와 같은 술어라 세 곳이 어긋나지 않는다.
import { isAbortedTurnEvent } from '../../../../src/legacy-terms.mjs';

export const turnErrorDesc = (e, t) => (isAbortedTurnEvent(e) ? t('activity.aborted') : e.error);
