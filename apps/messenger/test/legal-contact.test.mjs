// App Store 1.5(연락처 정보) — 설정에 문의하기 항목이 실제로 걸려 있는지 소스 대조로 잠근다.
// 검수 M5(2026-09-27): 결제 링크가 있는 홈(#contact) 대신 지원 이메일로 직행 — 2026-09-26 라이브 curl로 실주소 확인.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');

test('LEGAL의 contact는 결제 링크가 있는 홈이 아니라 지원 이메일로 직행한다(검수 M5)', () => {
  assert.match(src, /const LEGAL = \{[^}]*contact: 'mailto:lean8kim@gmail\.com'/);
});

test('LegalLinks가 문의하기 버튼을 렌더한다(설정 "내 정보" 탭에서 LegalLinks를 쓰므로 자동으로 노출)', () => {
  assert.match(src, /onClick=\{\(\) => openExternal\(LEGAL\.contact\)\}>\{t\('legal\.contact'\)\}/);
});

test('legal.contact 문구가 ko·en 둘 다 있다', () => {
  assert.match(i18n, /'legal\.contact': \['문의하기', 'Contact us'\]/);
});

// 3차 검수 H-1(2026-09-27, 발행 차단) — 네이티브 앱에서 mailto:가 tauri-plugin-opener 허용 목록에 없어
// "문의하기"를 눌러도 아무 반응이 없었다(오류는 openExternal의 catch가 삼킨다). default.json은 platforms
// 지정이 없어 모든 플랫폼(데스크톱·iOS·Android)에 적용되므로 여기 한 곳만 열면 된다.
test('오프너 권한은 mailto:를 허용한다(문의하기가 네이티브에서 열리려면) — 빠지면 이 테스트가 red', () => {
  const cap = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
  assert.ok(!cap.platforms, 'default.json은 platforms 제한이 없어야 모든 플랫폼에 적용된다');
  const opener = cap.permissions.find((p) => p.identifier === 'opener:allow-open-url');
  assert.ok(opener?.allow?.some((a) => a.url === 'mailto:*'), 'mailto: 열기 허용 누락');
  assert.ok(opener?.allow?.some((a) => a.url === 'https://*'), '기존 https 허용은 유지(허용 목록을 넓히지 않고 mailto만 추가)');
  assert.equal(opener.allow.length, 2, '허용 목록은 https·mailto 둘뿐 — 그 이상 넓히지 않는다');
});
