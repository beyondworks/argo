// 크루 카드 편집 자유도(유건 지시 2026-09-07 "카드에서 일하는 방식이 수정이 안 되고, 크루한테 말해도 불가능하다고 한다"):
//  · persona.setAgentRules — "일하는 방식" 규칙을 통째로 교체(수정·삭제·순서), frontmatter·다른 섹션 불변, 섹션 경계 빈 줄 정규화
//  · persona.setAgentSection — "## 제목" 한 섹션 교체·생성·삭제(빈 body)
//  · API PATCH { rules } / { section, body } 배선, 크루 도구 update_profile에 rules·section·body, 승인 시 applyPayload가 같은 함수로 적용
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-cardedit-'));
const { setAgentRules, setAgentSection, listAgentSections, readAgentCard } = await import('../src/persona.mjs');
const { paths } = await import('../src/workspace.mjs');
const ws = 'w1';
const CARD = '---\nname: 알파\nslug: a\nrole: r\nrunner: claude\nmodel: m1\nskills: x,y\n---\n\n# 알파 — r\n\n## 전문성\n- 하나\n\n## 일하는 방식\n- 규칙1\n- 규칙2\n\n## 소통\n짧게.\n';
async function seed() { await mkdir(paths(ws).agents, { recursive: true }); await writeFile(join(paths(ws).agents, 'a.md'), CARD); }
const md = async () => (await readAgentCard(ws, 'a')).md;

test('setAgentRules: 수정·삭제·순서가 한 번에, frontmatter(runner/model/skills)·다른 섹션은 그대로', async () => {
  await seed();
  const r = await setAgentRules(ws, 'a', ['규칙2', '규칙1 고침', '새 규칙']);
  assert.deepEqual(r.rules, ['규칙2', '규칙1 고침', '새 규칙']);
  const out = await md();
  assert.match(out, /^runner: claude$/m); assert.match(out, /^model: m1$/m); assert.match(out, /^skills: x,y$/m);
  assert.match(out, /## 전문성\n- 하나\n\n## 일하는 방식\n- 규칙2\n- 규칙1 고침\n- 새 규칙\n\n## 소통\n짧게\.\n$/);
});

test('setAgentRules: 빈 배열이면 섹션은 남고 규칙만 비운다 / 섹션이 없으면 만든다 / 공백·빈 항목 세척', async () => {
  await seed();
  await setAgentRules(ws, 'a', []);
  assert.match(await md(), /## 일하는 방식\n\n## 소통/);
  await writeFile(join(paths(ws).agents, 'a.md'), CARD.replace(/## 일하는 방식\n- 규칙1\n- 규칙2\n\n/, ''));
  const r = await setAgentRules(ws, 'a', ['  a  b ', '', '  ']);
  assert.deepEqual(r.rules, ['a b']);
  assert.match(await md(), /## 소통\n짧게\.\n\n## 일하는 방식\n- a b\n$/);
});

test('setAgentSection: 교체·생성·삭제, 제목의 "## " 관용, 빈 제목 거절', async () => {
  await seed();
  await setAgentSection(ws, 'a', '## 소통', '길게.\n근거를 붙여서.');
  assert.match(await md(), /## 소통\n길게\.\n근거를 붙여서\.\n$/);
  await setAgentSection(ws, 'a', '산출물 형식', '- PDF');
  assert.deepEqual(await listAgentSections(ws, 'a'), ['전문성', '일하는 방식', '소통', '산출물 형식']);
  await setAgentSection(ws, 'a', '전문성', '');
  assert.deepEqual(await listAgentSections(ws, 'a'), ['일하는 방식', '소통', '산출물 형식']);
  await assert.rejects(setAgentSection(ws, 'a', '  ', 'x'), /제목/);
  await assert.rejects(setAgentSection(ws, 'zzz', '소통', 'x'), /존재하지 않는/);
});

test('코드펜스 안의 "## "는 섹션 경계가 아니다(카드에 예시 문서를 붙여도 가짜 섹션·손상 없음), frontmatter 뒤 빈 줄 보존', async () => {
  await seed();
  await writeFile(join(paths(ws).agents, 'a.md'), '---\nname: 알파\nslug: a\n---\n\n## 전문성\n예시:\n```md\n## 펜스 안 제목\n- x\n```\n~~~\n## 물결 펜스\n~~~\n\n## 일하는 방식\n- 규칙1\n');
  assert.deepEqual(await listAgentSections(ws, 'a'), ['전문성', '일하는 방식']);
  await setAgentRules(ws, 'a', ['규칙1', '규칙2']);
  const out = await md();
  assert.match(out, /^---\nname: 알파\nslug: a\n---\n\n## 전문성\n예시:\n```md\n## 펜스 안 제목\n- x\n```\n~~~\n## 물결 펜스\n~~~\n\n## 일하는 방식\n- 규칙1\n- 규칙2\n$/);
});

test('배선 핀: API PATCH·크루 도구·승인 적용이 같은 함수를 쓴다, 화면은 규칙 편집·삭제·순서를 PATCH { rules }로', async () => {
  const route = await readFile(new URL('../app/api/companies/[ws]/agents/[slug]/route.js', import.meta.url), 'utf8');
  assert.match(route, /if \(Array\.isArray\(rules\)\) \{ const meta = await setAgentRules\(ws, slug, rules\);/);
  assert.match(route, /if \(section !== undefined\) \{ const meta = await setAgentSection\(ws, slug, section, body\);/);
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(chat, /rules: z\.array\(z\.string\(\)\)\.optional\(\)/, 'update_profile에 rules');
  assert.match(chat, /section: z\.string\(\)\.optional\(\)[^\n]*\n\s*body: z\.string\(\)\.optional\(\)/, 'update_profile에 section+body');
  assert.match(chat, /불가능하다고 답하지 말고 이 도구로 결재를 올려라/, '크루가 "불가능"이라 답하던 것을 도구 설명이 막는다');
  assert.match(chat, /\.\.\.\(rules \? \{ rules \} : \{\}\), \.\.\.\(sectionEdit \? sectionEdit : \{\}\)/, 'payload에 실린다');
  const aa = await readFile(new URL('../src/approval-actions.mjs', import.meta.url), 'utf8');
  assert.match(aa, /if \(Array\.isArray\(p\.rules\)\) after = await setAgentRules\(wsId, p\.slug, p\.rules\);/);
  assert.match(aa, /if \(typeof p\.section === 'string' && p\.section\.trim\(\)\) after = await setAgentSection\(wsId, p\.slug, p\.section, p\.body \?\? ''\);/);
  const page = await readFile(new URL('../app/c/[ws]/crew/[slug]/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /body: JSON\.stringify\(\{ rules: next \}\)/, '화면 저장은 PATCH { rules }');
  assert.match(page, /saveRules\(rules\.filter\(\(_, j\) => j !== i\)\)/, '삭제');
  assert.match(page, /saveRules\(moveItem\(rules, i, -1\)\)/, '순서');
  assert.match(page, /onClick=\{\(\) => setRuleEdit\(\{ i, text: r \}\)\}/, '클릭 편집');
  const i18n = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const k of ['chat.card.ruleEdit', 'chat.card.ruleDelete', 'chat.card.ruleUp', 'chat.card.ruleDown', 'chat.card.rulesHint']) assert.ok(i18n.includes(`'${k}': ['`), `${k} ko/en`);
});
