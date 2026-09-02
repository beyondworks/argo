// 데크 "연결" 지표 — 링크가 1개 이상인 기억의 비율(유건 제보 2026-09-02: 연결 밀도가 상시 100%).
//  옛 산식 links/(n−1)은 쌍 수가 n−1을 넘는 순간 포화한다(실측 10,075쌍/2,263건 → 늘 100%).
//  새 지표는 linked/n — 100%는 "모든 기억이 하나 이상 엮였다"는 뜻이고, 셈법은 기억 그래프와 같다
//  (표기 3종 해석·양방향 중복 제거·자기 링크 제외 → 그래프의 "고아 N개 숨김"과 합이 맞는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linkStats, buildGraph2D } from '../app/c/[ws]/graph2d-core.mjs';

// 연결 7 + 고립 3 = 10 → 70%
const docs = [
  { rel: 'notes/a.md', dir: 'notes', title: 'A', links: ['notes/b'] },
  { rel: 'notes/b.md', dir: 'notes', title: 'B', links: ['notes/a'] },          // a↔b 양방향 = 쌍 1개
  { rel: 'notes/c.md', dir: 'notes', title: 'C', links: ['B'] },                // 제목 표기
  { rel: 'notes/d.md', dir: 'notes', title: 'D', links: ['e'] },                // 파일명 표기
  { rel: 'notes/e.md', dir: 'notes', title: 'E', links: [] },                   // 받기만 하는 문서도 연결됨
  { rel: 'journal/2026-09-01-x.md', dir: 'journal', title: 'X', links: ['notes/a', 'notes/없음'] }, // 미해석 링크는 무시
  { rel: 'notes/i.md', dir: 'notes', title: 'I', links: ['notes/a'] },
  { rel: 'notes/f.md', dir: 'notes', title: 'F', links: ['notes/f'] },          // 자기 링크만 = 고립
  { rel: 'notes/g.md', dir: 'notes', title: 'G', links: ['없는-문서'] },         // 깨진 링크만 = 고립
  { rel: 'notes/h.md', dir: 'notes', title: 'H', links: [] },                   // 링크 0 = 고립
];

test('linkStats — 고유 쌍 5, 연결된 기억 7 (고립 3은 제외)', () => {
  assert.deepEqual(linkStats(docs), { links: 5, linked: 7 });
  assert.deepEqual(linkStats([]), { links: 0, linked: 0 });
});

test('linkStats.linked + 그래프의 hiddenOrphans = 전체 — 데크와 기억 그래프가 같은 셈법', () => {
  const { hiddenOrphans } = buildGraph2D({ docs });
  assert.equal(linkStats(docs).linked + hiddenOrphans, docs.length);
  assert.equal(hiddenOrphans, 3);
});

test('데크 산식 핀 — linked/memoryCount, 옛 links/(n−1) 포화 산식 부재', () => {
  const page = readFileSync(new URL('../app/c/[ws]/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /const linkedPct = stats && data\.memoryCount > 0 \? \(stats\.linked \/ data\.memoryCount\) \* 100 : 0;/);
  assert.match(page, /<Dial value=\{linkedPct\} label=\{t\('deck\.linked'\)\} \/>/);
  assert.doesNotMatch(page, /memoryCount - 1/);
  assert.doesNotMatch(page, /stats\.links \//);
});

test('API 핀 — docStats가 자체 셈 대신 linkStats를 편입(links·linked 둘 다 실린다)', () => {
  const route = readFileSync(new URL('../app/api/companies/[ws]/route.js', import.meta.url), 'utf8');
  assert.match(route, /return \{\n\s+\.\.\.linkStats\(docs\),/);
  assert.doesNotMatch(route, /edges/);
});
