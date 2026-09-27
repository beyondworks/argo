// 폰 컴포저 첨부 칩 vs 멘션 안내 겹침(유건 제보 2026-09-27) — 실측(ego, 폰 390 픽스처): 첨부 칩이 알약 한 줄 안에서
// 클립·입력칸과 폭을 다투다 파일명이 세로로 한 글자씩 쪼개지고, 빈 칸 안내용 @ 글리프가 칩 위에 겹쳤다.
// 칩을 자기 줄(msgr-filechips)로 빼고, 크기표시·삭제버튼은 줄지 않게 고정해 다시 쪼개지지 않게 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('첨부 칩은 자기 묶음(msgr-filechips)으로 렌더 — 파일명 span도 별도(말줄임 대상)', () => {
  assert.match(app, /\{files\.length > 0 && <span className="msgr-filechips">\{files\.map/, '파일 칩 묶음 래퍼');
  assert.match(app, /<span className="filechip-name">\{f\.name\}<\/span>/, '파일명은 별도 span — 이름만 줄어들어 말줄임');
});

test('데스크톱은 그대로 — msgr-filechips는 기본 display:contents(레이아웃 영향 없음)', () => {
  assert.match(css, /\.msgr-tools \.msgr-filechips \{ display: contents; \}/);
});

test('폰: 첨부 칩 줄은 알약 밖(자기 줄)으로 — 클립·입력칸과 폭을 다투지 않는다', () => {
  assert.match(css, /\.msgr-phone [^\n]*\.msgr-filechips \{ display: flex; flex-direction: column;[^}]*position: absolute;[^}]*bottom: calc\(100% \+ 8px\);/, '알약 위에 자기 줄로 쌓인다');
});

test('폰: 크기 표시·삭제 버튼은 줄지 않는다 — 안 그러면 이름 옆 나머지가 한 글자씩 세로로 쪼개진다', () => {
  assert.match(css, /\.msgr-tools \.filechip \.msgr-klabel, \.msgr-tools \.filechip \.x \{ flex: none; white-space: nowrap; \}/);
});

test('폰: 첨부가 있으면 빈 칸 안내용 @ 글리프를 숨긴다 — 칩과 겹치던 자리', () => {
  assert.match(css, /\.msgr-phone [^\n]*\.msgr-composer:has\(\.filechip\) \.msgr-tools \.tb:nth-child\(2\) \{ display: none; \}/);
});

test('폰: 첨부 칩이 있을 때 멘션 후보창은 칩 줄 위로 더 띄운다 — 겹치지 않는다', () => {
  assert.match(css, /\.msgr-phone [^\n]*\.msgr-pop:has\(~ \.msgr-composer \.filechip\) \{ bottom: calc\(100% \+ 8px \+ 68px\); \}/);
});
