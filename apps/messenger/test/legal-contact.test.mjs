// App Store 1.5(연락처 정보) — 설정에 문의하기 항목이 실제로 걸려 있는지 소스 대조로 잠근다.
// 랜딩(argo.ceo)의 실제 문의 경로는 #contact 섹션(mailto:lean8kim@gmail.com) — 2026-09-26 라이브 curl로 확인.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');

test('LEGAL에 contact 경로가 있고 argo.ceo 문의 섹션을 가리킨다', () => {
  assert.match(src, /const LEGAL = \{[^}]*contact: 'https:\/\/argo\.ceo\/#contact'/);
});

test('LegalLinks가 문의하기 버튼을 렌더한다(설정 "내 정보" 탭에서 LegalLinks를 쓰므로 자동으로 노출)', () => {
  assert.match(src, /onClick=\{\(\) => openExternal\(LEGAL\.contact\)\}>\{t\('legal\.contact'\)\}/);
});

test('legal.contact 문구가 ko·en 둘 다 있다', () => {
  assert.match(i18n, /'legal\.contact': \['문의하기', 'Contact us'\]/);
});
