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

// 소스 핀은 주석을 벗긴 뒤 스캔 — 산식을 주석으로 남기고 상수로 바꾸는 형태에 초록이면 게이트가 아니다(검수 M-1).
// 줄주석을 먼저 지운다: 블록 먼저면 줄주석 속 `/*`가 유령 블록을 연다(레포 교훈).
const stripComments = (src) => src
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const load = (rel) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

test('데크 산식 핀 — linked/memoryCount가 그대로 Dial에 닿는다, 옛 links/(n−1) 포화 산식 부재', () => {
  const page = load('../app/c/[ws]/page.jsx');
  // 선언부터 Dial 소비까지 한 구간으로 — 선언만 남기고 다른 값을 넘기는 변이도 잡는다
  assert.match(page, /const linkedPct = stats && data\.memoryCount > 0 \? \(stats\.linked \/ data\.memoryCount\) \* 100 : 0;[\s\S]*?<Dial value=\{linkedPct\} label=\{t\('deck\.linked'\)\} \/>/);
  assert.equal((page.match(/linkedPct/g) ?? []).length, 2, 'linkedPct는 선언 1 + Dial 소비 1뿐');
  assert.doesNotMatch(page, /memoryCount - 1/);
  assert.doesNotMatch(page, /stats\.links \//);
});

test('API 핀 — docStats가 자체 셈 대신 linkStats를 편입하고 뒤에서 덮어쓰지 않는다', () => {
  const route = load('../app/api/companies/[ws]/route.js');
  const fn = route.match(/function docStats\(docs\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, 'docStats 함수 구간');
  assert.match(fn, /return \{\n\s+\.\.\.linkStats\(docs\),/);
  assert.doesNotMatch(fn, /\b(links|linked)\s*:/, '스프레드 뒤 덮어쓰기 금지');
  assert.doesNotMatch(fn, /edges/, '자체 엣지 셈 부활 금지');
});

test('graph2d-core는 서버 라우트가 임포트하는 순수 모듈 — use client 유입 금지', () => {
  assert.doesNotMatch(load('../app/c/[ws]/graph2d-core.mjs'), /'use client'/);
});
