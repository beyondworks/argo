// 편집을 열면 커서는 글 끝(D22 S80) — 맨 앞이면 이어 쓴 글이 앞에 붙었다("(수정)메시지…").
// 실측(ego, 픽스처): main selectionStart 0 → '!먼저 있던 글', 수정 뒤 7/7 → '먼저 있던 글!'
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('편집 칸은 열리면서 커서를 글 끝에 둔다', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /className="msgr-input" rows=\{3\} value=\{draft\}[^\n]*autoFocus onFocus=\{\(e\) => \{ const n = e\.currentTarget\.value\.length; e\.currentTarget\.setSelectionRange\(n, n\); \}\}/);
});
