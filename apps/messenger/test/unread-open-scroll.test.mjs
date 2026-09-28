// 대화를 열 때 스크롤 목표(순수) — 유건 확정 2026-09-29: 안 읽은 글이 있고 한 화면에 안 들어가면
// '새 메시지' 구분선이 위쪽 1/3에 오도록 열고 바닥 고정(stick)을 끈다. 한 화면에 다 들어가면 지금처럼 맨 아래.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UNREAD_OPEN_TOP_RATIO, unreadFitsOneScreen, unreadOpenScrollTarget } from '../src/unread-open-scroll.mjs';

test('unreadFitsOneScreen — 구분선부터 바닥까지가 화면 높이 안에 들어가는가', () => {
  assert.equal(unreadFitsOneScreen(1000, 700, 300), true, '1000-700=300 <= 300');
  assert.equal(unreadFitsOneScreen(1000, 600, 300), false, '400 > 300');
});

test('unreadOpenScrollTarget — 안 읽은 글 없음(dividerTop null)은 맨 아래 + stick', () => {
  assert.deepEqual(unreadOpenScrollTarget({ scrollHeight: 2000, dividerTop: null, clientHeight: 500 }), { scrollTop: 1500, stick: true });
});

test('unreadOpenScrollTarget — 한 화면에 다 들어가면 맨 아래 + stick(예: 안 읽은 글 3개)', () => {
  // 구분선(1800)부터 바닥(2000)까지 200 <= clientHeight(500)
  assert.deepEqual(unreadOpenScrollTarget({ scrollHeight: 2000, dividerTop: 1800, clientHeight: 500 }), { scrollTop: 1500, stick: true });
});

test('unreadOpenScrollTarget — 안 들어가면 구분선이 위쪽 1/3, stick 끔(예: 안 읽은 글 50개)', () => {
  // 구분선(500)부터 바닥(5000)까지 4500 > clientHeight(800) → 구분선을 800*(1/3)=266.67 아래로
  const r = unreadOpenScrollTarget({ scrollHeight: 5000, dividerTop: 500, clientHeight: 800 });
  assert.equal(r.stick, false);
  assert.ok(Math.abs(r.scrollTop - (500 - 800 / 3)) < 0.01);
});

test('unreadOpenScrollTarget — 계산값은 0과 최대 스크롤 사이로 clamp', () => {
  // 구분선이 맨 위 근처라 위로 당기면 음수가 되는 경우 → 0
  const near0 = unreadOpenScrollTarget({ scrollHeight: 5000, dividerTop: 50, clientHeight: 800 });
  assert.equal(near0.scrollTop, 0);
  // 최대 스크롤(scrollHeight-clientHeight)을 넘지 않는다
  const overMax = unreadOpenScrollTarget({ scrollHeight: 900, dividerTop: 890, clientHeight: 100 });
  assert.equal(overMax.scrollTop, 800);
});

test('UNREAD_OPEN_TOP_RATIO는 1/3', () => { assert.equal(UNREAD_OPEN_TOP_RATIO, 1 / 3); });

// 배선 — Channel이 열릴 때 한 번 이 판정을 쓰고, stick.current를 그 결과로만 정한다
test('배선 — 채널을 열 때 .msgr-newline 위치로 스크롤 목표를 계산한다', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/unread-open-scroll\.mjs'/, 'import');
  assert.match(src, /unreadOpenScrollTarget\(/, '호출');
  assert.match(src, /querySelector\('\.msgr-newline'\)/, '구분선 노드 조회');
});
