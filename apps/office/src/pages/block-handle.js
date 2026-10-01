// 블록 끌기 손잡이의 자리와 "무엇이 움직이는지" 표시(유건 10/1).
// 손잡이는 블록의 첫 줄 가운데에 선다 — 블록 상자 위쪽 끝에 붙이면 구분선은 선 아래에 매달리고, 제목·인용·코드는 첫 줄보다 위로 뜬다.
import { Extension } from '@tiptap/react'; // 코어는 react 패키지가 다시 내보낸다(따로 의존성을 늘리지 않는다)
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** 손잡이 자리 — 기준 상자(첫 줄)의 왼쪽, 세로 가운데. 모듈 상수여야 한다: 손잡이 래퍼가 이 값이 바뀌면 플러그인을 다시 등록한다 */
export const HANDLE_POSITION = Object.freeze({ placement: 'left', strategy: 'absolute' });
/** 원자 블록(모듈·비공개)에서 첫 줄로 보는 줄 — 모듈 카드 머리줄, 비공개 배지 줄, 모듈을 못 그릴 때의 안내 한 줄(먼저 나오는 것) */
export const HEAD_SELECTOR = '.module-head, .private-head, .mod-empty';
const BAND = 26; // 머리줄이 없는 큰 원자 블록의 첫 줄 높이 — 본문 한 줄(15px × 1.75)

/** 노드 안 첫 글 블록(문단·제목·코드)의 위치(그 블록 바로 앞). 글 블록이 없으면(구분선·모듈·비공개) null */
export function firstTextblockPos(node, pos) {
  if (node.isTextblock) return pos;
  if (node.isAtom) return null;
  let found = null;
  node.descendants((child, offset) => {
    if (found != null) return false;
    if (child.isTextblock) { found = pos + 1 + offset; return false; }
    return !child.isAtom;
  });
  return found;
}

/** 글 블록의 첫 줄 상자 — 테두리·안쪽 여백 아래부터 줄 높이 하나(블록보다 길어지지 않게) */
export function firstLine(rect, style) {
  const top = rect.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
  const lh = parseFloat(style.lineHeight);
  const height = Number.isFinite(lh) ? lh : (parseFloat(style.fontSize) || 15) * 1.2; // 'normal'
  return { top, height: Math.max(0, Math.min(height, rect.bottom - top)) || height };
}

/** 원자 블록의 첫 줄 — 머리줄이 있으면 그 줄, 없으면 한 줄 높이 이하의 블록(구분선)은 블록 전체, 큰 블록은 위쪽 한 줄 */
export function atomLine(block, head) {
  if (head && head.height > 0) return { top: head.top, height: head.height };
  return { top: block.top, height: block.height <= BAND + 14 ? block.height : BAND };
}

/** 손잡이 기준 상자 — 가로는 블록(손잡이가 블록 왼쪽에 붙는다), 세로는 맞출 줄 */
export function anchorRect(block, line) {
  const top = line ? line.top : block.top;
  const height = line ? line.height : block.height;
  return { x: block.left, y: top, left: block.left, right: block.right, width: block.width, top, bottom: top + height, height };
}

/** 화면에서 잰 손잡이 기준 상자 — 손잡이 플러그인이 자리를 다시 잡을 때마다 부른다 */
export function measureAnchor(view, node, pos, dom) {
  const block = dom.getBoundingClientRect();
  const at = firstTextblockPos(node, pos);
  const el = at == null ? null : view.nodeDOM(at);
  if (el instanceof Element) return anchorRect(block, firstLine(el.getBoundingClientRect(), getComputedStyle(el)));
  return anchorRect(block, atomLine(block, dom.querySelector(HEAD_SELECTOR)?.getBoundingClientRect()));
}

// 손잡이에 마우스를 올린 동안 대상 블록을 옅게 칠한다 — 블록 DOM을 직접 고치면 편집기가 다시 그릴 때 지워지므로 장식(decoration)으로
export const hoverKey = new PluginKey('blockHover');
export const hoverPlugin = () => new Plugin({
  key: hoverKey,
  state: {
    init: () => null,
    // 값: 칠할 블록의 시작 위치. 문서가 바뀌면 지운다(옮기거나 지운 블록에 칠이 남지 않게)
    apply: (tr, cur) => { const m = tr.getMeta(hoverKey); return m !== undefined ? m : tr.docChanged ? null : cur; },
  },
  props: {
    decorations(state) {
      const pos = hoverKey.getState(state);
      const node = pos == null ? null : state.doc.nodeAt(pos);
      return node ? DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: 'block-hover' })]) : null;
    },
  },
});
export const BlockHover = Extension.create({ name: 'blockHover', addProseMirrorPlugins: () => [hoverPlugin()] });
/** 칠하기·지우기 — 같은 값이면 보내지 않는다 */
export function setHover(view, pos) {
  if (view.isDestroyed || (hoverKey.getState(view.state) ?? null) === pos) return;
  view.dispatch(view.state.tr.setMeta(hoverKey, pos).setMeta('addToHistory', false));
}
