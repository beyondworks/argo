// 크루 slug 예약어 — 크루 slug가 파일 이름이 되는 자리(chats/<slug>.json·chats/<slug>.status.json·agents/<slug>.md)에
// 회의실이 같은 규칙의 고정 이름을 쓴다: 회의록 chats/room-main.json, 턴 마커 슬러그 'room-main'(room.mjs).
// slugify('Room Main') = 'room-main'이 SLUG_RE를 통과하면 그 크루의 스레드가 회의록을, 상태 파일이 회의 마커를
// 덮는다(PR #393 분리 검수 LOW-6). 의존 0 모듈 — persona(영입 문)·sync(반입 문)·테스트가 한 원천을 본다.
//
// 두 문의 범위는 다르다(분리 검수 MEDIUM-1):
//  - 영입 문(isReservedSlug): 접두 'room-' 전체 — 앞으로의 회의실 내부 파일도 같은 문으로 예방한다(새 크루만 막으니 넓어도 잃는 게 없다).
//  - 반입 문(collidesWithRoom): 실제 파일 이름 충돌만 — 이미 있는 'room-service' 같은 정상 크루의 동기화를 조용히 끊으면 안 된다.
//    thread/turn-status는 slug를 [a-z0-9-]로 깎아 파일명을 만들므로 같은 세척으로 비교한다('Zroom-main'.md → chats/room-main.json 별칭 침범, 검수 MEDIUM-2).
// 'room' 단독은 허용 — chats/의 고정 이름은 room-main.json 하나고, 회의 아카이브는 '_room-<ts>.json'(slug가 만들 수 없는 접두)이다.
export const RESERVED_SLUG_RE = /^room-/;
export const isReservedSlug = (slug) => RESERVED_SLUG_RE.test(String(slug ?? ''));
export const ROOM_FILE_SLUG = 'room-main';
/** slug → chats/ 파일 이름 세척. thread.mjs(<slug>.json)·turn-status.mjs(<slug>.status.json)·반입 문이 같은 함수를 쓴다 —
    한쪽만 바뀌면 반입 문이 다른 이름을 지키게 된다(검수 2R LOW-A: 규칙이 세 곳에 복제되면 목록이 반드시 뒤처진다). */
export const sanitizeFileSlug = (slug) => String(slug ?? '').replace(/[^a-z0-9-]/g, '');
export const collidesWithRoom = (slug) => sanitizeFileSlug(slug) === ROOM_FILE_SLUG;
