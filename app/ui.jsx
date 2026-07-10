'use client';
// 공용 클라이언트 조각들 — 화면 셋이 같이 쓴다.
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

export function Wordmark({ size = 18 }) {
  return <span className="wordmark" style={{ fontSize: size }}>ARGO</span>;
}

export function Avatar({ name, sm = false }) {
  return <span className={`avatar${sm ? ' sm' : ''}`}>{(name || '?').slice(0, 1)}</span>;
}

export function Oars() {
  return (
    <span className="oars" role="status" aria-label="진행 중">
      <i /><i /><i />
    </span>
  );
}

/** 에이전트 응답(마크다운) 렌더 — 자체 vault 데이터라 신뢰 범위 안이지만 raw HTML은 이스케이프한다. */
export function Markdown({ text, onWikiLink }) {
  const escaped = String(text ?? '').replace(/</g, '&lt;');
  let html = marked.parse(escaped);
  html = html.replace(/href="(?!https?:|#|\/)[^"]*"/gi, 'href="#"'); // javascript: 등 위험 스킴 차단
  html = html.replace(/\[\[(.+?)\]\]/g, (_, p) => `<span class="wikilink" data-wiki="${p}">${p}</span>`);
  return (
    <div
      className="md"
      onClick={(e) => {
        const w = e.target.closest?.('[data-wiki]');
        if (w && onWikiLink) onWikiLink(w.dataset.wiki);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export async function api(path, opts) {
  const res = await fetch(path, opts && {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

export function timeAgo(input) {
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

/** vault 파일명(2026-07-10T03-50-47-yujin.md)에서 시각을 복원한다. */
export function tsFromRel(rel) {
  const m = rel.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`) : null;
}
