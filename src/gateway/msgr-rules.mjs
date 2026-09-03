// G-3 조직 규칙 주입(부록 G·H): 팀 메신저 조직의 규칙집(rules/)을 크루 턴 프롬프트에 항상 붙인다. 검색은 놓칠 수 있지만 규칙은 강제여야 한다.
// 원천은 G-2 미러(vault/org/<org-slug>/rules/*.md — 서버 정본의 읽기 전용 사본). 범위: 전사(scope: org) → 그 채널(scope: channel:<name>).
// 상한 4KB — 넘으면 앞부분만 싣고 "전체는 미러 검색" 안내. 정책 항목이라 소유자가 끌 수 없다(chat()이 mirrorCtx로 스스로 붙인다).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../workspace.mjs';

export const ORG_RULES_CAP = 4096;

/** frontmatter의 scope·title만 뽑는다(정식 YAML 파서 불필요 — renderOrgDoc이 쓴 형식 그대로). */
export function parseRuleDoc(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { scope: 'org', title: '', body: text.trim() };
  const fm = Object.fromEntries(m[1].split('\n').map((l) => { const i = l.indexOf(':'); return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  let title = fm.title ?? ''; try { title = JSON.parse(title); } catch { /* 따옴표 없는 제목 */ }
  return { scope: fm.scope || 'org', title, body: text.slice(m[0].length).replace(/^\s*#\s[^\n]*\n+/, '').trim() }; // 본문 첫 줄의 '# 제목'은 중복이라 뺀다
}

export function formatOrgRules(docs, { org = '', channelName = '', lang = 'ko', cap = ORG_RULES_CAP } = {}) {
  const orgDocs = docs.filter((d) => d.scope === 'org');
  const chDocs = channelName ? docs.filter((d) => d.scope === `channel:${channelName}`) : [];
  if (!orgDocs.length && !chDocs.length) return '';
  const head = lang === 'en'
    ? `\n\n## Organization rules (team messenger "${org}" — binding. Priority: company-wide > channel > your persona; safety and tone rules above win, work-method rules below add detail)\n`
    : `\n\n## 조직 규칙 (팀 메신저 조직 "${org}"의 정본 — 반드시 따른다. 우선순위: 전사 > 채널 > 크루 페르소나. 안전·표현 규칙은 위가 이기고, 업무 방식은 아래가 구체화한다)\n`;
  const sec = (label, d) => `\n### ${label}: ${d.title || '(untitled)'}\n${d.body}\n`;
  let out = head;
  for (const d of orgDocs) out += sec(lang === 'en' ? 'Company-wide' : '전사', d);
  for (const d of chDocs) out += sec(lang === 'en' ? `Channel #${channelName}` : `채널 #${channelName}`, d);
  if (out.length > cap) {
    const note = lang === 'en' ? `\n(… rules truncated at ${cap} chars — read the full set under vault/org/ )\n` : `\n(… 규칙이 ${cap}자를 넘어 앞부분만 실었다 — 전체는 vault/org/ 아래 규칙집을 읽어라)\n`;
    out = out.slice(0, cap - note.length) + note;
  }
  return out;
}

/** 미러 폴더에서 규칙집을 읽어 프롬프트 블록으로. 미러가 없으면 ''(조직 밖 턴·아직 미러 전) — 실패는 조용히 비운다(규칙 주입 실패로 턴을 죽이지 않는다). */
export async function loadOrgRules(wsId, orgSlug, { channelName = '', lang = 'ko', cap = ORG_RULES_CAP } = {}) {
  if (!orgSlug) return '';
  const dir = join(paths(wsId).org, orgSlug, 'rules');
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort(); } catch { return ''; }
  const docs = [];
  for (const n of names) {
    const text = await readFile(join(dir, n), 'utf8').catch(() => null);
    if (text) docs.push(parseRuleDoc(text));
  }
  return formatOrgRules(docs, { org: orgSlug, channelName, lang, cap });
}

/** 문서 경로 슬러그 — 메신저 앱 docSlug와 같은 규칙(영문·숫자만, 한글 제목은 시간 기반). 제안 결재(G-4)가 path를 만들 때 쓴다. */
export const docSlug = (title) => { const s = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); return s || `doc-${Date.now().toString(36)}`; };
export const DOC_FOLDERS = ['rules', 'glossary', 'projects'];
