// 작은 마크다운 읽기(평가 레포트 총평·업무내용용) — HTML 문자열을 만들지 않고 블록·글자 조각만 돌려준다(그리기는 ui/Markdown.jsx가 React 요소로).
// 다루는 것: # 제목(1~3), - · * 목록, 1. 번호 목록, | 표 |, > 인용, 빈 줄로 나눈 문단, **굵게**, `코드`. 나머지는 글자 그대로.

/** 한 줄 안 꾸밈 → [{ t: 'text'|'bold'|'code', v }] */
export function inline(s) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let at = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > at) out.push({ t: 'text', v: s.slice(at, m.index) });
    out.push(m[1] != null ? { t: 'bold', v: m[1] } : { t: 'code', v: m[2] });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ t: 'text', v: s.slice(at) });
  return out;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
const isRule = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-');

/** 글 → 블록 목록: { type: 'h', level, text } | { type: 'p', lines } | { type: 'ul'|'ol', items } | { type: 'table', head, rows } | { type: 'quote', lines } */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ type: 'h', level: Math.min(3, h[1].length), text: inline(h[2].trim()) }); i++; continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line); const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    if (/^\s*([-*•])\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*([-*•])\s+/).test(lines[i])) { items.push(inline(lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*([-*•])\s+/, ''))); i++; }
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(inline(lines[i].replace(/^\s*>\s?/, ''))); i++; }
      blocks.push({ type: 'quote', lines: q });
      continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])
      && !(/^\s*\|/.test(lines[i]) && i + 1 < lines.length && isRule(lines[i + 1]))) { p.push(inline(lines[i])); i++; }
    blocks.push({ type: 'p', lines: p });
  }
  return blocks;
}
