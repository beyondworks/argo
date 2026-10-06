// 노션식 블록 고르기와 부분 가림(유건 9/29). 끌어 사각형을 그리면 걸친 블록을 고르고, 우클릭으로 가리기·해제·복사·삭제.
// 11차(유건 10/2): 사각형은 오피스 공용 선택 상자(core/selection.js·ui/marquee.js) — 여백만이 아니라 어디서든, 글자 선택으로 시작했다가 처음 블록 밖으로 나가면 블록 고르기.
// 편집기는 그 선택 상자에 '블록 묶음'으로 붙는다: 항목 key = 맨 위 블록의 문서 위치(blockKeys·keysRange), 고른 블록은 이어진 한 범위(pickKey).
// 가림은 문서의 표시(mark)로 저장된다 — 공유받은 사람도 가려진 채로 보고, 누르고 있는 동안만 보인다(CSS :active).
// 화면에서 덮는 것이지 접근을 막는 것이 아니다. 내용 자체를 숨기려면 블록 메뉴의 '비공개'를 쓴다.
import { Mark, Extension } from '@tiptap/react'; // 코어는 react 패키지가 다시 내보낸다(따로 의존성을 늘리지 않는다)
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const RedactMark = Mark.create({
  name: 'redact', inclusive: false,
  parseHTML: () => [{ tag: 'span[data-redact]' }],
  renderHTML: () => ['span', { 'data-redact': '', class: 'redact-text' }, 0],
});

/** 사각형(화면 좌표)과 같은 높이에 걸친 블록 — 첫 블록 시작부터 마지막 블록 끝까지, 없으면 null.
 *  끌기는 여백에서만 시작하므로 가로는 보지 않는다(여백만 훑어도 옆 블록이 골라진다) */
export function pickRange(blocks, box) {
  const hit = blocks.filter(({ rect }) => rect.bottom > box.top && rect.top < box.bottom);
  return hit.length ? { from: hit[0].from, to: hit.at(-1).to } : null;
}

/** 고른 범위 → 그 안 맨 위 블록 key(문서 위치 문자열) */
export function blockKeys(doc, range) {
  const out = new Set();
  if (range) doc.forEach((node, offset) => { if (offset >= range.from && offset + node.nodeSize <= range.to) out.add(String(offset)); });
  return out;
}
/** 블록 key들 → 첫 블록 시작부터 마지막 블록 끝까지(이어진 한 범위). 없는 key는 건너뛰고, 남는 것이 없으면 null */
export function keysRange(doc, keys) {
  let from = null, to = null;
  doc.forEach((node, offset) => { if (keys.has(String(offset))) { from ??= offset; to = offset + node.nodeSize; } });
  return from == null ? null : { from, to };
}

/** 범위 안 글자 중 표시를 받을 수 있는 글자가 가려져 있는지 — any: 하나라도, all: 전부 */
export function redactStatus(doc, from, to) {
  const type = doc.type.schema.marks.redact;
  let seen = 0, hidden = 0;
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText || !parent.type.allowsMarkType(type)) return;
    seen += 1;
    if (type.isInSet(node.marks)) hidden += 1;
  });
  return { any: hidden > 0, all: seen > 0 && hidden === seen };
}

export const setRedact = (tr, from, to, on) => {
  const type = tr.doc.type.schema.marks.redact;
  return on ? tr.addMark(from, to, type.create()) : tr.removeMark(from, to, type);
};

export const pickKey = new PluginKey('blockPick');
/** 고르기를 풀고 글자 선택도 at(고른 범위 끝) 자리로 접는다 — 파란 칸이 사라진 뒤 글자 선택 하이라이트가 남지 않게(유건 9/29).
 *  글자 자리만 찾는다(textOnly) — TextSelection.near는 바로 앞 구분선·모듈 같은 원자 블록을 NodeSelection으로 다시 골라 파란 띠가 남았다 */
export const unpick = (tr, at) => {
  const $at = tr.doc.resolve(Math.min(tr.mapping.map(at), tr.doc.content.size));
  return tr.setSelection(Selection.findFrom($at, -1, true) ?? Selection.findFrom($at, 1, true) ?? Selection.atStart(tr.doc)).setMeta(pickKey, null);
};
export const pickPlugin = () => new Plugin({
  key: pickKey,
  state: {
    init: () => null,
    apply(tr, value, old) {
      const meta = tr.getMeta(pickKey);
      if (meta !== undefined) return meta;
      if (!value || tr.docChanged || (tr.selectionSet && !tr.selection.eq(old.selection))) return null;
      return value;
    },
  },
  props: {
    decorations(state) {
      const range = pickKey.getState(state);
      if (!range) return null;
      const marks = [];
      state.doc.forEach((node, offset) => { if (offset >= range.from && offset + node.nodeSize <= range.to) marks.push(Decoration.node(offset, offset + node.nodeSize, { class: 'block-picked' })); });
      return DecorationSet.create(state.doc, marks);
    },
    attributes: (state) => (pickKey.getState(state) ? { class: 'picking' } : {}),
  },
});
export const BlockPick = Extension.create({ name: 'blockPick', addProseMirrorPlugins: () => [pickPlugin()] });

/** 최상위 블록의 문서 위치와 화면 사각형 */
export function blockRects(view) {
  const blocks = [];
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset);
    if (dom?.getBoundingClientRect) blocks.push({ from: offset, to: offset + node.nodeSize, rect: dom.getBoundingClientRect() });
  });
  return blocks;
}

/** 우클릭 메뉴가 다룰 범위 — 고른 블록(파랗게 보임) 또는 초점이 있을 때의 글자 선택, 그리고 우클릭 자리가 그 안일 때만.
 *  초점을 잃은 편집기의 선택은 화면에서 사라져도 상태에 남는다 — 그걸 쓰면 보이지 않는 곳이 가려지거나 지워진다(분리 검수 H1) */
export function menuRange(state, { focused, pos }) {
  const pick = pickKey.getState(state), sel = state.selection;
  const range = pick ? { ...pick, picked: true } : focused && !sel.empty ? { from: sel.from, to: sel.to, picked: false } : null;
  return range && pos != null && pos >= range.from && pos <= range.to ? range : null;
}
