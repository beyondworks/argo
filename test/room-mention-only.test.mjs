import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 유건 제보 2026-09-02: "@카맥" 치고 Enter → 멘션 완성은 뒤에 공백만 붙어 눈에 안 띄고, 한 번 더 Enter에 빈 안건이 방에
// 올라가 크루가 발언을 시작했다. 처방 = 이름만 있는 발언은 send()가 안내(room.mentionOnly)만 하고 보내지 않는다.
const load = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('회의실 send — 이름만 있는 발언은 전송 전에 막고 안내한다(setBusy·낙관 적립보다 앞)', async () => {
  const page = await load('../app/c/[ws]/room/page.jsx');
  const fn = page.slice(page.indexOf('async function send(e) {'), page.indexOf('setBusy(true); setError(\'\');', page.indexOf('async function send(e) {')));
  assert.match(fn, /if \(!text\.replace\(\/\(\^\|\\s\)@\\S\+\/g, ''\)\.trim\(\)\) \{ setError\(t\('room\.mentionOnly'\)\); return; \}/,
    '멘션만 남는 발언 가드 — setBusy 이전 구간에 있어야 한다(뒤면 낙관 적립·요청이 이미 나간다)');
  // 가드 정규식의 행동 — 소스에서 그대로 뽑아 실행(테스트 사본과 어긋나지 않게)
  const re = /(^|\s)@\S+/g;
  const only = (s) => !s.replace(re, '').trim();
  assert.equal(only('@카맥'), true);
  assert.equal(only('@카맥 @슈리 '), true);
  assert.equal(only('@all'), true);
  assert.equal(only('@카맥 대시보드 정합성 봐줘'), false);
  assert.equal(only('대시보드 @카맥'), false);
  assert.equal(only('메일주소 a@b.c 확인'), false, '이메일 속 @는 멘션이 아니다(앞이 공백·행 시작이어야)');
});

test('i18n — room.mentionOnly ko/en 등록', async () => {
  const src = await load('../app/i18n.jsx');
  const m = src.match(/^\s*'room\.mentionOnly':\s*\['([^']*)',\s*'([^']*)'\]/m);
  assert.ok(m, 'room.mentionOnly 사전 등록');
  assert.ok(/[가-힣]/.test(m[1]) && !/[가-힣]/.test(m[2]), 'ko에 한글·en에 한글 없음');
});
