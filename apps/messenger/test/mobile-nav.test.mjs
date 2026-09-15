// 폰 화면 스택(history) 배선 핀 + 배지 재동기화 배선 핀 — 유건 제보 2026-09-15(뒤로가 홈으로만, 다 읽어도 배지 잔존).
// App.jsx는 소스 구간 불변식으로만 잠긴다(레포 규칙: JSX 대형 컴포넌트) — 행동은 test/mobile-nav.browser.mjs(픽스처 서버 + Playwright)가 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('폰 뒤로 = history.back(): 루트 탭은 replaceState, 하위 화면은 pushState, popstate가 page·chId를 되돌린다', () => {
  assert.match(src, /new Set\(\['home', 'dm', 'inbox', 'activity'\]\)/, '루트 페이지 집합');
  assert.match(src, /window\.addEventListener\('popstate', onPop\)/);
  assert.match(src, /if \(st\.chId\) setChId\(st\.chId\); setPage\(st\.page\);/, 'popstate → 화면 복원(대화면 채널까지)');
  assert.match(src, /history\.replaceState\(\{ page, chId, depth: 0 \}, ''\);\s*\} else if \(same\) history\.replaceState\(\{ page, chId, depth \}, ''\);/, '루트는 depth 0, 같은 화면 전환은 replace');
  assert.match(src, /else history\.pushState\(\{ page, chId, depth: depth \+ 1 \}, ''\);/, '하위 화면은 push(depth+1)');
  assert.match(src, /const goBack = useCallback\(\(\) => \{ if \(isPhone && \(history\.state\?\.depth \?\? 0\) > 0\) history\.back\(\); else setPage\('home'\); \}/, '루트(깊이 0)에서는 history.back을 부르지 않는다 — 앱 밖 이전 문서로 나가지 않게');
  assert.match(src, /if \(depth > 0 && !same\) \{ navCollapse\.current = page; navPopping\.current = true; history\.go\(-depth\); return; \}/, '루트 탭은 스택을 접는다(검수 M-3)');
  assert.match(src, /if \(!history\.state\?\.page\) history\.replaceState\(\{ page, chId, depth: 0 \}, ''\);/, '시딩은 state가 없을 때만(폭 전환에 깊이 보존, 검수 M-4)');
  assert.match(src, /history\.replaceState\(history\.state, '', location\.pathname\)/, '초대 링크 정리가 state를 지우지 않는다(L-2)');
  assert.doesNotMatch(src, /history\.length > 1/, 'history.length 판단 잔재 없음');
  assert.match(src, /const openNav = \(\) => \{ if \(isPhone\) goBack\(\); else setRail\(true\); \}/, '상단 뒤로 버튼(NavButton onMenu)이 스택을 탄다');
  assert.match(src, /useEdgeSwipeBack\(goBack, isPhone/, 'iOS 가장자리 스와이프도 같은 스택');
  assert.equal((src.match(/onBack=\{backFromPage\}/g) ?? []).length, 4, '설정·검색·알림함·기억 화면의 뒤로 4곳');
  assert.doesNotMatch(src, /onBack=\{\(\) => setPage\('chat'\)\}/, '옛 "무조건 대화로" 뒤로 잔재 없음');
});

test('배지 재동기화 — 앱 전면 복귀·알림함 열기·다 읽음에서 msgr_push_badge_resync를 3초 한 번 호출', () => {
  assert.match(src, /supabase\.rpc\('msgr_push_badge_resync'\)/);
  assert.match(src, /if \(now - badgeSyncAt\.current < 3000\) return;/, '3초 스로틀');
  assert.match(src, /document\.visibilityState === 'visible'\) resyncBadge\(\)/, '전면 복귀');
  assert.match(src, /loadOrg\(orgId\)\.catch\(\(e\) => setErr\(e\.message\)\); resyncBadge\(\); \}\);/, '모바일 resume 관찰자');
  assert.match(src, /setPage\('inbox'\); setRail\(false\); resyncBadge\(\); \};/, '알림함 열기');
  assert.match(src, /if \(k === 'inbox'\) \{ setInboxKind\('all'\); openInbox\(\); return; \}/, '폰 탭으로 알림함 진입도 같은 경로(검수 M-1)');
  assert.match(src, /if \(!uid\) return; resyncBadge\(\); const onVis/, '콜드 스타트 1회(검수 M-2)');
  assert.match(src, /for \(const \[cid, mid\] of top\) markRead\(cid, mid\); resyncBadge\(\);/, '모두 읽음이 알림 채널의 읽음 커서를 올린다(검수 M-6)');
  assert.match(src, /markRead\(cid, mid\); resyncBadge\(\); \}\}/, '다 읽음');
  const def = src.indexOf('const resyncBadge = useCallback'); const use = src.indexOf('resyncBadge(); });');
  assert.ok(def > 0 && def < use, '정의가 첫 사용(resume 효과)보다 앞');
});

test('i18n — 폰 상단 뒤로 라벨은 "뒤로"(홈이 아니다, L-1)', () => {
  const dict = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  assert.match(dict, /'phone\.back': \['뒤로', 'Back'\]/);
});
