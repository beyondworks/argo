// 작은 마크다운 읽기 — HTML 문자열을 만들지 않고 블록·글자 조각만 돌려준다. 그리기는 ui/Markdown.jsx(React 요소), 편집기 붙여넣기는 pages/paste.js(편집기 문서).
// 다루는 것: # 제목(1~3), - · * 목록(들여쓰기 = 하위 목록), 1. 번호 목록, - [ ] 체크 목록, | 표 |, > 인용, ``` 코드 블록, --- 구분선, 빈 줄로 나눈 문단,
// **굵게**, *기울임*, ~~취소선~~, `코드`, [글](주소)·맨 주소 링크(http·https·mailto만). 나머지는 글자 그대로.

const SAFE = /^(https?:\/\/|mailto:)/i;
// 앞에서부터 가장 먼저 나오는 꾸밈 하나 — 코드 · [글](주소) · 굵게 · 취소선 · 기울임 · 맨 주소
// 기울임 *·_ 앞뒤는 글자(한글 포함)가 아니어야 한다 — '보고서_최종_본' 같은 이름이 기울임이 되지 않게
const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(?=\S)([^*\n]+?)\*\*|__(?=\S)([^_\n]+?)__|~~(?=\S)([^~\n]+?)~~|(?<![\p{L}\p{N}*])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]+?)(?<=\S)_(?![\p{L}\p{N}_])|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/gu;

/** 한 줄 안 꾸밈 → [{ t: 'text'|'bold'|'italic'|'strike'|'code'|'link', v, href? }] — 안전하지 않은 주소의 링크는 글자만 남긴다 */
export function inline(s) {
  const out = [];
  const push = (t, v, href) => { if (!v) return; const last = out.at(-1); if (t === 'text' && last?.t === 'text') last.v += v; else out.push(href ? { t, v, href } : { t, v }); };
  let at = 0, m;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(s))) {
    if (m.index > at) push('text', s.slice(at, m.index));
    if (m[1] != null) push('code', m[1]);
    else if (m[2] != null) { if (SAFE.test(m[3])) push('link', m[2], m[3]); else push('text', m[2]); }
    else if (m[4] != null || m[5] != null) push('bold', m[4] ?? m[5]);
    else if (m[6] != null) push('strike', m[6]);
    else if (m[7] != null || m[8] != null) push('italic', m[7] ?? m[8]);
    else push('link', m[9], m[9]);
    at = m.index + m[0].length;
  }
  if (at < s.length) push('text', s.slice(at));
  return out;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
const isRule = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-');
export const RULE = /^\s*(-{3,}|\*{3,}|_{3,}|─{3,}|━{3,})\s*$/;
const FENCE = /^\s*```(.*)$/;
// 목록 한 줄 — 들여쓰기 · 글머리(- * + • 또는 1. 1)) · 체크 상자([ ] [x]) · 글. 글머리 없이 체크 표시(☐ ☑ [x])로 시작하는 줄도 체크 목록
const ITEM = /^(\s*)(?:([-*+•])|(\d{1,9})[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const BOX = /^(\s*)(\[[ xX]\]|[☐☑✅✔✓□▢⬜])\s+(.*)$/;
const CHECKED = /^(\[[xX]\]|[☑✅✔✓])$/;
const isItem = (line) => ITEM.test(line) || BOX.test(line);
const isBlockStart = (lines, i) => {
  const l = lines[i];
  return /^(#{1,6})\s/.test(l) || isItem(l) || /^\s*>/.test(l) || FENCE.test(l) || RULE.test(l) || (/^\s*\|/.test(l) && i + 1 < lines.length && isRule(lines[i + 1]));
};
const indentOf = (s) => s.replace(/\t/g, '  ').length;

/** 이어진 목록 줄 → 목록 블록들. 같은 깊이에서 종류(글머리·번호·체크)가 바뀌면 블록을 나누고, 더 들여 쓴 줄은 바로 앞 항목의 하위 목록이 된다 */
function listBlocks(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const { indent: base, kind } = rows[i];
    const block = { type: kind, items: [] };
    if (kind === 'ol') block.start = rows[i].num;
    while (i < rows.length && rows[i].indent === base && rows[i].kind === kind) {
      let j = i + 1;
      while (j < rows.length && rows[j].indent > base) j++;                        // 더 들여 쓴 줄 = 이 항목의 하위
      const kids = rows.slice(i + 1, j);
      block.items.push({ text: rows[i].text, ...(kind === 'tasks' ? { checked: rows[i].checked } : {}), children: kids.length ? listBlocks(kids) : [] });
      i = j;
    }
    out.push(block);
  }
  return out;
}

/** 글 → 블록 목록:
 *  { type: 'h', level, text } | { type: 'p', lines } | { type: 'ul'|'ol'|'tasks', start?, items: [{ text, checked?, children }] } | { type: 'table', head, rows }
 *  | { type: 'quote', lines } | { type: 'code', lang, text } | { type: 'hr' } */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;                                                                          // 닫는 줄(없으면 끝까지가 코드)
      blocks.push({ type: 'code', lang: fence[1].trim().split(/\s+/)[0] || null, text: code.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ type: 'h', level: Math.min(3, h[1].length), text: inline(h[2].trim()) }); i++; continue; }
    if (RULE.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line); const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    if (isItem(line)) {
      const rows = [];
      for (; i < lines.length && isItem(lines[i]); i++) {
        const m = ITEM.exec(lines[i]);
        // '- ☐ 글'(글머리 뒤 체크 표시)과 글머리 없는 '☐ 글'·'[x] 글'도 체크 목록
        const b = m ? (m[2] && m[4] == null ? BOX.exec(`${m[1]}${m[5]}`) : null) : BOX.exec(lines[i]);
        if (b) rows.push({ indent: indentOf(b[1]), kind: 'tasks', num: null, checked: CHECKED.test(b[2]), text: inline(b[3]) });
        else rows.push({ indent: indentOf(m[1]), kind: m[4] != null ? 'tasks' : m[3] ? 'ol' : 'ul', num: m[3] ? Number(m[3]) : null, checked: m[4] != null ? m[4] !== ' ' : undefined, text: inline(m[5]) });
      }
      const min = Math.min(...rows.map((r) => r.indent));
      blocks.push(...listBlocks(rows.map((r) => ({ ...r, indent: r.indent - min }))));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(inline(lines[i].replace(/^\s*>\s?/, ''))); i++; }
      blocks.push({ type: 'quote', lines: q });
      continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) { p.push(inline(lines[i])); i++; }
    blocks.push({ type: 'p', lines: p });
  }
  return blocks;
}

/** 문서 맨 앞 머리말(--- 사이의 title: 같은 줄)을 뺀다 — 공용 문서 본문이 머리말을 문단으로 보이지 않게 */
export function stripFrontMatter(text) {
  const s = String(text ?? '');
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(s);
  return m && /^[\w-]+\s*:/m.test(m[1]) ? s.slice(m[0].length) : s;
}
