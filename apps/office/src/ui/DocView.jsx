// 문서 본문을 읽기 전용으로 — 공개 화면·기록판 첨부·버전 미리 보기 공용.
// HTML 문자열을 쓰지 않고 노드를 React 요소로만 만든다(유건 규칙). Misc.jsx에서 옮김 —
// Records.jsx·Dialogs.jsx가 정적으로 쓰므로 첫 화면에 남고, Misc.jsx(설정·휴지통·공개 화면)는 지연 로드된다.
const TAG = { paragraph: 'p', bulletList: 'ul', orderedList: 'ol', taskList: 'ul', listItem: 'li', taskItem: 'li', blockquote: 'blockquote', codeBlock: 'pre' };

function Node({ n }) {
  if (n.type === 'text') {
    let el = n.text;
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') el = <strong>{el}</strong>;
      else if (m.type === 'italic') el = <em>{el}</em>;
      else if (m.type === 'code') el = <code>{el}</code>;
      else if (m.type === 'redact') el = <span data-redact="" className="redact-text">{el}</span>; // 가린 글자 — 누르고 있는 동안만 보인다(base.css)
      else if (m.type === 'link' && /^https?:\/\//.test(m.attrs?.href ?? '')) el = <a href={m.attrs.href} rel="noopener nofollow" target="_blank">{el}</a>;
    }
    return el;
  }
  if (n.type === 'hardBreak') return <br />;
  if (n.type === 'horizontalRule') return <hr />;
  const kids = (n.content ?? []).map((c, i) => <Node key={i} n={c} />);
  if (n.type === 'heading') { const H = `h${Math.min(3, Math.max(1, n.attrs?.level ?? 1))}`; return <H>{kids}</H>; }
  const Tag = TAG[n.type];
  return Tag ? <Tag>{kids}</Tag> : <>{kids}</>;
}

export const DocView = ({ doc }) => (doc?.content ?? []).map((n, i) => <Node key={i} n={n} />);
