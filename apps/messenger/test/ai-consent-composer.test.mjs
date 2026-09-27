// App Store 5.1.2 재설계(2026-09-27, 유건 결정 "처음 한 번 필수 동의") — 로그인 뒤 조직 공간에 들어가기 전 한 번
// 필수 동의 화면. 동의하면 기존처럼 전 기능, 거부하면 조직 공간은 막고 개인 공간만 쓴다. "크루에게 보낼 때마다"
// 확인하던 이전 설계(모달)는 없앴다. 서버 쪽 거부·필터(H1·H2·H3·L9)는 test/msgr-bridge.test.mjs가 잠근다.
// 여기는 소스 대조로 배선을 확인한다(전체 렌더 하네스가 없는 이 저장소의 기존 패턴, 예: test/onboard.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('전송할 때마다 묻던 이전 설계는 없다 — Composer에 동의 관련 상태·모달이 없다', () => {
  const composer = app.slice(app.indexOf('function Composer('), app.indexOf('function Composer(') + app.slice(app.indexOf('function Composer(')).indexOf('\n}\n'));
  assert.ok(!/crewReachable|consentPrompt|confirmAiConsent|aiConsented/.test(composer), 'Composer는 더 이상 동의를 확인하지 않는다(조직 진입 단계에서 이미 걸러졌다)');
});

test('조직 공간(설정 제외)은 동의 전엔 AiConsentGate를 보여준다 — 아직 모르면(로딩) 게이트 대신 로딩 표시', () => {
  assert.match(app, /const orgGateActive = !isPersonal && !!org && aiConsent !== undefined && !aiConsented;/, '개인 공간·설정(별도 예외)·로딩 중은 게이트 대상이 아니다');
  assert.match(app, /\{aiConsentLoading && page !== 'settings' \? \(/, '3차 검수 L-3 — 조회 중엔 로딩 표시가 먼저');
  assert.match(app, /\) : orgGateActive && page !== 'settings' \? \(/, '설정 탭은 예외');
  assert.match(app, /<AiConsentGate t=\{t\} onMenu=\{openNav\} onError=\{setErr\} onDecline=\{\(\) => setOrgId\(PERSONAL\)\} \/>/);
});

// 검수 M-5(2026-09-27) — 동의 전엔 사이드바의 조직 채널·멤버·에이전트·DM 목록과 크루 시트·새 채널 버튼도 막는다(본문만 막던 결함).
// 3차 검수 L-3(2026-09-27) — "동의 안 함"(orgGateActive)과 "아직 모름"(aiConsentLoading)을 orgBlocked로 묶어 똑같이 가린다.
test('동의 전엔(또는 아직 모르면) 사이드바 채널·멤버·에이전트·DM 절과 크루 시트·설정의 조직 탭도 막힌다(본문만이 아니라)', () => {
  assert.match(app, /const orgBlocked = orgGateActive \|\| aiConsentLoading;/);
  for (const needle of [
    '{!isPersonal && !orgBlocked && favs.length > 0 && (<RailSection id="fav"',
    "{!isPersonal && !orgBlocked && <RailSection id={orgId ? 'channels' : 'start'}",
    '{!orgBlocked && (dms.length > 0 || dmTab || !!orgId)',
    '{!isPersonal && !orgBlocked && org && members.length > 0 && (<RailSection id="people"',
    '{!isPersonal && !orgBlocked && org && (myAvailable.length > 0 || railVisible.length > 0)',
    '{sheet && crewOf(sheet) && !orgBlocked && <CrewSheet',
    '{chSheet && channel && !orgBlocked && <ChannelSheet',
    'gated={orgBlocked}',
  ]) assert.ok(app.includes(needle), `누락: ${needle}`);
});

test('동의 조회 실패는 fail-open — 로딩에 갇히지 않고 게이트도 걸지 않는다', () => {
  assert.match(app, /const \[aiConsentFailOpen, setAiConsentFailOpen\] = useState\(false\);/);
  assert.match(app, /catch \(e\) \{ console\.error\('\[argo\] AI 동의 조회 실패 — 이 세션은 열어 둔다\(fail-open\):', e\?\.message \?\? e\); setAiConsentFailOpen\(true\); \}/);
  assert.match(app, /const aiConsentLoading = !isPersonal && !!org && aiConsent === undefined && !aiConsentFailOpen;/, '실패면(aiConsentFailOpen) 더 이상 로딩으로 보지 않는다');
});

test('폰 홈·DM 탭(레일이 화면 전체)에는 조회 중일 때 로딩 표시가, 안 됐을 때 동의 화면이 뜬다', () => {
  assert.match(app, /\{!isPersonal && isPhone && aiConsentLoading && \( \/\/ 3차 검수 L-3\(2026-09-27\) — 조회 중엔 채널 목록이 아니라 로딩 표시\(같은 이유로 bare, 같은 이유로 isPhone\)\n\s*<OrgGateLoading t=\{t\} bare \/>/);
});

// 실사고(2026-09-27 시각 확인) — 레일만 막고 대체 화면이 없어 폰 홈·DM 탭이 빈 화면이 됐다. bare 재사용으로 고정.
test('폰 홈·DM 탭(레일이 화면 전체)에도 같은 동의 화면을 bare로 보여준다 — 빈 화면 금지', () => {
  assert.match(app, /<AiConsentGate t=\{t\} onMenu=\{openNav\} onError=\{setErr\} onDecline=\{\(\) => setOrgId\(PERSONAL\)\} bare \/>/, '레일 안에서도 같은 문구·버튼');
  const gate = app.slice(app.indexOf('function AiConsentGate('), app.indexOf('function EmptyOrg('));
  assert.match(gate, /function AiConsentGate\(\{ t, onMenu, onError, onDecline, bare = false \}\)/);
  assert.match(gate, /\{!bare && <div className="msgr-top">/, 'bare면 레일이 이미 자기 상단 바를 갖고 있어 중복 상단 바를 생략한다');
});

// 재검수(2026-09-27, iPad Air 11 세로 시뮬레이터 실측) — 넓은 배치(사이드바+본문이 함께 보임)에서 isPhone 없이
// orgGateActive만 봐서 레일 bare 게이트와 본문 게이트가 동시에 두 번 떴다. bare는 사이드바가 화면 전체인
// 폰 셸(use-phone, 720px)에서만 떠야 한다.
test('레일의 bare 게이트·로딩은 폰 폭(isPhone)에서만 뜬다 — 넓은 배치에서 본문과 겹치지 않는다', () => {
  assert.match(app, /\{!isPersonal && isPhone && orgGateActive && \( \/\/ 검수 M-5/, '레일 bare 게이트는 isPhone 선행 조건');
  assert.match(app, /\{!isPersonal && isPhone && aiConsentLoading && \(/, '레일 bare 로딩도 isPhone 선행 조건');
});

test("설정은 동의 전엔 '내 계정' 탭만 연다 — 멤버·조직·에이전트·친구 탭은 조직 내용이다", () => {
  const settings = app.slice(app.indexOf('function Settings('), app.indexOf('function AiConsentRow('));
  assert.match(settings, /const tabs = gated \? \[\['me', 'set\.tab\.me'\]\] : \[/, "gated면 tabs가 '내 계정' 하나뿐");
  assert.match(settings, /if \(gated\) \{ setTab\('me'\); return; \}/);
  for (const needle of ["'members' && org && !gated", "'org' && org && !gated", "'crews' && org && !gated", "'friends' && !gated"]) {
    assert.ok(settings.includes(needle), `탭 내용 렌더가 gated를 보지 않음: ${needle}`);
  }
});

test('동의하면 setAiConsent(true)만 부르고 그 자리에서 같은 페이지가 다시 그려진다(별도 전송 재시도 로직 없음)', () => {
  const gate = app.slice(app.indexOf('function AiConsentGate('), app.indexOf('function EmptyOrg('));
  assert.match(gate, /const agree = async \(\) => \{ setBusy\(true\); try \{ await setAiConsent\(true\); \}/);
});

test('거부하면 개인 공간으로 보낸다(조직 공간 접근 차단의 유일한 탈출구) — 서버에도 거부를 남긴다(동의 전환 기간, 2026-09-27)', () => {
  const gate = app.slice(app.indexOf('function AiConsentGate('), app.indexOf('function EmptyOrg('));
  assert.match(gate, /const decline = async \(\) => \{ setBusy\(true\); try \{ await setAiConsent\(false\); \}/, '기존 msgr_set_ai_consent(false) 구조로 거부를 기록해 둔다 — RPC 이름은 trial-builder가 확정');
  assert.match(gate, /<button type="button" className="btn sm ghost" disabled=\{busy\} onClick=\{decline\}>\{t\('consent\.ai\.decline'\)\}<\/button>/);
});

test('안내에는 개인정보처리방침 링크가 있다', () => {
  const gate = app.slice(app.indexOf('function AiConsentGate('), app.indexOf('function EmptyOrg('));
  assert.match(gate, /openExternal\(LEGAL\.privacy\)/);
});

test('안내 문구는 사실만 — 채널의 최근 대화 포함·제공자 예시·크루마다 다름은 있고, "학습에 쓰지 않는다" 같은 보장은 없다', () => {
  const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  assert.match(i18n, /'consent\.ai\.desc':.*최근 대화.*Anthropic.*OpenAI.*Google.*Moonshot.*xAI/);
  assert.doesNotMatch(i18n, /'consent\.ai\.desc':[^\n]*학습에.*쓰지 않/, '학습에 쓰지 않는다는 보장은 하지 않는다(우리가 보장 못 하는 약속 금지)');
});

test('설정에서 동의를 철회·재동의할 수 있다(AiConsentRow, 조직 진입 게이트와 같은 SafetyCtx 상태 공유)', () => {
  assert.match(app, /function AiConsentRow\(/);
  assert.match(app, /const \{ aiConsented, setAiConsent \} = useContext\(SafetyCtx\);/);
  assert.match(app, /<AiConsentRow t=\{t\} onError=\{onError\} \/>/, '설정 "내 정보" 탭에 실제로 걸려 있다');
});

// 3차 검수 L-2(2026-09-27) — msgr_my_ai_consent·msgr_my_muted_crews를 공용 15초 tick(다른 화면 새로고침용
// 심박, someone-typing 중엔 2초로도 돈다)에 얹어 불필요하게 다시 불렀다. 값은 본인이 바꿀 때만 달라지므로
// 처음 불러올 때·본인이 바꿀 때·포그라운드 복귀(resumeEpoch)로만 좁힌다.
test('AI 동의·크루 숨기기 조회는 15초 tick이 아니라 처음 불러올 때·포그라운드 복귀에만 다시 돈다', () => {
  assert.match(app, /useEffect\(\(\) => \{ if \(uid\) loadMutedCrews\(\); \}, \[uid, resumeEpoch, loadMutedCrews\]\);/, 'msgr_my_muted_crews는 resumeEpoch만 — tick 아님');
  assert.match(app, /useEffect\(\(\) => \{ if \(uid\) loadAiConsent\(\); \}, \[uid, resumeEpoch, loadAiConsent\]\);/, 'msgr_my_ai_consent도 resumeEpoch만 — tick 아님');
  const shell = app.slice(app.indexOf('const [mutedCrewIds, setMutedCrewIds]'), app.indexOf('const setAiConsent = useCallback'));
  assert.doesNotMatch(shell, /\[uid, tick,/, '이 둘의 재조회 효과에는 더 이상 tick이 없다');
});
