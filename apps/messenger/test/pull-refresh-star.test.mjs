// 당김 새로고침 — Argo 별 회전·크기·튐(순수) — 유건 확정 2026-09-29: 당긴 거리에 비례해 커지며 회전, 임계 넘으면 튐,
// 새로고침 중엔 계속 회전(별도 CSS 애니메이션), reduced-motion이면 회전·튐 없음(CSS 쪽에서 처리).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REFRESH_THRESHOLD, REFRESH_MAX, pullRotationDeg, pullStarScale, enteredReady } from '../src/pull-refresh.mjs';

test('pullRotationDeg — 0에서 0deg, 당긴 만큼 선형 증가, 음수는 0', () => {
  assert.equal(pullRotationDeg(0), 0);
  assert.equal(pullRotationDeg(-10), 0);
  assert.ok(pullRotationDeg(REFRESH_THRESHOLD) > 0 && pullRotationDeg(REFRESH_THRESHOLD) < pullRotationDeg(REFRESH_MAX), '임계보다 최대에서 더 많이 돈다');
  assert.equal(pullRotationDeg(REFRESH_MAX), pullRotationDeg(REFRESH_MAX * 2), '한도를 넘는 거리는 더 돌지 않는다(호출자가 이미 REFRESH_MAX로 자른 값을 주지만, 방어적으로 캡)');
});

test('pullStarScale — 임계 전엔 작게 시작해 임계에서 1, 그 이상은 1로 고정', () => {
  assert.ok(pullStarScale(0) > 0 && pullStarScale(0) < 1, '0px에서도 아주 작게라도 보인다');
  assert.equal(pullStarScale(REFRESH_THRESHOLD), 1);
  assert.equal(pullStarScale(REFRESH_MAX), 1, '임계 넘으면 더 커지지 않는다');
  assert.ok(pullStarScale(REFRESH_THRESHOLD / 2) < pullStarScale(REFRESH_THRESHOLD), '당길수록 커진다');
});

test('enteredReady — pulling/idle에서 ready·refreshing으로 막 넘어갈 때만 참(튐 트리거)', () => {
  assert.equal(enteredReady('pulling', 'ready'), true);
  assert.equal(enteredReady('idle', 'refreshing'), true);
  assert.equal(enteredReady('ready', 'ready'), false, '이미 ready면 다시 트리거 안 함');
  assert.equal(enteredReady('ready', 'refreshing'), false, 'ready에서 refreshing은 새 튐이 아니다');
  assert.equal(enteredReady('pulling', 'pulling'), false);
  assert.equal(enteredReady('ready', 'pulling'), false, '임계 아래로 내려가는 건 튐이 아니다');
});

// 배선 — bindPullRefresh가 회전·크기 CSS 변수를 세팅, PullIndicator가 Argo 별(STAR_D)을 그린다
test('배선 — 당김 중 --pull-deg·--pull-scale을 세팅하고, 표시는 STAR_D(별) 아이콘', () => {
  const pr = readFileSync(new URL('../src/pull-refresh.mjs', import.meta.url), 'utf8');
  assert.match(pr, /--pull-deg/, 'bindPullRefresh가 회전값을 CSS 변수로');
  assert.match(pr, /--pull-scale/, 'bindPullRefresh가 크기값을 CSS 변수로');
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const indicator = src.slice(src.indexOf('function PullIndicator('), src.indexOf('function PullIndicator(') + 900);
  assert.match(indicator, /STAR_D/, 'Argo 별 심볼 재사용');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]{0,400}\.msgr-pullrefresh/, 'reduced-motion이면 회전·튐 끔');
  assert.doesNotMatch(css, /\.msgr-pullrefresh\s*\{[^}]*position:\s*absolute/, '더 이상 덮어씌우지 않고 본문을 밀어낸다(position:absolute 제거)');
});
