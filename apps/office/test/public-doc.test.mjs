// 공개 링크와 새 블록(16차) — 공개 페이지 본문은 서버 office_strip이 비공개 블록·파일 블록·기록 카드·모듈을 뺀 뒤 ui/DocView.jsx가 그린다.
// ① 앱의 빼는 목록(core/public-doc.js)이 서버의 가장 최근 office_strip 정의와 같은지, ② 토글·콜아웃·2열·표 안쪽 깊이 숨은 비공개 블록도 빠지는지,
// ③ 공개 화면(DocView)이 새 블록을 그리면서 비공개 내용·파일 이름·위험한 링크를 내보내지 않는지 실제로 그려서 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocView } from './helpers/docview.mjs';
import { PUBLIC_DROP, stripPublic } from '../src/core/public-doc.js';

const MIG = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
/** 마이그레이션 전체에서 office_strip의 마지막 정의(파일 이름 순) */
function latestStrip() {
  let last = null;
  for (const f of readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIG, f), 'utf8');
    for (const m of sql.matchAll(/create or replace function public\.office_strip\(n jsonb\)[\s\S]*?\n\$\$;/g)) last = { file: f, sql: m[0] };
  }
  return last;
}

test('앱의 공개 빼기 목록 = 서버 office_strip의 가장 최근 정의(목록이 서로 어긋나지 않게)', () => {
  const { file, sql } = latestStrip();
  const list = /not in\s*\(([^)]*)\)/.exec(sql)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual([...list].sort(), [...PUBLIC_DROP].sort(), `${file}의 목록`);
  for (const added of ['toggle', 'callout', 'columns', 'column', 'table', 'tableRow', 'tableCell', 'tableHeader']) assert.ok(!PUBLIC_DROP.includes(added), `${added}는 공개 본문으로 보인다`);
  assert.match(sql, /n->>'type'='moduleGrid' then '\{\}'::jsonb/, '맨 위가 모듈 격자면 빈 노드(앱도 같다)');
});

const secret = { type: 'privateBlock', attrs: { id: 'blk1' } };
const file = { type: 'fileRef', attrs: { id: 'f1', title: '비밀 계약서.pdf' } };
const p = (text, marks) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
const DOC = { type: 'doc', content: [
  p('공개 안내'),
  { type: 'toggle', attrs: { open: false }, content: [p('접힌 요약'), p('접힌 안쪽'), secret] },
  { type: 'callout', attrs: { icon: 'star' }, content: [p('알림'), file] },
  { type: 'columns', content: [{ type: 'column', content: [p('왼쪽'), secret] }, { type: 'column', content: [p('오른쪽'), { type: 'recordCard', attrs: { id: 'r' } }] }] },
  { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: [120] }, content: [p('단계')] }, { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: [200] }, content: [p('기한')] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p('견적'), secret] }, { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p('1일')] }] }] },
  p('바깥 링크', [{ type: 'link', attrs: { href: 'https://example.test/a' } }]),
  p('나쁜 링크', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
  { type: 'moduleGrid', attrs: { items: [] } },
] };

test('공개 본문 걸러내기: 새 블록은 남고, 그 안쪽 어느 깊이의 비공개·파일·기록 카드도 빠진다', () => {
  const out = stripPublic(DOC);
  const text = JSON.stringify(out);
  for (const t of ['privateBlock', 'fileRef', 'recordCard', 'moduleGrid', '비밀 계약서']) assert.ok(!text.includes(t), t);
  assert.deepEqual(out.content.map((n) => n.type), ['paragraph', 'toggle', 'callout', 'columns', 'table', 'paragraph', 'paragraph']);
  assert.equal(out.content[1].content.length, 2, '토글 안 비공개 블록만 빠졌다');
  assert.equal(stripPublic({ type: 'moduleGrid', content: [] }).type, undefined, '맨 위 모듈 격자는 빈 노드');
});

test('공개 화면 그리기: 토글·콜아웃·2열·표가 편집기와 같은 class로 그려지고, 비공개 내용·위험한 링크는 나오지 않는다', async () => {
  const render = await loadDocView();
  const html = render(DOC, { strip: true });
  assert.match(html, /<div class="toggle" data-open="false"><button[^>]*aria-expanded="false"/, '토글은 저장된 대로 접힌 채');
  assert.match(html, /<div class="callout" data-icon="star"><span class="callout-icon"/);
  assert.match(html, /<div class="cols"><div class="col">/);
  assert.match(html, /<div class="tableWrapper"><table style="width:320px"><colgroup><col style="width:120px"\/><col style="width:200px"\/><\/colgroup><tbody><tr><th>/, '열 너비는 문서에 저장된 값');
  assert.match(html, /<a href="https:\/\/example\.test\/a" rel="noopener noreferrer nofollow" target="_blank">바깥 링크<\/a>/, '새 창·안전한 rel');
  assert.ok(!html.includes('javascript:'), '위험한 주소는 링크로 만들지 않는다');
  assert.ok(html.includes('나쁜 링크'), '글자는 남긴다');
  for (const t of ['비밀 계약서', 'blk1', 'privateBlock', 'f1']) assert.ok(!html.includes(t), t);
  const raw = render(DOC); // 걸러내지 않은 본문을 그려도(편집기의 비공개 미리 보기 등) 비공개 자리·파일 블록은 글자를 내지 않는다 — 비공개 본문은 따로 저장된다
  for (const t of ['비밀 계약서', 'blk1']) assert.ok(!raw.includes(t), t);
});

test('표 칸 병합 값은 100까지만 그린다 — 큰 값이 공개 화면을 멈추지 않게', async () => {
  // colspan이 1천만이면 열 너비 배열을 그만큼 만들어 공개 화면이 멈출 수 있었다(16차 검수 LOW 5)
  const render = await loadDocView();
  const cell = (colspan) => ({ type: 'tableCell', attrs: { colspan, rowspan: 1e7, colwidth: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] });
  const html = render({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell(1e7)] }] }] });
  assert.match(html, /colSpan="100"|colspan="100"/);
  assert.match(html, /rowSpan="100"|rowspan="100"/);
});
