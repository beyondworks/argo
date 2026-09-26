// App Store 5.1.2(2025-11 신설, 제3자 AI 공개·동의) — 크루가 읽는 방에 처음 보낼 때 동의 창이 뜨고, 동의 전엔 안 보낸다.
// 순수 로직(누가 크루에게 가는지)은 서버·게이트웨이 쪽 test/msgr-ai-consent-pg.test.mjs·test/msgr-bridge.test.mjs가 잠근다.
// 여기는 소스 대조로 배선을 확인한다(전체 렌더 하네스가 없는 이 저장소의 기존 패턴, 예: test/onboard.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('전송 전에 동의를 확인한다 — 크루가 있는 방(scopeCrews)에서 미동의면 보내지 않고 동의 창만 연다(초안 유지)', () => {
  assert.match(app, /const crewReachable = \(scopeCrews \?\? \[\]\)\.length > 0;/, '방에 크루가 있으면(=크루가 읽는 방) 동의 대상');
  assert.match(app, /if \(crewReachable && !safety\.aiConsented\) \{ setConsentPrompt\(true\); return; \}/, '미동의면 doSend를 부르지 않고 창만 연다');
});

test('동의 창에서 동의하면 그 자리에서 전송을 이어간다(다시 누를 필요 없음)', () => {
  assert.match(app, /const confirmAiConsent = async \(\) => \{[\s\S]{0,200}await safety\.setAiConsent\(true\); setConsentPrompt\(false\); await doSend\(\);/, '동의 → 저장 → 그대로 전송');
});

test('거부(닫기)는 별도 처리 없이 창만 닫는다 — 전송하지 않고 입력한 초안은 그대로 남는다(setText를 부르지 않는다)', () => {
  const m = app.match(/onClose=\{\(\) => \{ if \(!consentBusy\) setConsentPrompt\(false\); \}\}/);
  assert.ok(m, '거부는 setConsentPrompt(false)만 — 텍스트를 지우거나 전송하지 않는다');
});

test('안내 문구는 사실만 — 제공자 예시·크루마다 다름·개인정보처리방침 링크는 있고, "학습에 쓰지 않는다" 같은 보장은 없다', () => {
  assert.match(app, /openExternal\(LEGAL\.privacy\)/, '설명 안에 개인정보처리방침 링크');
  const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  assert.match(i18n, /'consent\.ai\.desc':.*Anthropic.*OpenAI.*Google.*Moonshot.*xAI/, '제공자 예시가 실제로 들어 있다(과장 없이 사실만)');
  assert.doesNotMatch(i18n, /'consent\.ai\.desc':[^\n]*학습에.*쓰지 않/, '학습에 쓰지 않는다는 보장은 하지 않는다(우리가 보장 못 하는 약속 금지)');
});

test('설정에서 동의를 철회·재동의할 수 있다', () => {
  assert.match(app, /function AiConsentRow\(/, 'AiConsentRow 컴포넌트가 있다');
  assert.match(app, /const \{ aiConsented, setAiConsent \} = useContext\(SafetyCtx\);/, '전송 전 창과 같은 SafetyCtx 상태를 공유(동의 즉시 두 자리 모두 반영)');
  assert.match(app, /onClick=\{toggle\}>\{t\(aiConsented \? 'set\.aiConsent\.revoke' : 'set\.aiConsent\.grant'\)\}/);
  assert.match(app, /<AiConsentRow t=\{t\} onError=\{onError\} \/>/, '설정 "내 정보" 탭에 실제로 걸려 있다');
});

test('로딩 중(아직 서버에 안 물어봄)에도 미동의로 다룬다 — 불확실하면 보내지 않는다(게이트웨이와 같은 태도)', () => {
  assert.match(app, /const \[aiConsent, setAiConsentState\] = useState\(undefined\);/);
  assert.match(app, /aiConsented: !!aiConsent,/, 'undefined·null 모두 falsy → 미동의로 취급');
});
