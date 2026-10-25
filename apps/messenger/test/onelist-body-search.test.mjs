// 폰 대화 탭 본문 검색(검수 D3, 0.1.64 대비 회귀, 2026-10-25) — v2 한 목록은 방·공간 이름만 걸러 글 내용(「가격표」)으로 방을 찾지 못했고 「전체에서 찾기」도 없었다.
// 지금: 서버 본문 찾기(msgr2_search, 공간을 가리지 않음) 결과의 방도 목록에 남기고, 검색 중이면 목록 아래에 「전체에서 찾기」(SearchPage)를 붙인다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { oneListView, oneListSearchHits } from '../src/v2/one-list.mjs';

const rows = [
  { room_id: 'gen', space_kind: 'team', space_id: 'T', room_kind: 'open', _title: '일반', space_name: 'Beyond 팀' },
  { room_id: 'dm', space_kind: 'personal', space_id: 'P', room_kind: 'direct', _title: '리서치' },
  { room_id: 'plan', space_kind: 'team', space_id: 'T', room_kind: 'private', _title: '기획' },
];

test('본문 일치: 방 이름에 없는 글자라도 서버 찾기에서 맞은 방은 남는다(공간을 섞어도)', () => {
  const hits = oneListSearchHits({ messages: [{ id: 1, room_id: 'gen' }, { id: 2, room_id: 'dm' }], rooms: [] });
  assert.deepEqual([...hits].sort(), ['dm', 'gen']);
  assert.deepEqual(oneListView(rows, { q: '가격표', hit: (r) => hits.has(r.room_id) }).map((r) => r.room_id), ['gen', 'dm']);
  assert.deepEqual(oneListView(rows, { q: '가격표' }).map((r) => r.room_id), [], '종전(hit 없음) — 이름만');
  assert.deepEqual(oneListView(rows, { q: '기획', hit: () => false }).map((r) => r.room_id), ['plan'], '이름 일치는 그대로');
});

test('결과 모양: 방 이름 일치(rooms)도 맞은 방, 비거나 오류면 빈 집합', () => {
  assert.deepEqual([...oneListSearchHits({ rooms: [{ id: 'plan' }] })], ['plan']);
  assert.equal(oneListSearchHits(null).size, 0);
});

test('배선: v2는 msgr2_search 한 번(공간 거르기 없음), 한 목록에 hit, 검색 중이면 searchFoot', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /if \(V2\) \{[^\n]*\n\s*const data = await q\(supabase\.rpc\('msgr2_search', \{ p_q: tabBodyQ, p_limit: 50 \}\)\)/);
  assert.match(app, /setTabHits\(\{ space: '\*', q: tabBodyQ, ids: oneListSearchHits\(data\) \}\)/);
  assert.match(app, /hit: isPhone \? olBodyHit : null/);
  assert.match(app, /\{tabQText\.trim\(\) \? searchFoot\(olShown\.length > 0\) : olEmpty\}/);
  assert.match(app, /const tabBodyQ = isPhone && \(page === 'chats' \|\| page === 'channels'\) \? tabBodyQuery\(tabQ\) : null;/, '박자 종전: 폰·검색 칸·두 글자·300ms');
});

test('배선: 폰 「전체에서 찾기」는 한 목록의 방(다른 공간 포함)도 찾고, 이름을 붙이고, 누르면 한 목록 행처럼 연다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /v2SearchFound\(supabase, qs, new Set\(\[\.\.\.channels, \.\.\.previewChannels\]\.map\(\(c\) => c\.id\)\.concat\(isPhone \? \[\.\.\.olRoomsRef\.current\.keys\(\)\] : \[\]\)\)\)/);
  assert.match(app, /olRoomsRef\.current = new Map\(\(V2 \? olRows \?\? \[\] : \[\]\)\.map\(\(r\) => \[r\.room_id, r\]\)\);/);
  assert.match(app, /const olr = isPhone && !channels\.some\(\(c\) => c\.id === id\) \? olRoomsRef\.current\.get\(id\) : null; if \(olr\) \{ openOlRow\(olr\); return; \}/);
  assert.match(app, /c\.kind === 'ol' \? c\.name : `#\$\{c\.name\}`/);
});
