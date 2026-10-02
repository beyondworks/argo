// 마크다운 읽기 전용 보기 — core/markdown.js가 나눈 블록을 React 요소로만 그린다(HTML 문자열 없음). 평가 레포트 총평·업무내용용.
import { parseMarkdown } from '../core/markdown.js';

const Inline = ({ parts }) => parts.map((p, i) => (p.t === 'bold' ? <strong key={i}>{p.v}</strong> : p.t === 'code' ? <code key={i}>{p.v}</code> : <span key={i}>{p.v}</span>));
const Lines = ({ lines }) => lines.map((l, i) => <span key={i}>{i > 0 && <br />}<Inline parts={l} /></span>);

export function Markdown({ text, className = '' }) {
  return <div className={`md ${className}`}>{parseMarkdown(text).map((b, i) => {
    if (b.type === 'h') { const H = `h${b.level}`; return <H key={i}><Inline parts={b.text} /></H>; }
    if (b.type === 'ul' || b.type === 'ol') { const L = b.type; return <L key={i}>{b.items.map((it, j) => <li key={j}><Inline parts={it} /></li>)}</L>; }
    if (b.type === 'quote') return <blockquote key={i}><Lines lines={b.lines} /></blockquote>;
    if (b.type === 'table') return <div key={i} className="md-table"><table><thead><tr>{b.head.map((c, j) => <th key={j}><Inline parts={c} /></th>)}</tr></thead>
      <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline parts={c} /></td>)}</tr>)}</tbody></table></div>;
    return <p key={i}><Lines lines={b.lines} /></p>;
  })}</div>;
}
