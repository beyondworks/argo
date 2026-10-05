// 편집기 붙여넣기 정리(16차, 인트라넷 workboard-editor 붙여넣기 대응 + 그 이상) — 순수 함수만(화면 없음). 편집기는 Editor.jsx가 이어 붙이고, 규칙 시험은 test/paste.test.mjs.
//   ① 노션·구글 문서·다른 도구의 체크리스트 HTML → 할 일 목록: HTML 단계에서는 체크 상자를 '[x] '·'[ ] ' 글자로만 바꾸고(markHtmlCheckboxes),
//      편집기가 읽은 뒤의 문서 조각에서 그 글자로 시작하는 목록·문단을 할 일 목록으로 바꾼다(normalizeSlice). HTML을 직접 고치지 않아 노드에서도 시험할 수 있다.
//   ② 구분선 글자(---·───)만 있는 줄 → 구분선.
//   ③ 서식 없는 글(text/plain)이 마크다운처럼 보이면 → 제목·목록(들여쓰기 = 하위)·체크·인용·코드·표·구분선·굵게·기울임·링크로(markdownSlice).
import { Fragment, Slice } from '@tiptap/pm/model';
import { parseMarkdown, inline, RULE } from '../core/markdown.js';

/* ── ① HTML의 체크 상자 → 글자 표시 ── */
const OWN = /data-type=["']?task(List|Item)/i;                                  // 이 편집기(tiptap)에서 복사한 할 일 목록은 그대로 읽힌다
/** HTML 문자열 → 체크 상자 자리에 '[x] '·'[ ] ' 글자를 둔 HTML. 체크 상자가 없으면 그대로 */
export function markHtmlCheckboxes(html) {
  if (!html || OWN.test(html) || !/checkbox|☐|☑/i.test(html)) return html;
  return html
    .replace(/<input\b[^>]*\btype\s*=\s*["']?checkbox\b[^>]*>/gi, (tag) => (/\schecked\b/i.test(tag) ? '[x] ' : '[ ] '))
    .replace(/<(div|span|i)\b[^>]*\bclass\s*=\s*["'][^"']*\bcheckbox\b[^"']*["'][^>]*>\s*<\/\1>/gi, (tag) => (/checkbox-on|\bchecked\b/i.test(tag) ? '[x] ' : '[ ] ')) // 노션: <div class="checkbox checkbox-on"></div>
    .replace(/<([a-z][\w-]*)\b[^>]*\brole\s*=\s*["']checkbox["'][^>]*>/gi, (tag) => `${tag}${/aria-checked\s*=\s*["']true["']/i.test(tag) ? '[x] ' : '[ ] '}`); // 구글 문서: <li role="checkbox" aria-checked="true">
}

/* ── ①② 읽은 문서 조각 정리 ── */
const BOX = /^\s*(\[[ xX]\]|[☐☑✅✔✓□▢⬜])\s*/;
const ON = /^\s*(\[[xX]\]|[☑✅✔✓])/;
/** 문단 첫 글자가 체크 표시면 true(켜짐)·false(꺼짐), 아니면 null */
const boxOf = (para) => (para?.type.name === 'paragraph' && BOX.test(para.textContent) ? ON.test(para.textContent) : null);
/** 문단 앞의 체크 표시를 뺀다(첫 글자 노드에서만) */
function stripBox(para) {
  let done = false;
  const kids = [];
  para.content.forEach((n) => {
    if (!done && n.isText) {
      const rest = n.text.replace(BOX, '');
      done = true;
      if (rest) kids.push(n.type.schema.text(rest, n.marks));
    } else kids.push(n);
  });
  return para.copy(Fragment.from(kids));
}
const isRuleText = (node) => node.type.name === 'paragraph' && node.childCount > 0 && RULE.test(node.textContent) && node.content.content.every((n) => n.isText);

function taskItem(schema, item, checked) {
  const [first, ...rest] = item.content.content;
  return schema.nodes.taskItem.create({ checked }, [first?.type.name === 'paragraph' ? stripBox(first) : schema.nodes.paragraph.create(), ...rest.map((n) => fixNode(schema, n))]);
}
/** 노드 하나 정리(안쪽까지) */
function fixNode(schema, node) {
  const { bulletList, orderedList, taskList, taskItem: ti } = schema.nodes;
  if (taskList && ti && (node.type === bulletList || node.type === orderedList) && node.content.content.some((li) => boxOf(li.firstChild) != null)) {
    return taskList.create(null, node.content.content.map((li) => taskItem(schema, li, !!boxOf(li.firstChild))));
  }
  if (node.isLeaf || node.isTextblock) return node;
  const fixed = fixFragment(schema, node.content, false, false);
  return node.type.validContent(fixed) ? node.copy(fixed) : node; // 첫 줄이 정해진 블록(토글 등)에 맞지 않으면 그대로(16차 검수 LOW 2)
}
/** 조각 정리 — openStart·openEnd 쪽 끝 노드는 혼자서는 구조를 바꾸지 않는다(열린 조각의 깊이가 어긋나지 않게).
 *  가운데 줄이 든 체크 묶음은 끝 줄까지 같이 할 일로 바꾸고 그쪽 끝을 닫았다고 closed에 적는다(섞여 남지 않게, 16차 검수 LOW 1) */
function fixFragment(schema, frag, openStart, openEnd, closed = {}) {
  const out = [];
  const nodes = frag.content;
  const edge = (i) => (i === 0 && openStart) || (i === nodes.length - 1 && openEnd);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!edge(i) && isRuleText(n) && schema.nodes.horizontalRule) { out.push(schema.nodes.horizontalRule.create()); continue; }
    // 체크 표시로 시작하는 문단이 이어지면 할 일 목록 하나로(구분 없이 글만 붙여 넣은 체크리스트)
    if (boxOf(n) != null && schema.nodes.taskList) {
      let j = i;
      while (j < nodes.length && boxOf(nodes[j]) != null) j++;
      const run = nodes.slice(i, j);
      if (run.some((_, k) => !edge(i + k))) {
        if (edge(i)) closed.start = true;
        if (edge(j - 1)) closed.end = true;
        out.push(schema.nodes.taskList.create(null, run.map((p) => schema.nodes.taskItem.create({ checked: !!boxOf(p) }, [stripBox(p)]))));
        i = j - 1;
        continue;
      }
    }
    out.push(fixNode(schema, n));
  }
  return Fragment.from(out);
}
/** 붙여 넣은 문서 조각 → 체크리스트·구분선을 고친 조각 */
export function normalizeSlice(slice, schema) {
  const only = slice.content.childCount === 1 && slice.content.firstChild;
  if (only && isRuleText(only) && schema.nodes.horizontalRule) return new Slice(Fragment.from(schema.nodes.horizontalRule.create()), 0, 0); // 구분선 한 줄만 붙여 넣었다
  const closed = {};
  const frag = fixFragment(schema, slice.content, slice.openStart > 0, slice.openEnd > 0, closed);
  return new Slice(frag, closed.start ? 0 : slice.openStart, closed.end ? 0 : slice.openEnd);
}

/* ── ③ 마크다운 글 → 편집기 문서 ── */
const MARK = { bold: 'bold', italic: 'italic', strike: 'strike', code: 'code' };
/** 글자 조각 → 편집기 글자 노드(JSON) */
export const textNodes = (parts) => parts.filter((p) => p.v).map((p) => (p.t === 'link' ? { type: 'text', text: p.v, marks: [{ type: 'link', attrs: { href: p.href } }] }
  : MARK[p.t] ? { type: 'text', text: p.v, marks: [{ type: MARK[p.t] }] } : { type: 'text', text: p.v }));
const para = (parts) => { const c = textNodes(parts); return c.length ? { type: 'paragraph', content: c } : { type: 'paragraph' }; };
function listNode(b) {
  const item = (it) => ({ type: b.type === 'tasks' ? 'taskItem' : 'listItem', ...(b.type === 'tasks' ? { attrs: { checked: !!it.checked } } : {}), content: [para(it.text), ...it.children.map(listNode)] });
  return { type: b.type === 'tasks' ? 'taskList' : b.type === 'ol' ? 'orderedList' : 'bulletList', ...(b.type === 'ol' && b.start > 1 ? { attrs: { start: b.start } } : {}), content: b.items.map(item) };
}
/** 마크다운 글 → 편집기 블록 JSON 목록. 문단의 줄은 줄마다 한 블록(노션처럼) */
export function markdownToNodes(text) {
  return parseMarkdown(text).flatMap((b) => {
    if (b.type === 'h') { const c = textNodes(b.text); return [{ type: 'heading', attrs: { level: b.level }, ...(c.length ? { content: c } : {}) }]; }
    if (b.type === 'p') return b.lines.map(para);
    if (b.type === 'ul' || b.type === 'ol' || b.type === 'tasks') return [listNode(b)];
    if (b.type === 'quote') return [{ type: 'blockquote', content: b.lines.map(para) }];
    if (b.type === 'code') return [{ type: 'codeBlock', attrs: { language: b.lang }, ...(b.text ? { content: [{ type: 'text', text: b.text }] } : {}) }];
    if (b.type === 'hr') return [{ type: 'horizontalRule' }];
    if (b.type === 'table') {
      const width = Math.max(b.head.length, ...b.rows.map((r) => r.length));
      const row = (cells, cell) => ({ type: 'tableRow', content: Array.from({ length: width }, (_, k) => ({ type: cell, content: [para(cells[k] ?? [])] })) });
      return [{ type: 'table', content: [row(b.head, 'tableHeader'), ...b.rows.map((r) => row(r, 'tableCell'))] }];
    }
    return [];
  });
}

// 마크다운 신호 — 줄 머리의 제목·목록·체크·인용·코드 울타리·구분선·표, 또는 굵게·링크 같은 글자 꾸밈.
// 번호 목록은 두 줄 이상 이어질 때만 신호로 본다 — '10. 4. 회의' 같은 날짜 한 줄이 번호 목록이 되지 않게
const BLOCKISH = /(^|\n)[ \t]*(#{1,6}\s|[-*+•]\s|>\s?|```|(-{3,}|\*{3,}|_{3,}|─{3,})[ \t]*(\n|$)|\[[ xX]\]\s|[☐☑✅✔✓□▢⬜]\s|\|.+\|)/;
const NUMBERED = /(^|\n)[ \t]*\d{1,3}[.)]\s.*\n[ \t]*\d{1,3}[.)]\s/;
/** 서식 없는 글이 마크다운으로 보이는가 — 아니면 편집기 기본 붙여넣기에 맡긴다 */
export function looksMarkdown(text) {
  if (!text || !text.trim()) return false;
  if (BLOCKISH.test(text) || NUMBERED.test(text)) return true;
  return inline(text).some((p) => p.t !== 'text' && !(p.t === 'link' && p.v === p.href)); // 맨 주소만 있는 글은 링크 확장이 링크로 만든다([글](주소)는 마크다운)
}
/** 붙여넣기용 조각 — 앞뒤가 문단이면 열어 둬서 지금 줄에 이어 붙는다(기본 글 붙여넣기와 같은 느낌) */
export function markdownSlice(text, schema) {
  const nodes = markdownToNodes(text).map((n) => schema.nodeFromJSON(n));
  if (!nodes.length) return null;
  const frag = Fragment.fromArray(nodes);
  return new Slice(frag, nodes[0].type.name === 'paragraph' ? 1 : 0, nodes.at(-1).type.name === 'paragraph' ? 1 : 0);
}
/** HTML에 블록 구조가 있으면 HTML 경로(노션·문서 도구), 없으면(코드 편집기·메모장의 줄 글) 마크다운 경로를 쓴다 */
// data-pm-slice = 편집기(ProseMirror)에서 복사한 조각, data-toggle·callout·columns·private-block = 이 편집기의 블록 — 문서 조각 그대로 붙인다(16차 검수 M2)
export const htmlHasBlocks = (html) => !!html && (/<(ul|ol|li|h[1-6]|hr|blockquote|pre|table|input|details)\b/i.test(html) || /\sdata-(pm-slice|toggle|callout|columns?|private-block)\b/i.test(html));
