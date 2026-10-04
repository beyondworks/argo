// 페이지 이름과 본문 첫 줄(16차, PARITY-ALL 1번 표 4행) — 순수 함수만. 편집기(Editor.jsx)와 트리 '이름 바꾸기'(tree-actions.jsx)가 쓰고, 규칙 시험은 test/page-title.test.mjs.
// 규칙: 본문 첫 블록이 제목이고 그 글자가 페이지 이름과 같을 때만 "제목 줄"로 본다(이름이 비었으면 제목 1이면 제목 줄).
//   · 새 페이지(빈 제목 1로 시작)는 첫 줄을 고치면 이름도 바뀐다 — 예전과 같다.
//   · 이관한 페이지처럼 이름과 다른 제목으로 시작하는 본문은 처음 고쳐도 이름이 바뀌지 않는다(예전에는 첫 제목 글자로 바뀌었다).
//   · 트리에서 이름을 바꾸면 제목 줄이 있는 페이지는 그 줄 글자도 같이 바뀐다(둘이 다시 갈라지지 않게).

/** 블록 안 글자(줄바꿈은 빈칸) */
export const headText = (node, br = ' ') => (node?.content ?? []).map((n) => n.text ?? (n.type === 'hardBreak' ? br : '')).join('');
const first = (doc) => doc?.content?.[0];
/** 본문 첫 줄이 이 이름의 제목 줄인가 — 예전 편집기는 줄바꿈을 빈 글자로 이어 이름을 만들었으니 그 이름도 같은 줄로 본다(16차 검수 LOW 4) */
export function titleLinked(doc, title) {
  const h = first(doc);
  if (h?.type !== 'heading') return false;
  const name = String(title ?? '').trim();
  return name ? headText(h).trim() === name || headText(h, '').trim() === name : (h.attrs?.level ?? 1) === 1;
}
/** 편집 뒤 저장할 이름 — 제목 줄이 이어져 있고 첫 블록이 아직 제목이면 그 글자, 아니면 지금 이름 그대로 */
export const nextTitle = (doc, { linked, title }) => (linked && first(doc)?.type === 'heading' ? headText(first(doc)) : title);
/** 이름 바꾸기 — 제목 줄이 있으면 그 줄 글자도 새 이름으로(줄의 서식은 첫 글자의 표시를 따른다). 없으면 본문 그대로 */
export function renameDoc(doc, oldTitle, title) {
  if (!titleLinked(doc, oldTitle)) return doc;
  const [{ content, ...head }, ...rest] = doc.content;
  const marks = content?.find((n) => n.type === 'text')?.marks;
  return { ...doc, content: [{ ...head, ...(title ? { content: [{ type: 'text', text: title, ...(marks ? { marks } : {}) }] } : {}) }, ...rest] };
}
/** 입력한 이름 정리 — 앞뒤 빈칸·줄바꿈을 빼고 500자까지(서버 한도). 비면 null(바꾸지 않는다) */
export const cleanTitle = (raw) => { const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 500); return s || null; };
