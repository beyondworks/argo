// 러너 감지 캐시 — **체감 성능을 지배하는 상수**라 테스트로 잠근다.
//
// 실사용 신고(2026-08-01, 유건 + 다른 사용자): "앱이 한 박자 느리다. 채팅도 페이지 이동도."
// 실측한 원인: `/api/companies/{ws}/keys`가 콜드 2.7초. 이 API가 부르는 detectRunners는 CLI 4종을
// **프로세스로 띄워** 버전을 묻는다. 러너가 하나도 연결돼 있지 않으면 4개를 전부 헛탐색해 최악값이
// 나온다. 그런데 화면은 이걸 페이지마다 부르고(데크 2회·설정·회사목록은 회사 수만큼), `argo:refresh`
// 때마다 또 부른다. 60초 캐시로는 페이지를 옮겨 다니는 내내 그 2.7초가 반복됐다.
//
// 여기서 잠그는 계약:
//  ① 캐시 수명이 분 단위다 — 60초로 되돌리면 같은 증상이 그대로 돌아온다.
//  ② force=true는 캐시를 안 본다 — "방금 로그인했다"를 검증하는 경로가 오래된 캐시에 막히면 안 된다
//     (감사 2026-07-20에 이미 한 번 겪은 함정이라 캐시를 늘릴수록 이 보장이 중요해진다).
//  ③ 부팅 때 예열한다 — 첫 사용자가 콜드 비용을 대신 내지 않게.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('감지 캐시가 분 단위다 — 60초로 되돌리면 페이지마다 2.7초가 돌아온다', () => {
  const s = read('../src/runners/exec.mjs');
  const m = s.match(/const DETECT_CACHE_MS = ([^;]+);/);
  assert.ok(m, '캐시 수명이 이름 있는 상수가 아니다 — 인라인 숫자는 조용히 되돌아간다');
  const ms = Function(`return (${m[1]})`)();
  assert.ok(ms >= 5 * 60_000, `캐시 수명이 ${Math.round(ms / 1000)}초 — 페이지 이동마다 CLI 4종을 다시 띄운다`);
});

test('force는 캐시를 무시한다 — 방금 로그인한 CLI가 오래된 캐시에 막히면 안 된다', () => {
  // 캐시를 늘릴수록 이 보장이 중요해진다. 10분짜리 캐시에 걸리면 "로그인했는데 안 된다"가 10분 간다.
  const s = read('../src/runners/exec.mjs');
  assert.match(s, /if \(!force && cache && Date\.now\(\) - cacheAt < DETECT_CACHE_MS\) return cache;/,
    'force 우회가 사라졌거나 조건이 바뀌었다');
});

test('부팅 때 예열한다 — 첫 사용자가 콜드 2.7초를 대신 내지 않게', () => {
  const s = read('../instrumentation-node.mjs');
  assert.match(s, /detectRunners\(\)/, '부팅 예열이 없다 — 첫 페이지 진입이 콜드 비용을 문다');
});
