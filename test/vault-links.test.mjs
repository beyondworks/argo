// 본문 링크 재작성(S5) — "경로를 알려라"고 시켜 놓고 렌더러가 '#'로 죽이던 모순(탐색 G7).
// 화이트리스트 재작성이라 방어 방향 유지: 서빙 가능한 것만 살고 나머지는 null(호출부 '#').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteVaultHref } from '../src/vault-links.mjs';

test('산출물 링크가 열리는 URL로 — md는 뷰어, 비md는 files API', () => {
  assert.equal(rewriteVaultHref('projects/20260730_x/제안서.pptx', 'w1'),
    `/api/companies/w1/files?rel=${encodeURIComponent('projects/20260730_x/제안서.pptx')}`);
  assert.equal(rewriteVaultHref('vault/files/표.xlsx', 'w1'),
    `/api/companies/w1/files?rel=${encodeURIComponent('files/표.xlsx')}`); // vault/ 접두 정규화
  assert.equal(rewriteVaultHref('notes/메모.md', 'w1'), `/c/w1/vault?doc=${encodeURIComponent('notes/메모.md')}`);
  assert.equal(rewriteVaultHref('./projects/a/b.pdf', 'w1'),
    `/api/companies/w1/files?rel=${encodeURIComponent('projects/a/b.pdf')}`);
});

test('서빙 불가·위험 입력은 null(→ #) — 방어 방향 불변', () => {
  assert.equal(rewriteVaultHref('notes/데이터.csv', 'w1'), null); // files API 밖 비md — 칩 400과 동일 기준
  assert.equal(rewriteVaultHref('journal/2026-07-30-a.md', 'w1'), null); // 일지는 전용 칩
  assert.equal(rewriteVaultHref('projects/../.secrets.json', 'w1'), null); // 탈출
  assert.equal(rewriteVaultHref('projects//x.pdf', 'w1'), null); // 빈 세그먼트
  assert.equal(rewriteVaultHref('javascript:alert(1)', 'w1'), null); // 스킴
  assert.equal(rewriteVaultHref('files\\윈도.pdf', 'w1'), null); // 백슬래시 — 경로 판정 밖
  assert.equal(rewriteVaultHref('projects/a.pdf', ''), null); // wsId 없으면 재작성 안 함(기존 # 유지)
});

test('marked 이스케이프 복원 + 한글·괄호 경로 인코딩', () => {
  const url = rewriteVaultHref('files/보고 (최종)&amp;v2.pdf', 'w1');
  assert.equal(url, `/api/companies/w1/files?rel=${encodeURIComponent('files/보고 (최종)&v2.pdf')}`);
});

test('배선: Markdown 렌더러가 재작성 함수를 쓰고, 채팅·회의실·경쟁이 wsId를 넘긴다', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../app/ui.jsx', import.meta.url), 'utf8');
  assert.match(ui, /rewriteVaultHref\(h, wsId\)/, '렌더러 재작성 경유');
  assert.match(ui, /'href="#"'/, '재작성 불가는 여전히 # (방어 유지)');
  for (const [p, re] of [
    ['../app/c/[ws]/crew/[slug]/page.jsx', /<Markdown text={m\.text} wsId={ws} \/>/],
    ['../app/c/[ws]/room/page.jsx', /<Markdown text={m\.text} wsId={ws} \/>/],
    ['../app/c/[ws]/compete/page.jsx', /wsId={ws} \/>/],
  ]) assert.match(await readFile(new URL(p, import.meta.url), 'utf8'), re, `wsId 전달 누락: ${p}`);
});
