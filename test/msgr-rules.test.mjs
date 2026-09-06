import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-rules-'));
const { paths } = await import('../src/workspace.mjs');
const { loadOrgRules, formatOrgRules, parseRuleDoc, ORG_RULES_CAP } = await import('../src/gateway/msgr-rules.mjs');

const WS = 'lean-r1';
const fm = (title, scope, body) => `---\ntitle: ${JSON.stringify(title)}\norg: lean\nscope: ${scope}\ndoc: d\nversion: 1\nreadonly: true\n---\n\n# ${title}\n\n${body}\n`;

test('parseRuleDoc: frontmatter의 scope·title, 본문의 중복 제목 줄 제거, frontmatter 없으면 전사', () => {
  assert.deepEqual(parseRuleDoc(fm('규칙집', 'org', '- 존댓말')), { scope: 'org', title: '규칙집', body: '- 존댓말' });
  assert.deepEqual(parseRuleDoc(fm('마케팅 규칙', 'channel:marketing', 'CTR은 표로')), { scope: 'channel:marketing', title: '마케팅 규칙', body: 'CTR은 표로' });
  assert.deepEqual(parseRuleDoc('그냥 본문'), { scope: 'org', title: '', body: '그냥 본문' });
});

test('formatOrgRules: 전사 → 채널 순, 다른 채널 규칙 제외, 규칙 없으면 빈 문자열, 4KB 상한 초과는 앞부분+안내', () => {
  const docs = [
    { scope: 'channel:marketing', title: 'M', body: 'M-body' },
    { scope: 'org', title: '규칙집', body: '- 존댓말' },
    { scope: 'channel:design', title: 'D', body: 'D-body' },
  ];
  const out = formatOrgRules(docs, { org: 'lean', channelName: 'marketing' });
  assert.match(out, /^\n\n## 조직 규칙 \(팀 메신저 조직 "lean"의 정본 — 반드시 따른다\. 우선순위: 전사 > 채널 > 크루 페르소나/);
  assert.ok(out.indexOf('### 전사: 규칙집\n- 존댓말') < out.indexOf('### 채널 #marketing: M\nM-body'), '전사가 채널보다 먼저');
  assert.doesNotMatch(out, /D-body/, '다른 채널 규칙은 안 싣는다');
  assert.equal(formatOrgRules([{ scope: 'channel:design', title: 'D', body: 'x' }], { org: 'lean', channelName: 'marketing' }), '', '해당 없으면 빈 문자열');
  const big = formatOrgRules([{ scope: 'org', title: 'L', body: 'x'.repeat(6000) }], { org: 'lean' });
  assert.ok(big.length <= ORG_RULES_CAP, `상한 ${big.length}`); assert.match(big, /앞부분만 실었다 — 전체는 vault\/org\/ 아래/);
  assert.match(formatOrgRules(docs, { org: 'lean', channelName: 'marketing', lang: 'en' }), /## Organization rules \(team messenger "lean"/);
});

test('loadOrgRules: 미러 rules/ 폴더를 읽어 블록으로, 미러 없으면 빈 문자열(턴을 죽이지 않는다)', async () => {
  assert.equal(await loadOrgRules(WS, 'lean', { channelName: 'general' }), '');
  const dir = join(paths(WS).org, 'lean', 'rules'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'handbook.md'), fm('규칙집', 'org', '- 답은 존댓말로.'));
  await writeFile(join(dir, 'general-rules.md'), fm('general 규칙', 'channel:general', '- 공지는 굵게.'));
  await writeFile(join(dir, 'other.md'), fm('다른 채널', 'channel:marketing', '- 표.'));
  const out = await loadOrgRules(WS, 'lean', { channelName: 'general' });
  assert.match(out, /### 전사: 규칙집\n- 답은 존댓말로\./); assert.match(out, /### 채널 #general: general 규칙\n- 공지는 굵게\./); assert.doesNotMatch(out, /표\./);
  assert.equal(await loadOrgRules(WS, '', {}), '');
  await rm(paths(WS).org, { recursive: true, force: true });
});
