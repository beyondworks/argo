// D54(2026-09-19 설치본 실측): 데스크톱에서 텍스트 첨부 칩을 눌러도 아무 일도 없었다 — Tauri 웹뷰가 window.open을 막는데
// 오프너 플러그인은 모바일에서만 썼다. Tauri 셸이면(데스크톱·모바일) 기본 브라우저로 연다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
test('첨부 열기는 Tauri 셸이면 오프너로, 브라우저만 window.open', () => {
  const body = app.slice(app.indexOf('function Attachment('), app.indexOf('const isImg =', app.indexOf('function Attachment(')));
  assert.match(body, /if \(inTauri\(\)\) await \(await import\('@tauri-apps\/plugin-opener'\)\)\.openUrl\(data\.signedUrl\);\s*else window\.open\(data\.signedUrl, '_blank', 'noopener'\);/);
});
test('앱 어디에도 Tauri 분기 없는 window.open이 없다', () => {
  const lines = app.split('\n').filter((l) => l.includes('window.open(') && !/^\s*\/\//.test(l));
  for (const l of lines) assert.match(l, /inTauri\(\)[\s\S]*else window\.open|^\s*else window\.open/, `분기 없는 window.open: ${l.trim().slice(0, 120)}`);
  assert.equal(lines.length, 2, 'openExternal·첨부 두 곳만');
});
test('오프너 권한은 https 서명 URL을 허용한다(Supabase Storage)', () => {
  const cap = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
  const opener = cap.permissions.find((p) => p.identifier === 'opener:allow-open-url');
  assert.ok(opener?.allow?.some((a) => a.url === 'https://*'));
});
