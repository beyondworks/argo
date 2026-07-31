// 크루 카드 "최근 업무" 판정 — 검수 PR #209가 실측한 선재 버그(라우트의 slice(-8).reverse()가
// readEvents 최신순 배열에서 "가장 오래된 8개"를 집어 카드가 첫 업무들만 표시)의 재발 잠금.
// 판정은 코어 순수 함수(recentTurnsOf) — 라우트는 auth(next/headers)에 묶여 Next 밖에서 못 연다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { recentTurnsOf } from '../src/events.mjs';

test('recentTurnsOf: 최신순 입력에서 최신 n개를 최신순 그대로 — 옛 slice(-n).reverse()는 정반대였다', () => {
  // readEvents 계약: 최신순. 12턴 시드 — 업무12가 가장 최신.
  const events = [];
  for (let i = 12; i >= 1; i--) events.push({ type: 'turn', slug: 'nova', gist: `업무${i}`, ts: i });
  events.splice(3, 0, { type: 'turn', slug: 'other', gist: '남의턴' }, { type: 'mcp', server: 'fetch' }, { type: 'turn', slug: 'nova' }); // 무gist 턴·타 크루·비turn 섞임
  const got = recentTurnsOf(events, 'nova', 8).map((e) => e.gist);
  assert.deepEqual(got, ['업무12', '업무11', '업무10', '업무9', '업무8', '업무7', '업무6', '업무5']);
  assert.deepEqual(recentTurnsOf([], 'nova'), []);
  assert.deepEqual(recentTurnsOf(null, 'nova'), []);
});

test('배선: agents route가 코어 recentTurnsOf를 쓴다 — 인라인 재분기(역순 원복)를 막는 트립와이어', async () => {
  const route = await readFile(new URL('../app/api/companies/[ws]/agents/[slug]/route.js', import.meta.url), 'utf8');
  assert.match(route, /recentTurnsOf\(events, slug, 8\)/, '최근 업무 판정은 코어 단일 진실(검수 K: 이 잠금이 없을 때 원복 변이가 초록이었다)');
  assert.doesNotMatch(route, /slice\(-8\)/, '옛 역순 표현식의 재유입 금지');
});
