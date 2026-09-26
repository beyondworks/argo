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

test('조직 공간(설정 제외)은 동의 전엔 AiConsentGate를 보여준다 — 로딩 중(undefined)엔 깜빡이지 않는다', () => {
  assert.match(app, /\{!isPersonal && org && aiConsent !== undefined && !aiConsented && page !== 'settings' \? \(/, '개인 공간·설정·로딩 중은 예외');
  assert.match(app, /<AiConsentGate t=\{t\} onMenu=\{openNav\} onError=\{setErr\} onDecline=\{\(\) => setOrgId\(PERSONAL\)\} \/>/);
});

test('동의하면 setAiConsent(true)만 부르고 그 자리에서 같은 페이지가 다시 그려진다(별도 전송 재시도 로직 없음)', () => {
  const gate = app.slice(app.indexOf('function AiConsentGate('), app.indexOf('function EmptyOrg('));
  assert.match(gate, /const agree = async \(\) => \{ setBusy\(true\); try \{ await setAiConsent\(true\); \}/);
});

test('거부하면 개인 공간으로 보낸다(조직 공간 접근 차단의 유일한 탈출구)', () => {
  const gate = app.slice(app.indexOf('function AiConsentGate('), app.indexOf('function EmptyOrg('));
  assert.match(gate, /<button type="button" className="btn sm ghost" disabled=\{busy\} onClick=\{onDecline\}>\{t\('consent\.ai\.decline'\)\}<\/button>/);
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
