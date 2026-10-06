import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

// 오피스 16차 페이지 블록(토글·콜아웃·2열/3열·표)과 공개 링크: 서버는 블록 종류를 검사하지 않고, 공개 화면 office_public_page는 office_strip이 뺀 본문만 준다.
// 마이그레이션은 만들지 않았다 — 여기서는 배포될 office_strip(마이그레이션 전체의 마지막 정의)을 그대로 올려, 새 블록 안쪽 어느 깊이의 비공개 블록·파일 블록·기록 카드·
// 모듈도 빠지고 새 블록 자체와 그 글자는 남는지 본다(앱의 같은 목록 apps/office/src/core/public-doc.js는 apps/office/test/public-doc.test.mjs가 이 정의와 대조한다).
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'Run scripts/billing-pg-drill.sh test/office-page-blocks-pg.test.mjs';
const sql = (q) => { const r = psqlSpawn(DB, ['-A', '-t', '-c', q]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const strip = (doc) => JSON.parse(sql(`select office_strip(${quote(JSON.stringify(doc))}::jsonb)`));

const MIG = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
function latestStrip() {
  let last = null;
  for (const f of readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) {
    for (const m of readFileSync(MIG + f, 'utf8').matchAll(/create or replace function public\.office_strip\(n jsonb\)[\s\S]*?\n\$\$;/g)) last = { file: f, sql: m[0] };
  }
  return last;
}

before(() => {
  if (!DB) return;
  const def = latestStrip();
  assert.ok(def, 'office_strip 정의를 찾지 못했다');
  sql(def.sql);
});

const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const secret = { type: 'privateBlock', attrs: { id: 'blk1' } };
const file = { type: 'fileRef', attrs: { id: 'f1', title: '비밀 계약서.pdf' } };
const cell = (type, ...content) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null }, content });

test('공개 본문: 새 블록 안쪽 어느 깊이의 비공개·파일·기록 카드·모듈도 빠지고, 새 블록과 그 글자는 남는다', { skip }, () => {
  const doc = { type: 'doc', content: [
    p('공개 안내'),
    { type: 'toggle', attrs: { open: false }, content: [p('요약'), p('안쪽'), secret, { type: 'toggle', attrs: { open: true }, content: [p('안의 토글'), file] }] },
    { type: 'callout', attrs: { icon: 'star' }, content: [p('알림'), { type: 'recordCard', attrs: { id: 'r' } }] },
    { type: 'columns', content: [{ type: 'column', content: [p('왼쪽'), secret] }, { type: 'column', content: [p('오른쪽'), { type: 'mailRef', attrs: { id: 'm' } }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', p('단계')), cell('tableHeader', p('기한'))] }, { type: 'tableRow', content: [cell('tableCell', p('견적'), secret), cell('tableCell', { type: 'moduleGrid', attrs: {} })] }] },
  ] };
  const out = strip(doc);
  const text = JSON.stringify(out);
  for (const t of ['privateBlock', 'fileRef', 'recordCard', 'mailRef', 'moduleGrid', '비밀 계약서', 'blk1']) assert.ok(!text.includes(t), t);
  assert.deepEqual(out.content.map((n) => n.type), ['paragraph', 'toggle', 'callout', 'columns', 'table']);
  assert.deepEqual(out.content[1].content.map((n) => n.type), ['paragraph', 'paragraph', 'toggle'], '토글 안: 비공개 블록만 빠지고 안의 토글은 남는다');
  assert.deepEqual(out.content[1].content[2].content.map((n) => n.type), ['paragraph'], '두 겹 안의 파일 블록도 빠진다');
  assert.deepEqual(out.content[1].attrs, { open: false }, '접힘 상태는 그대로');
  assert.deepEqual(out.content[4].content[1].content.map((c) => c.content.map((n) => n.type)), [['paragraph'], []], '표 칸 안의 비공개 블록·모듈도 빠진다');
  for (const t of ['요약', '안쪽', '알림', '왼쪽', '오른쪽', '단계', '견적']) assert.ok(text.includes(t), t);
});

test('공개 본문: 맨 위가 모듈 격자면 빈 노드, 내용 없는 노드·글자 노드는 그대로', { skip }, () => {
  assert.deepEqual(strip({ type: 'moduleGrid', content: [p('x')] }), {});
  assert.deepEqual(strip({ type: 'horizontalRule' }), { type: 'horizontalRule' });
  assert.deepEqual(strip({ type: 'callout', attrs: { icon: 'info' }, content: [secret] }), { type: 'callout', attrs: { icon: 'info' }, content: [] });
});
