// 폰 대화 탭 칩·조직 겹침(검수 D2, 2026-10-25) — 「에이전트」 칩을 누른 뒤 「조직 ▾」에서 팀을 고르면 강조는 조직으로만 옮겨 가는데 에이전트 조건이 남아 목록이 비었다.
// 지금: 폰은 조직이 골라져 있으면 칩 조건을 '전체'로 본다(강조와 실제 조건이 같다). 데스크톱은 칩 강조가 남아 둘 다 건다(종전).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { oneListView, oneListChipFilter } from '../src/v2/one-list.mjs';

const T = 'team-1';
const rows = [
  { room_id: 'gen', space_kind: 'team', space_id: T, room_kind: 'open', name: '일반', last_at: '2026-10-25T03:00:00Z' },
  { room_id: 'plan', space_kind: 'team', space_id: T, room_kind: 'private', name: '기획', last_at: '2026-10-25T02:00:00Z' },
  { room_id: 'ag', space_kind: 'personal', space_id: 'p', room_kind: 'direct', name: '', agent_id: 'a1', peer_agent_id: 'a1', last_at: '2026-10-25T01:00:00Z' },
];

test('폰: 에이전트 칩 → 조직 고르기 = 그 조직의 방이 다 보인다(숨은 칩 조건 없음)', () => {
  const f = oneListChipFilter({ filter: 'agents', org: T, phone: true });
  assert.equal(f, 'all');
  assert.deepEqual(oneListView(rows, { filter: f, org: T }).map((r) => r.room_id).sort(), ['gen', 'plan']);
});

test('폰: 조직을 고르지 않았으면 칩 조건 그대로, 데스크톱은 칩·조직 둘 다', () => {
  assert.equal(oneListChipFilter({ filter: 'agents', org: null, phone: true }), 'agents');
  assert.equal(oneListChipFilter({ filter: 'unread', org: T, phone: false }), 'unread');
});

test('배선: 한 목록 거르기는 oneListChipFilter를 거친다, 칩을 누르면 조직이 풀린다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /oneListView\([^\n]*\{ filter: oneListChipFilter\(\{ filter: olFilter, org: olOrg, phone: isPhone \}\), org: olOrg,/);
  assert.match(app, /aria-checked=\{!olOrg && olFilter === k\}[^\n]*onClick=\{\(\) => \{ setOlFilter\(k\); setOlOrg\(null\); \}\}/);
});
