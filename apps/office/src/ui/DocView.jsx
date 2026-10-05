// 문서 본문을 읽기 전용으로 — 공개 화면·기록판 첨부·버전 미리 보기·비공개 블록 공용.
// HTML 문자열을 쓰지 않고 노드를 React 요소로만 만든다(유건 규칙). Records.jsx·Dialogs.jsx·Misc.jsx·Editor.jsx가 쓴다(모두 지연 로드).
// 16차: 토글·콜아웃·표·2열/3열을 편집기와 같은 모양(같은 class, ui/doc-blocks.css)으로 그린다. 링크는 http(s)·mailto·tel만, 새 창(rel noopener·noreferrer·nofollow),
// 데스크톱 앱에서는 기본 브라우저로 연다.
import { useState } from 'react';
import { Icon } from './Icon.jsx';
import { t, registerDict } from '../core/i18n.js';
import { isDesktop, openExternal } from '../core/platform.js';
import { safeHref, calloutIcon, cellSpan } from '../core/blocks-model.js';
import { DOC_DICT } from './doc-i18n.js';
import './doc-blocks.css';

registerDict(DOC_DICT);

const TAG = { paragraph: 'p', bulletList: 'ul', orderedList: 'ol', taskList: 'ul', listItem: 'li', blockquote: 'blockquote', codeBlock: 'pre', tableRow: 'tr' };
const openLink = (e) => { if (!isDesktop()) return; e.preventDefault(); openExternal(e.currentTarget.href).catch(() => {}); };

/** 토글 — 첫 줄은 늘 보이고 나머지는 접힌다. 읽는 사람이 접고 펴도 문서는 바뀌지 않는다 */
function Toggle({ n, kids }) {
  const [open, setOpen] = useState(n.attrs?.open !== false);
  return <div className="toggle" data-open={String(open)}>
    <button type="button" className="toggle-btn" aria-expanded={open} aria-label={t(open ? 'doc.toggleClose' : 'doc.toggleOpen')} onClick={() => setOpen(!open)}><Icon name="chevron" size={16} /></button>
    <div className="toggle-content">{kids}</div>
  </div>;
}

/** 표 — 편집기(prosemirror-tables)와 같은 틀: 감싼 상자(가로 넘치면 밀기) · 열 너비(첫 줄 칸의 colwidth) */
function Table({ n, kids }) {
  const widths = (n.content?.[0]?.content ?? []).flatMap((c) => Array.from({ length: cellSpan(c.attrs?.colspan) }, (_, i) => c.attrs?.colwidth?.[i] ?? null));
  const fixed = widths.length > 0 && widths.every(Boolean);
  return <div className="tableWrapper"><table style={fixed ? { width: widths.reduce((a, b) => a + b, 0) } : undefined}>
    {widths.some(Boolean) && <colgroup>{widths.map((w, i) => <col key={i} style={w ? { width: w } : undefined} />)}</colgroup>}
    <tbody>{kids}</tbody></table></div>;
}

function Node({ n }) {
  if (n.type === 'text') {
    let el = n.text;
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') el = <strong>{el}</strong>;
      else if (m.type === 'italic') el = <em>{el}</em>;
      else if (m.type === 'strike') el = <s>{el}</s>;
      else if (m.type === 'underline') el = <u>{el}</u>;
      else if (m.type === 'code') el = <code>{el}</code>;
      else if (m.type === 'redact') el = <span data-redact="" className="redact-text">{el}</span>; // 가린 글자 — 누르고 있는 동안만 보인다(base.css)
      else if (m.type === 'link' && safeHref(m.attrs?.href)) el = <a href={safeHref(m.attrs.href)} rel="noopener noreferrer nofollow" target="_blank" onClick={openLink}>{el}</a>;
    }
    return el;
  }
  if (n.type === 'hardBreak') return <br />;
  if (n.type === 'horizontalRule') return <hr />;
  const kids = (n.content ?? []).map((c, i) => <Node key={i} n={c} />);
  if (n.type === 'heading') { const H = `h${Math.min(3, Math.max(1, n.attrs?.level ?? 1))}`; return <H>{kids}</H>; }
  if (n.type === 'taskItem') return <li data-checked={String(!!n.attrs?.checked)}><label><input type="checkbox" checked={!!n.attrs?.checked} readOnly disabled /></label><div>{kids}</div></li>;
  if (n.type === 'taskList') return <ul data-type="taskList">{kids}</ul>;
  if (n.type === 'toggle') return <Toggle n={n} kids={kids} />;
  if (n.type === 'callout') return <div className="callout" data-icon={calloutIcon(n.attrs?.icon)}><span className="callout-icon" aria-hidden="true"><Icon name={calloutIcon(n.attrs?.icon)} size={18} /></span><div className="callout-body">{kids}</div></div>;
  if (n.type === 'columns') return <div className="cols">{kids}</div>;
  if (n.type === 'column') return <div className="col">{kids}</div>;
  if (n.type === 'table') return <Table n={n} kids={kids} />;
  if (n.type === 'tableCell' || n.type === 'tableHeader') {
    const C = n.type === 'tableHeader' ? 'th' : 'td';
    const cs = cellSpan(n.attrs?.colspan), rs = cellSpan(n.attrs?.rowspan);
    return <C colSpan={cs > 1 ? cs : undefined} rowSpan={rs > 1 ? rs : undefined}>{kids}</C>;
  }
  const Tag = TAG[n.type];
  return Tag ? <Tag>{kids}</Tag> : <>{kids}</>;
}

export const DocView = ({ doc }) => (doc?.content ?? []).map((n, i) => <Node key={i} n={n} />);
