// 페이지 이름과 본문 첫 줄(src/pages/page-title.js, 16차 — PARITY-ALL 1번 표 4행 "이관 페이지 제목이 바뀌는 위험").
// 예전 편집기는 첫 블록이 제목이기만 하면 그 글자를 이름으로 저장해서, 노션에서 옮긴 페이지(이름은 따로, 본문은 노션 제목으로 시작)를 처음 고치는 순간 이름이 바뀌었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { titleLinked, nextTitle, renameDoc, cleanTitle, headText } from '../src/pages/page-title.js';
import * as F from '../scripts/fixtures/notion-sample.mjs';
import { planAll } from '../scripts/notion-plan.mjs';

const h = (text, level = 1) => ({ type: 'heading', attrs: { level }, ...(text ? { content: [{ type: 'text', text }] } : {}) });
const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...c) => ({ type: 'doc', content: c });

test('새 페이지(빈 제목 1로 시작): 첫 줄을 고치면 이름도 따라간다 — 예전과 같다', () => {
  const fresh = doc(h(''));
  assert.equal(titleLinked(fresh, ''), true);
  assert.equal(nextTitle(doc(h('주간 회의'), p('본문')), { linked: true, title: '' }), '주간 회의');
  assert.equal(titleLinked(doc(h('회의록'), p('x')), '회의록'), true, '이름과 같은 제목 줄');
  assert.equal(titleLinked(doc(h('회의록 ', 2)), '회의록'), true, '앞뒤 빈칸은 같게 본다(제목 단계와 상관없이)');
});

test('이관 페이지: 이름과 다른 제목으로 시작하는 본문은 처음 고쳐도 이름이 바뀌지 않는다', () => {
  const { plan } = planAll(F, { org: 'o', now: Date.parse('2026-10-02T00:00:00Z') });
  const playbook = plan.pages.find((x) => x.title === '영업 플레이북');
  assert.equal(playbook.content.content[0].type, 'heading', '본문 첫 블록이 노션 제목 1(첫 미팅)');
  assert.equal(titleLinked(playbook.content, playbook.title), false);
  const edited = { ...playbook.content, content: [h('첫 미팅 — 고침'), ...playbook.content.content.slice(1)] };
  assert.equal(nextTitle(edited, { linked: false, title: playbook.title }), '영업 플레이북', '첫 줄을 고쳐도 이름은 그대로');
  assert.equal(titleLinked(doc(h('', 2)), ''), false, '이름이 비어도 제목 2 이하로 시작하면 이름 줄로 보지 않는다');
  assert.equal(titleLinked(doc(p('문단')), ''), false);
});

test('제목 줄이 문단으로 바뀌거나 지워지면 이름은 마지막 이름 그대로', () => {
  assert.equal(nextTitle(doc(p('이제 문단')), { linked: true, title: '기존' }), '기존');
  assert.equal(nextTitle(doc(h('')), { linked: true, title: '기존' }), '', '제목 줄을 비우면 이름도 빈다(새 페이지와 같은 규칙)');
});

test('이름 바꾸기: 제목 줄이 있으면 그 줄 글자도 바꾸고(서식 유지), 없으면 본문은 손대지 않는다', () => {
  const linked = doc({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '옛 이름', marks: [{ type: 'bold' }] }] }, p('본문'));
  const out = renameDoc(linked, '옛 이름', '새 이름');
  assert.deepEqual(out.content[0], { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '새 이름', marks: [{ type: 'bold' }] }] });
  assert.deepEqual(out.content[1], p('본문'));
  assert.equal(headText(out.content[0]), '새 이름');
  const imported = doc(h('첫 미팅'), p('x'));
  assert.equal(renameDoc(imported, '영업 플레이북', '영업 안내'), imported, '이관 페이지는 이름만 바뀐다');
});

test('입력한 이름 정리: 앞뒤 빈칸·줄바꿈 정리, 500자까지, 비면 바꾸지 않는다', () => {
  assert.equal(cleanTitle('  주간\n회의  '), '주간 회의');
  assert.equal(cleanTitle('   '), null);
  assert.equal(cleanTitle('가'.repeat(600)).length, 500);
});

test('줄바꿈이 든 제목: 예전 규칙(줄바꿈 = 빈 글자)으로 붙은 이름도 제목 줄로 본다', () => {
  // 예전 편집기는 줄바꿈을 ''로 이어 이름을 만들었다 — 새 규칙(' ')만 보면 기존 페이지의 연결이 끊겼다(16차 검수 LOW 4)
  const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '분기' }, { type: 'hardBreak' }, { type: 'text', text: '계획' }] }] };
  assert.equal(titleLinked(doc, '분기계획'), true);
  assert.equal(titleLinked(doc, '분기 계획'), true);
  assert.equal(titleLinked(doc, '다른 이름'), false);
});

test('복제: 원본의 제목 줄이 이어져 있으면 사본 첫 줄도 사본 이름으로 — 사본에서도 첫 줄을 고치면 이름이 따라간다', async () => {
  const src = readFileSync(new URL('../src/core/store.js', import.meta.url), 'utf8');
  assert.match(src, /content: x === id \? renameDoc\(p\.content, p\.title, title\) : p\.content/);
  const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '회의록' }] }, { type: 'paragraph' }] };
  const copy = renameDoc(doc, '회의록', '회의록 (사본)');
  assert.equal(titleLinked(copy, '회의록 (사본)'), true);
});
