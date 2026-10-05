// UX-A03(2026-10-05): 상단 검색이 데크·활동·기억 밖에서는 입력해도 아무 반응이 없었다 — 받는 화면에서만 보인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchScope } from '../app/c/[ws]/search-scope.mjs';

test('검색을 받는 화면만 대상 — 나머지는 칸을 숨긴다', () => {
  assert.equal(searchScope('/c/acme', 'acme'), 'deck');
  assert.equal(searchScope('/c/acme/', 'acme'), 'deck');
  assert.equal(searchScope('/c/acme/activity', 'acme'), 'activity');
  assert.equal(searchScope('/c/acme/vault', 'acme'), 'vault');
  for (const p of ['/c/acme/crew/pepper', '/c/acme/room', '/c/acme/compete', '/c/acme/routines', '/c/acme/mail', '/c/acme/market', '/c/acme/settings']) {
    assert.equal(searchScope(p, 'acme'), null, p);
  }
});

test('대상 화면 셋이 실제로 argo:search를 구독한다(구독이 사라지면 검색 칸이 다시 죽은 칸이 된다)', () => {
  for (const f of ['app/c/[ws]/page.jsx', 'app/c/[ws]/activity/page.jsx', 'app/c/[ws]/vault/page.jsx']) {
    assert.match(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /addEventListener\('argo:search'/, f);
  }
});
