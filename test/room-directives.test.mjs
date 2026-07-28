// 회의실 라우팅 지시 파서 — 사장이 방을 떠나지 않고 to·cc·hop·loop를 거는 문법
// (유건 지시 2026-07-28: "회의실이 아니라 그룹채팅 개념").
//
// 이 파서가 틀리면 조용히 엉뚱한 크루가 답하거나(오배정) 지시가 통째로 무시된다(무증상 실패).
// 둘 다 화면만 봐선 구분이 안 되므로 경계를 여기서 못박는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomDirectives, HOP_MAX } from '../src/room.mjs';

const AGENTS = [
  { slug: 'beast', name: '비스트', role: '마케팅' },
  { slug: 'wolf', name: '울프', role: '영업' },
  { slug: 'shuri', name: '슈리', role: '개발' },
  { slug: 'edna', name: '에드나', role: '디자인' },
];
const slugs = (list) => list.map((a) => a.slug);

test('이름·슬러그 어느 쪽으로도 멘션이 풀린다', () => {
  const d = parseRoomDirectives('@비스트 @wolf 이번 주 매출 정리해줘', AGENTS);
  assert.deepEqual(slugs(d.to), ['beast', 'wolf']);
  assert.equal(d.cc.length, 0);
  assert.equal(d.relay.length, 0);
  assert.equal(d.loop, null);
});

test('멘션 뒤 문장부호는 이름의 일부가 아니다', () => {
  const d = parseRoomDirectives('@비스트, 확인 부탁해. @wolf!', AGENTS);
  assert.deepEqual(slugs(d.to), ['beast', 'wolf']);
  assert.deepEqual(d.unknown, []);
});

test('한글 자모 분리(NFD) 입력도 같은 크루로 풀린다', () => {
  const d = parseRoomDirectives('@비스트 보고'.normalize('NFD'), AGENTS);
  assert.deepEqual(slugs(d.to), ['beast']);
});

test('@all/@전체는 전원 호출로 표시된다', () => {
  assert.equal(parseRoomDirectives('@all 모여', AGENTS).allCall, true);
  assert.equal(parseRoomDirectives('@전체 모여', AGENTS).allCall, true);
});

test('cc는 발언자(to)에 섞이지 않는다', () => {
  const d = parseRoomDirectives('@슈리 배포 준비해줘 cc @비스트 @wolf', AGENTS);
  assert.deepEqual(slugs(d.to), ['shuri']);
  assert.deepEqual(slugs(d.cc), ['beast', 'wolf']);
});

test('한글 "참조"도 cc로 읽는다', () => {
  const d = parseRoomDirectives('@슈리 배포 준비 참조 @에드나', AGENTS);
  assert.deepEqual(slugs(d.to), ['shuri']);
  assert.deepEqual(slugs(d.cc), ['edna']);
});

test('hop 체인은 순서를 보존하고 to로 새지 않는다', () => {
  const d = parseRoomDirectives('@슈리 > @에드나 초안 만들고 디자인 붙여줘', AGENTS);
  assert.deepEqual(slugs(d.relay), ['shuri', 'edna']);
  assert.deepEqual(d.to, []);
});

test('hop 화살표는 >, →, -> 모두 받는다', () => {
  for (const arrow of ['>', '→', '->']) {
    const d = parseRoomDirectives(`@슈리 ${arrow} @울프 이어서`, AGENTS);
    assert.deepEqual(slugs(d.relay), ['shuri', 'wolf'], `arrow=${arrow}`);
  }
});

test('hop 체인은 연쇄 상한을 넘지 않는다', () => {
  const d = parseRoomDirectives('@슈리 > @에드나 > @비스트 > @울프 순서대로', AGENTS);
  assert.equal(d.relay.length, HOP_MAX + 1);
  assert.deepEqual(slugs(d.relay), ['shuri', 'edna', 'beast']);
});

test('loop는 문두에서만 지시로 읽는다', () => {
  const d = parseRoomDirectives('반복 30분 @비스트 지표 확인해줘', AGENTS);
  assert.deepEqual(d.loop, { everyMinutes: 30 });
  assert.deepEqual(slugs(d.to), ['beast']);
});

test('문장 중간의 "반복"은 낱말이지 지시가 아니다', () => {
  const d = parseRoomDirectives('@비스트 같은 실수가 반복 30분 넘게 이어졌어', AGENTS);
  assert.equal(d.loop, null);
  assert.deepEqual(slugs(d.to), ['beast']);
});

test('loop 단위 — 시간은 분으로 환산된다', () => {
  assert.deepEqual(parseRoomDirectives('loop 2시간 @wolf 점검', AGENTS).loop, { everyMinutes: 120 });
  assert.deepEqual(parseRoomDirectives('loop 2h @wolf check', AGENTS).loop, { everyMinutes: 120 });
  assert.deepEqual(parseRoomDirectives('loop 45m @wolf check', AGENTS).loop, { everyMinutes: 45 });
});

test('없는 크루 멘션은 unknown으로 드러난다 — 조용히 무시하지 않는다', () => {
  const d = parseRoomDirectives('@없는사람 보고해줘', AGENTS);
  assert.deepEqual(d.to, []);
  assert.deepEqual(d.unknown, ['없는사람']);
});

test('cc·hop·loop 동시 사용도 각자 제 자리로 간다', () => {
  const d = parseRoomDirectives('반복 60분 @슈리 > @에드나 릴리스 노트 cc @비스트', AGENTS);
  assert.deepEqual(d.loop, { everyMinutes: 60 });
  assert.deepEqual(slugs(d.relay), ['shuri', 'edna']);
  assert.deepEqual(slugs(d.cc), ['beast']);
  assert.deepEqual(d.to, []);
});

test('멘션이 없으면 아무 것도 지시되지 않는다(호출부가 기본 크루를 정한다)', () => {
  const d = parseRoomDirectives('다들 어떻게 생각해?', AGENTS);
  assert.deepEqual(d.to, []);
  assert.equal(d.allCall, false);
  assert.deepEqual(d.unknown, []);
});

test('같은 크루를 여러 번 불러도 한 번만 발언한다', () => {
  const d = parseRoomDirectives('@비스트 @beast @비스트 정리해줘', AGENTS);
  assert.deepEqual(slugs(d.to), ['beast']);
});

/* ── 분리 검수(2R) 회귀 케이스 — 멘션 탐지가 너무 넓어 평범한 지시가 무응답이 되던 것들 ── */

test('이메일 주소의 @는 멘션이 아니다 — unknown도 만들지 않는다', () => {
  // unknown이 서면 중단 게이트에 걸려 **아무도 답하지 않는다**(HIGH-1 회귀). 조용히 무시가 맞다.
  const d = parseRoomDirectives('회의록 정리해서 lean8kim@gmail.com 으로 보내줘', AGENTS);
  assert.deepEqual(d.to, []);
  assert.deepEqual(d.unknown, []);
});

test('이메일과 진짜 멘션이 같이 있으면 멘션만 잡는다', () => {
  const d = parseRoomDirectives('메일은 lean8kim@gmail.com 으로 보내줘 @비스트', AGENTS);
  assert.deepEqual(slugs(d.to), ['beast']);
  assert.deepEqual(d.unknown, []);
});

test('코드블록 안의 @는 멘션이 아니다', () => {
  const d = parseRoomDirectives('@비스트 이 코드 봐줘 ```java\n@Override void x(){}\n```', AGENTS);
  assert.deepEqual(slugs(d.to), ['beast']);
  assert.deepEqual(d.unknown, []);
});

test('스코프 패키지명(@types/node)은 멘션이 아니다', () => {
  const d = parseRoomDirectives('@슈리 @types/node 올려줘', AGENTS);
  assert.deepEqual(slugs(d.to), ['shuri']);
  assert.deepEqual(d.unknown, []);
});

test('이메일이 앞에 있어도 가짜 릴레이가 만들어지지 않는다', () => {
  const d = parseRoomDirectives('a@b.com > @울프 처리해줘', AGENTS);
  assert.deepEqual(d.relay, []);
  assert.deepEqual(slugs(d.to), ['wolf']);
});

test('cc @전체는 ccAll로 살아남는다 — 조용히 사라지면 첫 크루가 답해버린다', () => {
  const d = parseRoomDirectives('cc @전체 이 내용 공유', AGENTS);
  assert.equal(d.ccAll, true);
  assert.deepEqual(d.to, []);
  assert.deepEqual(d.unknown, []);
});

test('지시 + cc @전체 조합에서도 to와 ccAll이 각자 산다', () => {
  const d = parseRoomDirectives('@비스트 진행해줘 cc @전체', AGENTS);
  assert.deepEqual(slugs(d.to), ['beast']);
  assert.equal(d.ccAll, true);
});

/* ── 분리 검수(3R) — 경계 고정을 허용목록으로 짰다가 정상 멘션을 자르던 과교정 ──
   실패 방식이 특히 나빴다: unknown이 안 서니 중단 게이트도 안 걸려 **첫 크루가 대신 답했다**.
   무응답보다 나쁜 조용한 오배정이라, 배제(이메일 로컬파트)로 뒤집고 여기서 잠근다. */

test('따옴표·꺾쇠·괄호로 감싼 멘션도 잡는다', () => {
  for (const s of ['"@비스트"님 확인 부탁', "'@비스트' 확인", '<@비스트> 확인', '「@비스트」 확인']) {
    assert.deepEqual(slugs(parseRoomDirectives(s, AGENTS).to), ['beast'], s);
  }
});

test('콜론 뒤 멘션(담당:@이름)도 잡는다', () => {
  const d = parseRoomDirectives('담당:@비스트 확인 부탁해', AGENTS);
  assert.deepEqual(slugs(d.to), ['beast']);
  assert.deepEqual(d.unknown, []);
});

test('쉼표로 붙여 쓴 연속 멘션이 둘 다 잡힌다', () => {
  // 룩비하인드는 폭이 0이라 '@a,@b'에서 두 번째도 앞 문자를 다시 읽는다
  const d = parseRoomDirectives('@비스트,@울프 회의합시다', AGENTS);
  assert.deepEqual(slugs(d.to), ['beast', 'wolf']);
});
