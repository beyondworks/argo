// 열어 둔 페이지 최신화 판정(src/core/page-fresh.js, 16차 — PARITY-tasks D12·D15). 새 주기 폴링 없이: 탭 복귀 때 판 번호 비교, 같은 브라우저 창끼리는 바로.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldReload, peerPatch } from '../src/core/page-fresh.js';

test('탭 복귀: 서버 판이 더 클 때만 다시 읽고, 안 저장한 편집이 있으면 건너뛴다(그 저장이 충돌 안내로 이어진다)', () => {
  assert.equal(shouldReload({ local: 3, remote: 4, busy: false }), true);
  assert.equal(shouldReload({ local: 4, remote: 4, busy: false }), false, '같은 판 — 읽지 않는다');
  assert.equal(shouldReload({ local: 5, remote: 4, busy: false }), false, '내가 더 앞(방금 저장)');
  assert.equal(shouldReload({ local: 3, remote: 4, busy: true }), false, '입력 중·보낼 목록에 남은 저장');
  assert.equal(shouldReload({ local: 3, remote: null, busy: false }), false, '못 읽었으면 그대로');
  assert.equal(shouldReload({ local: undefined, remote: 2, busy: false }), false, '서버에 아직 없는 새 페이지');
});

const page = { id: 'p1', title: '옛', content: { type: 'doc', content: [] }, version: 3, updated: '2026-10-04T01:00:00.000Z', loadedAt: 1 };
const msg = (over = {}) => ({ owner: 'u1', id: 'p1', title: '새', content: { type: 'doc', content: [{ type: 'paragraph' }] }, version: 4, updated: '2026-10-04T01:00:05.000Z', ...over });

test('다른 창의 저장: 같은 계정·더 새 판·안 저장한 편집 없음일 때만 반영하고, 반영하면 열린 편집기가 새 본문으로 다시 뜬다', () => {
  const patch = peerPatch(msg(), page, { scope: 'u1', busy: false });
  assert.equal(patch.title, '새'); assert.equal(patch.version, 4); assert.deepEqual(patch.content, msg().content);
  assert.ok(patch.loadedAt > page.loadedAt, 'loadedAt이 바뀌어 편집기가 다시 뜬다');
  assert.equal(peerPatch(msg(), page, { scope: 'u2', busy: false }), null, '다른 계정(로그아웃·계정 바꿈 뒤)의 알림');
  assert.equal(peerPatch(msg({ version: 3 }), page, { scope: 'u1', busy: false }), null, '같은 판');
  assert.equal(peerPatch(msg(), page, { scope: 'u1', busy: true }), null, '이 창에 입력 중인 편집');
  assert.equal(peerPatch(msg({ id: 'p2' }), page, { scope: 'u1', busy: false }), null);
  assert.equal(peerPatch(msg(), undefined, { scope: 'u1', busy: false }), null, '이 창에 없는 페이지');
});

test('예시 데이터(서버 없음): 판이 늘지 않으니 고친 시각으로 더 새것을 가린다', () => {
  const sample = { ...page, version: 1 };
  assert.ok(peerPatch(msg({ version: 1, sample: true }), sample, { scope: 'u1', busy: false }));
  assert.equal(peerPatch(msg({ version: 1, sample: true, updated: '2026-10-04T00:59:00.000Z' }), sample, { scope: 'u1', busy: false }), null, '더 옛 저장');
  assert.equal(peerPatch(msg({ version: 1 }), sample, { scope: 'u1', busy: false }), null, '서버 모드에서 같은 판이면 시각이 달라도 반영하지 않는다');
});

// 부하 규칙(DB 위생): 새 주기 폴링을 만들지 않는다 — 최신화 코드에 setInterval이 없고, 탭 복귀 확인은 같은 페이지 10초에 한 번까지
test('최신화 코드에는 주기 폴링이 없고, 탭 복귀 확인은 10초 간격으로 묶는다', () => {
  const live = readFileSync(new URL('../src/core/page-live.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/pages/PageView.jsx', import.meta.url), 'utf8');
  for (const src of [live, view]) assert.doesNotMatch(src, /setInterval\(/);
  assert.match(view, /Date\.now\(\) - last < 10_000/);
  assert.match(live, /select\('version'\)/, '탭 복귀 때는 판 번호 한 칸만 읽는다');
});
