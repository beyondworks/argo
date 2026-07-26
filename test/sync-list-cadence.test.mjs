// 목록 조회 주기 분리 트립와이어 — 배선(cycle 안의 두 호출)을 잠근다.
//
// 왜 소스 스캔인가: 절감의 전부는 cycle() 안에서 두 호출이 게이트를 타는 것인데, cycle은 export도
// 안 되고 실 Supabase 자격·루프가 필요해 단위로 못 태운다. 실제로 분리 검수가 배선만 되돌리는 변이
// 2종을 넣었을 때 스위트가 만점으로 통과했다(2026-07-26) — 순수 함수만 테스트하고 배선은 무방비였다.
// 레포 선례를 따른다: test/no-hardcoded-runner-label.test.mjs도 같은 이유의 소스 스캔 게이트다.
//
// 배경: storage.search()가 DB CPU의 98.3%였고(Supabase CPU 80% 경보), 두 호출을 8초 → 60초 주기로
// 분리해 87% 줄였다. 누가 게이트를 떼면 그 사고가 그대로 재발한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sync.mjs'), 'utf8');

test('cycle의 원격 tombstone 호출이 게이트를 탄다', () => {
  assert.match(SRC, /syncTombstones\(keyOwner,\s*\{\s*remote:\s*discoverDue\s*\}\)/,
    'syncTombstones가 { remote: discoverDue } 없이 불린다 — 매 사이클 .tombstones list가 돌아 절감이 사라진다');
});

test('cycle의 discoverRemote 호출이 같은 게이트를 탄다', () => {
  assert.match(SRC, /discoverDue\s*\?\s*await discoverRemote\(/,
    'discoverRemote가 게이트 없이 불린다 — 매 사이클 오너 폴더 list가 돈다');
});

test('두 호출이 같은 변수를 쓴다 — 게이트를 나누면 보관 회사가 부활한다', () => {
  // 발견은 도는데 원격 tombstone은 안 도는 사이클이 생기면, 그 사이클에 다른 기기가 보관한 회사가
  // 복원된다(보관 전파가 tombs로 걸러지는 구조). 절감이 더 필요하면 주기를 늘려야지 나누면 안 된다.
  const gates = [...SRC.matchAll(/isDiscoverDue\(/g)].length;
  assert.equal(gates, 1, '게이트 판정이 두 곳 이상이다 — discover와 tombstone이 갈라졌을 수 있다');
  assert.match(SRC, /const discoverDue = isDiscoverDue\(/, '게이트 결과는 discoverDue 하나로 모은다');
});

test('자격이 바뀌면 목록 조회 시각을 리셋한다 — 재로그인 직후 회사가 안 보이는 구멍', () => {
  assert.match(SRC, /function resetDiscoverClock\(\)/, 'resetDiscoverClock이 사라졌다');
  // ensureClient의 두 분기(서비스키·세션) 모두에서 불려야 한다 — 한쪽만이면 그쪽 전환이 뚫린다
  assert.equal([...SRC.matchAll(/resetDiscoverClock\(\);/g)].length, 2,
    'ensureClient의 서비스키·세션 두 분기 모두에서 불려야 한다');
});
