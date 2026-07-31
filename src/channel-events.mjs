// 채널이 보낼 수 있는 알림 종류 + 발송 판정 — **순수 모듈**(이 배치의 정본).
//
// 경위(실사용 신고 2026-07-31): 사용자가 루틴 프롬프트에서 텔레그램 지시를 지우고 크루에게도
// "보내지 말라"고 했는데 루틴 결과가 계속 텔레그램으로 갔다. 보내는 주체가 크루가 아니라 이 게이트웨이
// 계층이었고, 끌 수단이 연결 해제뿐이라 크루도 원인을 몰랐다. 그래서 '끈 목록'(mutedEvents)을 둔다 —
// '켤 목록'이 아니라 끈 목록인 이유는 부재·빈 값이 곧 현행 동작이라 기존 설정에 마이그레이션이 필요 없고,
// 종류가 늘어도 기본이 '보냄'으로 자동 정렬되기 때문이다.
//
// connections.mjs에 두면 안 되는 이유: 설정 화면(클라이언트 컴포넌트)이 이 목록을 체크박스로 그리는데,
// connections.mjs는 node:fs·node:crypto를 끌어 클라 번들이 통째로 깨진다(next build UnhandledSchemeError —
// 이 레포가 artifact-zones.mjs에서 이미 겪은 함정과 같은 계열). 화면과 저장 정규화가 **같은 목록**을
// 봐야 "화면에서 껐는데 저장이 안 되는" 갈림이 안 생기므로, 공유 지점을 순수 모듈로 내린다.
//
// 텔레그램은 5종 전부, 슬랙은 문안이 준비된 2종만 보낸다(gateway.mjs의 타입 게이트와 짝).
// 'inbox'는 알림 버스(onNotify)를 타지 않고 inbox 감시자가 직접 보내지만 **여기 있어야 한다**:
// 화면의 "이 채널로 보낼 알림"이 채널이 보내는 전부를 열거한다고 읽히기 때문이다. 빠뜨리면 사용자가
// 전부 끄고도 파일을 넣는 순간 알림을 받는다 — 원래 신고와 같은 모양의 불만이 된다(분리 검수 2026-07-31).
export const CHANNEL_EVENTS = Object.freeze({
  telegram: Object.freeze(['approval', 'routine', 'job', 'crewmail', 'inbox']),
  slack: Object.freeze(['approval', 'routine']),
});

/** 저장 정규화 — 목록 밖 값·중복·비배열을 걸러낸다(끈 목록이 쓰레기로 커지지 않게).
    정렬까지 하는 이유: 같은 선택이 클릭 순서에 따라 두 모양으로 저장되면 동기화 diff에 의미 없는
    변경이 남는다(routines.mjs의 같은 계열 정규화와 동일 관례). */
export const normalizeMuted = (kind, v) =>
  [...new Set((Array.isArray(v) ? v : []).filter((e) => CHANNEL_EVENTS[kind]?.includes(e)))].sort();

/** 이 채널로 이 종류를 보내는가 — **게이트웨이와 테스트가 같은 함수를 본다.**
    규칙을 각자 적으면 게이트웨이가 드리프트해도 테스트는 자기 사본을 재서 초록이고, 그때 재발하는 것이
    바로 이 기능이 고친 신고다. 목록에 적용한 "한 출처" 원칙을 규칙에도 그대로 적용한다. */
export const channelSends = (kind, ch, type) =>
  !!ch?.enabled && !!CHANNEL_EVENTS[kind]?.includes(type) && !(ch?.mutedEvents ?? []).includes(type);
