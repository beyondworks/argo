// 크루 slug 예약어 — 크루 slug가 파일 이름이 되는 자리(chats/<slug>.json·chats/<slug>.status.json·agents/<slug>.md)에
// 회의실이 같은 규칙의 고정 이름을 쓴다: 회의록 chats/room-main.json, 턴 마커 슬러그 'room-main'(room.mjs).
// slugify('Room Main') = 'room-main'이 SLUG_RE를 통과하면 그 크루의 스레드가 회의록을, 상태 파일이 회의 마커를
// 덮는다(PR #393 분리 검수 LOW-6). 접두 'room-' 전체를 막아 앞으로의 회의실 내부 파일도 같은 문으로 지킨다.
// 의존 0 모듈 — persona(영입 문)·sync(반입 문)·테스트가 한 원천을 본다. 'room' 단독은 허용(회의실 핀 키는 '@room').
export const RESERVED_SLUG_RE = /^room-/;
export const isReservedSlug = (slug) => RESERVED_SLUG_RE.test(String(slug ?? ''));
