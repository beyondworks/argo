// 마크다운 읽기 전용 보기 — core/markdown.js가 나눈 블록을 React 요소로만 그린다(HTML 문자열 없음). 평가 레포트 총평·업무내용·공용 문서 본문용.
// 링크는 새 창(rel noopener·noreferrer)으로, 데스크톱 앱에서는 기본 브라우저로 연다.
import { parseMarkdown } from '../core/markdown.js';
import { isDesktop, openExternal } from '../core/platform.js';
import './markdown.css';

const openLink = (e) => { if (!isDesktop()) return; e.preventDefault(); openExternal(e.currentTarget.href).catch(() => {}); };
const Inline = ({ parts }) => parts.map((p, i) => {
  if (p.t === 'bold') return <strong key={i}>{p.v}</strong>;
  if (p.t === 'italic') return <em key={i}>{p.v}</em>;
  if (p.t === 'strike') return <s key={i}>{p.v}</s>;
  if (p.t === 'code') return <code key={i}>{p.v}</code>;
  if (p.t === 'link') return <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" onClick={openLink}>{p.v}</a>;
  return <span key={i}>{p.v}</span>;
});
const Lines = ({ lines }) => lines.map((l, i) => <span key={i}>{i > 0 && <br />}<Inline parts={l} /></span>);

function List({ b }) {
  const L = b.type === 'ol' ? 'ol' : 'ul';
  return <L className={b.type === 'tasks' ? 'md-tasks' : undefined} start={b.type === 'ol' && b.start > 1 ? b.start : undefined}>{b.items.map((it, j) => (
    <li key={j} className={it.checked ? 'done' : undefined}>
      {b.type === 'tasks' ? <label className="md-task"><input type="checkbox" checked={!!it.checked} readOnly disabled /><span><Inline parts={it.text} /></span></label> : <Inline parts={it.text} />}
      {it.children.map((c, k) => <List key={k} b={c} />)}
    </li>))}</L>;
}

export function Markdown({ text, className = '' }) {
  return <div className={`md ${className}`}>{parseMarkdown(text).map((b, i) => {
    if (b.type === 'h') { const H = `h${b.level}`; return <H key={i}><Inline parts={b.text} /></H>; }
    if (b.type === 'ul' || b.type === 'ol' || b.type === 'tasks') return <List key={i} b={b} />;
    if (b.type === 'quote') return <blockquote key={i}><Lines lines={b.lines} /></blockquote>;
    if (b.type === 'code') return <pre key={i} className="md-code"><code>{b.text}</code></pre>;
    if (b.type === 'hr') return <hr key={i} />;
    if (b.type === 'table') return <div key={i} className="md-table"><table><thead><tr>{b.head.map((c, j) => <th key={j}><Inline parts={c} /></th>)}</tr></thead>
      <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline parts={c} /></td>)}</tr>)}</tbody></table></div>;
    return <p key={i}><Lines lines={b.lines} /></p>;
  })}</div>;
}
