// 사진 아바타 누름(D19) — 사이드바 채팅 행에서 사진 아바타를 누르면 방이 안 열리던 것(설치본 0.1.29).
// 실측(Chromium 픽스처): 사진 아바타를 누르고 5px 움직이면 끌기가 이미지(IMG)에서 시작 — 이미지 끌기 경로. 고친 뒤엔 행(DIV)에서 시작해 이름 글자와 같다.
// WebKit(설치본)은 이미지 끌기 문턱이 따로라 사진 위 클릭만 사라졌던 것으로 본다(추론 — WebKit 실측은 설치본 확인 필요).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('사진 아바타는 끌리지 않고 누름을 감싼 행으로 넘긴다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(app, /\{url \? <img src=\{url\} alt="" draggable=\{false\} \/> :/, 'Av의 사진은 draggable=false');
  assert.match(css, /\.msgr-av\.img img \{[^}]*pointer-events: none;[^}]*-webkit-user-drag: none;/, '누름은 span으로(글자 아바타와 같음), WebKit 이미지 끌기 끔');
});
