import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 유건 제보 2026-09-02: "@카맥" 치고 Enter → 멘션 완성은 뒤에 공백만 붙어 눈에 안 띄고, 한 번 더 Enter에 빈 안건이 방에
// 올라가 크루가 발언을 시작했다. 처방 = 이름만 있는 발언은 send()가 안내(room.mentionOnly)만 하고 보내지 않는다.
const load = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('회의실 send — 이름만 있는 발언은 전송 전에 막고 안내한다(setBusy·낙관 적립보다 앞)', async () => {
  const page = await load('../app/c/[ws]/room/page.jsx');
  const fn = page.slice(page.indexOf('async function send(e) {'), page.indexOf('setBusy(true); setError(\'\');', page.indexOf('async function send(e) {')));
  assert.match(fn, /if \(!att\.length && !text\.replace\(\/\(\^\|\\s\)@\\S\+\/g, ''\)\.trim\(\)\) \{ setError\(t\('room\.mentionOnly'\)\); return; \}/,
    '멘션만 남는 발언 가드 — setBusy 이전 구간에 있어야 하고(뒤면 낙관 적립·요청이 이미 나간다), 첨부가 있으면 통과(파일이 곧 안건 — 검수 MEDIUM-1)');
  // 가드 정규식의 행동 — 소스에서 그대로 뽑아 실행(테스트 사본과 어긋나지 않게)
  const re = /(^|\s)@\S+/g;
  const only = (s) => !s.replace(re, '').trim();
  assert.equal(only('@카맥'), true);
  assert.equal(only('@카맥 @슈리 '), true);
  assert.equal(only('@all'), true);
  assert.equal(only('@카맥 대시보드 정합성 봐줘'), false);
  assert.equal(only('대시보드 @카맥'), false);
  assert.equal(only('메일주소 a@b.c 확인'), false, '이메일 속 @는 멘션이 아니다(앞이 공백·행 시작이어야)');
});

test('i18n — room.mentionOnly ko/en 등록', async () => {
  const src = await load('../app/i18n.jsx');
  const m = src.match(/^\s*'room\.mentionOnly':\s*\['([^']*)',\s*'([^']*)'\]/m);
  assert.ok(m, 'room.mentionOnly 사전 등록');
  assert.ok(/[가-힣]/.test(m[1]) && !/[가-힣]/.test(m[2]), 'ko에 한글·en에 한글 없음');
});

test('회의실 LANE = 크루 대화 LANE — 두 파일의 상수 값이 같아야 한다(입력창·대화 영역 폭 통일)', async () => {
  const room = await load('../app/c/[ws]/room/page.jsx');
  const crew = await load('../app/c/[ws]/crew/[slug]/page.jsx');
  const compete = await load('../app/c/[ws]/compete/page.jsx');
  const pick = (src) => src.match(/^const LANE = ('[^']+');$/m)?.[1];
  assert.ok(pick(room) && pick(crew) && pick(compete), 'LANE 상수가 세 파일 모두에 있어야 한다');
  assert.equal(pick(room), pick(crew));
  assert.equal(pick(compete), pick(crew), '경쟁 시안 레인 = 크루(유건 2026-09-02: 창 크기·입력창 통일)');
  // 자리별 앵커(}} 폐합) — 느슨한 존재 단언은 소비처 4곳 중 하나만 남아도 초록(검수 MEDIUM-1: 컴포저 열만 지운 변이가 초록).
  // 요청의 핵심인 컴포저 열과 대화 영역(본문) 두 자리를 각각 잠근다.
  assert.match(room, /gridTemplateColumns: 'minmax\(0, 1fr\)', gap: 6, width: '100%', maxWidth: LANE, margin: '0 auto' \}\}>/, '회의실 컴포저 열 레인');
  assert.match(room, /gridTemplateColumns: 'minmax\(0, 1fr\)', gap: 14, width: '100%', maxWidth: LANE, margin: '0 auto' \}\}>/, '회의실 대화 영역 레인');
  assert.match(compete, /gridTemplateColumns: 'minmax\(0, 1fr\)', gap: 6, width: '100%', maxWidth: LANE, margin: '0 auto' \}\}>/, '경쟁 컴포저 열 레인');
  assert.match(compete, /gridTemplateColumns: 'minmax\(0, 1fr\)', gap: 12, minWidth: 0, width: '100%', maxWidth: LANE, margin: '0 auto' \}\}>/, '경쟁 본문(시안 비교) 레인');
});
