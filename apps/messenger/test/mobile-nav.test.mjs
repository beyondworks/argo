// 폰 화면 스택(history) 배선 핀 + 배지 재동기화 배선 핀 — 유건 제보 2026-09-15(뒤로가 홈으로만, 다 읽어도 배지 잔존).
// App.jsx는 소스 구간 불변식으로만 잠긴다(레포 규칙: JSX 대형 컴포넌트) — 행동은 test/mobile-nav.browser.mjs(픽스처 서버 + Playwright)가 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('폰 뒤로 = history.back(): 루트 탭은 replaceState, 하위 화면은 pushState, popstate가 page·chId를 되돌린다', () => {
  assert.match(src, /const ROOT_PAGES = useMemo\(\(\) => new Set\(PHONE_TABS\), \[\]\);/, '루트 페이지 집합 = 아래 탭 5개(폰 셸 v2 — phone-shell.mjs)');
  assert.match(src, /window\.addEventListener\('popstate', onPop\)/);
  assert.match(src, /if \(st\.chId\) setChId\(st\.chId\); setPage\(st\.page\);/, 'popstate → 화면 복원(대화면 채널까지)');
  assert.match(src, /history\.replaceState\(\{ page, chId, depth: 0 \}, ''\);\s*\} else if \(same\) history\.replaceState\(\{ page, chId, depth \}, ''\);/, '루트는 depth 0, 같은 화면 전환은 replace');
  assert.match(src, /else history\.pushState\(\{ page, chId, depth: depth \+ 1 \}, ''\);/, '하위 화면은 push(depth+1)');
  assert.match(src, /const navBackPending = useRef\(false\); const navBackTicket = useRef\(0\);/, '뒤로가기는 popstate 전까지 한 번만 보낸다');
  assert.match(src, /if \(!isPhone \|\| \(history\.state\?\.depth \?\? 0\) === 0\) \{ setPage\(isPhone \? lastRoot\.current : 'chat'\); return; \}/, '루트(깊이 0)에서는 history.back을 부르지 않는다 — 앱 밖 이전 문서로 나가지 않게, 마지막 아래 탭으로');
  assert.match(src, /if \(navBackPending\.current\) return;[\s\S]{0,180}history\.back\(\);[\s\S]{0,180}navBackPending\.current = false/, 'popstate 대기 중 뒤로 연타는 같은 history 이동을 중복 호출하지 않는다');
  assert.match(src, /if \(\(history\.state\?\.depth \?\? 0\) > 0\) \{ goBack\(\); return; \}/, 'Android 물리 뒤로도 내부 화면에서는 goBack 직렬화 경로를 탄다');
  assert.match(src, /invoke\('plugin:app\|exit'\)/, 'Android 루트 물리 뒤로는 앱 종료 명령으로 기본 동작을 보존한다');
  assert.match(src, /onBackButtonPress\(onNativeBack\)[\s\S]{0,260}?\}, \[goBack\]\);/, 'Android 리스너는 채널 전환마다 재등록하지 않아 연타 경합이 없다');
  assert.match(src, /if \(depth > 0 && !same\) \{ navCollapse\.current = page; navPopping\.current = true; history\.go\(-depth\);/, '루트 탭은 스택을 접는다(검수 M-3)');
  assert.match(src, /if \(!history\.state\?\.page\) history\.replaceState\(\{ page, chId, depth: 0 \}, ''\);/, '시딩은 state가 없을 때만(폭 전환에 깊이 보존, 검수 M-4)');
  assert.match(src, /history\.replaceState\(history\.state, '', location\.pathname\)/, '초대 링크 정리가 state를 지우지 않는다(L-2)');
  assert.doesNotMatch(src, /history\.length > 1/, 'history.length 판단 잔재 없음');
  assert.match(src, /const openNav = \(\) => \{ if \(isPhone\) goBack\(\); else setRail\(true\); \}/, '상단 뒤로 버튼(NavButton onMenu)이 스택을 탄다');
  assert.match(src, /const edgeEnabled = isPhone && !isPhoneRoot\(page\);[\s\S]{0,400}?useEdgeSwipeBack\(goBack, edgeEnabled/, 'iOS 가장자리 스와이프도 같은 스택(enabled는 edgeEnabled — 꺼질 때 swipeTo 해제, 검수 L-5)');
  assert.equal((src.match(/onBack=\{backFromPage\}/g) ?? []).length, 6, '설정·검색·알림함·기억(데스크톱)·기억 문서(폰)·결재 페이지(폰) 화면의 뒤로 6곳');
  assert.doesNotMatch(src, /onBack=\{\(\) => setPage\('chat'\)\}/, '옛 "무조건 대화로" 뒤로 잔재 없음');
});

test('배지 재동기화 — 앱 전면 복귀·알림함 열기·다 읽음에서 msgr_push_badge_resync를 3초 한 번 호출', () => {
  assert.match(src, /supabase\.rpc\('msgr_push_badge_resync'\)/);
  assert.match(src, /if \(now - badgeSyncAt\.current < 3000\) return;/, '3초 스로틀');
  assert.match(src, /document\.visibilityState === 'visible'\) resyncBadge\(\)/, '전면 복귀');
  assert.match(src, /setResumeEpoch\(\(x\) => x \+ 1\); bumpSync\(\); setTick\(\(x\) => x \+ 1\); resyncBadge\(\); \}\);/, '모바일 resume 관찰자 — 배지 재동기화');
  assert.match(src, /useEffect\(\(\) => \{ if \(syncEpoch\) \(isPersonal \? loadPersonal\(\) : loadOrg\(orgId\)\)\.catch\(\(e\) => setErr\(e\.message\)\); \}, \[syncEpoch\]\);/, '복귀 때 지금 공간 목록 한 번(개인 공간 분기 포함 — syncEpoch)');
  assert.match(src, /setPage\('inbox'\); setRail\(false\); resyncBadge\(\); \};/, '알림함 열기');
  assert.match(src, /const pickRoot = \(k\) => \{ setTabQ\(null\); setOrgMenu\(false\); setChPlus\(false\); setPage\(k\); \};/, '폰 아래 탭에는 알림함이 없다(폰 셸 v2) — 안 읽음은 탭 뱃지, 결재는 에이전트 탭. 알림함 열기(데스크톱 벨)의 배지 재동기화는 위 openInbox가 그대로');
  assert.match(src, /if \(!uid\) return; resyncBadge\(\); const onVis/, '콜드 스타트 1회(검수 M-2)');
  assert.match(src, /for \(const \[cid, mid\] of top\) markRead\(cid, mid\); resyncBadge\(\);/, '모두 읽음이 알림 채널의 읽음 커서를 올린다(검수 M-6)');
  assert.match(src, /dmIds\.has\(it\.channel_id\) && it\.kind !== 'approval'/, '커서 승격은 DM 채널만(공개 채널의 앞선 글을 읽음 처리하지 않는다, N-1)');
  assert.match(src, /history\.go\(-depth\); setTimeout\(\(\) => \{ if \(navCollapse\.current\) \{ navCollapse\.current = null; navPopping\.current = false; \} \}, 500\);/, '접기 가드 만료(N-5)');
  assert.match(src, /markRead\(cid, mid\); resyncBadge\(\); \}\}/, '다 읽음');
  const def = src.indexOf('const resyncBadge = useCallback'); const use = src.indexOf('resyncBadge(); });');
  assert.ok(def > 0 && def < use, '정의가 첫 사용(resume 효과)보다 앞');
});

test('i18n — 폰 상단 뒤로 라벨은 "뒤로"(홈이 아니다, L-1)', () => {
  const dict = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  assert.match(dict, /'phone\.back': \['뒤로', 'Back'\]/);
});

// 화면 전환 애니메이션·스와이프 정리 시점(유건 제보 2026-09-15 "깜빡이고 잔상") — 배선 핀. 행동은 mobile-nav.browser.mjs
import { readFileSync as _rf } from 'node:fs';
test('전환 애니메이션 종류 판정과 popstate 뒤 정리', () => {
  const app = _rf(new URL('../src/App.jsx', import.meta.url), 'utf8'); const hook = _rf(new URL('../src/use-phone.js', import.meta.url), 'utf8'); const css = _rf(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(app, /const kind = ROOT_PAGES\.has\(prev\) && ROOT_PAGES\.has\(page\) \? \(ROOT_ORDER\.indexOf\(page\) > ROOT_ORDER\.indexOf\(prev\) \? 'tab-left' : 'tab-right'\) : ROOT_PAGES\.has\(page\) \? \(swipeTo \? null : 'pop'\) : ROOT_PAGES\.has\(prev\) \? 'push' : 'tab-left';/, '루트↔루트는 방향 있는 tab, 루트→하위 push, 하위→루트 pop(스와이프면 없음)');
  assert.match(hook, /window\.addEventListener\('popstate', onPop\); setTimeout\(onPop, 400\); then\(\);/, '뒤로가기는 popstate(또는 400ms) 뒤에 정리 — 그 전에 transform을 지우면 대화 화면이 튄다');
  assert.match(hook, /underlayEl: null/, '스와이프 진행값은 상속되는 셸이 아니라 실제로 움직이는 밑 화면에만 둔다');
  assert.match(hook, /st\.underlayEl\?\.style\.setProperty\('--swipe-p'/, '매 터치 이동은 밑 화면의 transform·overlay 계산만 갱신한다');
  assert.doesNotMatch(hook, /shell\(\)\?\.style\.setProperty\('--swipe-p'/, '셸 전체에 상속 변수를 매 프레임 쓰지 않는다');
  assert.match(css, /\.msgr-phone\.anim-push-a \.msgr-main \{ animation: msgrPushIn/, 'push 애니메이션(a/b 변형 — 연속 전환 재시작)'); assert.match(app, /setPageAnim\(`\$\{kind\}-\$\{n % 2 \? 'a' : 'b'\}`\); clearTimeout\(animTimer\.current\)/, '매 전환 새 값 + 타이머 정리'); assert.match(css, /prefers-reduced-motion: reduce/, '모션 줄이기 존중');
});
