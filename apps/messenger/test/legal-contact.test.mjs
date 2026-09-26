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
