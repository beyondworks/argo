'use client';
// 공용 클라이언트 조각들 — 화면 전체가 같이 쓴다.
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

/* ─── 아이콘 (lucide 계열 미니 세트) ─── */
const PATHS = {
  deck: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  memory: 'M12 3l2.1 6.4L21 12l-6.9 2.6L12 21l-2.1-6.4L3 12l6.9-2.6z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  send: 'M12 19V5M5 12l7-7 7 7',
  plus: 'M12 5v14M5 12h14',
  back: 'M19 12H5M12 19l-7-7 7-7',
  arrow: 'M5 12h14M12 5l7 7-7 7',
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  bolt: 'M13 2 3 14h7l-1 8 10-12h-7z',
};

export function Icon({ name, size = 16, strokeWidth = 1.8, ...rest }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** 브랜드 별 마크 — 채워진 4포인트 스타. */
export function StarMark({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5 L14.3 9.7 L21.5 12 L14.3 14.3 L12 21.5 L9.7 14.3 L2.5 12 L9.7 9.7 Z" fill="currentColor" />
    </svg>
  );
}

export function Logo({ size = 15 }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: size + 13, height: size + 13, borderRadius: 999, background: 'var(--ink)', color: '#fff', display: 'grid', placeItems: 'center' }}>
        <StarMark size={size - 1} />
      </span>
      <span style={{ fontWeight: 750, fontSize: size + 1, letterSpacing: '-0.02em' }}>Argo</span>
    </span>
  );
}

export function Avatar({ name, sm = false }) {
  return <span className={`avatar${sm ? ' sm' : ''}`}>{(name || '?').slice(0, 1)}</span>;
}

export function Dots() {
  return (
    <span className="dots" role="status" aria-label="진행 중">
      <i /><i /><i />
    </span>
  );
}

export function Spinner({ size = 14 }) {
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="로딩">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ h = 16, w = '100%', style }) {
  return <span className="skeleton" style={{ display: 'block', height: h, width: w, ...style }} />;
}

/** 도넛 차트 — 레퍼런스의 라운드 세그먼트 도넛. segments: [{value, color}] */
export function Donut({ segments, size = 150, stroke = 16, centerTop, centerSub }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const gap = segments.filter((s) => s.value > 0).length > 1 ? 3 : 0;
  let offset = -90;
  const arcs = segments.filter((s) => s.value > 0).map((s, i) => {
    const frac = s.value / total;
    const len = Math.max(frac * 360 - gap, 2);
    const arc = { ...s, start: offset, len };
    offset += frac * 360;
    return arc;
  });
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        {arcs.map((a, i) => (
          <circle
            key={i}
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={a.color} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${(a.len / 360) * C} ${C}`}
            transform={`rotate(${a.start} ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dasharray 0.5s ease' }}
          />
        ))}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="num" style={{ fontSize: 26 }}>{centerTop}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: -2 }}>{centerSub}</div>
        </div>
      </div>
    </div>
  );
}

/** 에이전트 응답(마크다운) 렌더 — raw HTML 이스케이프 + 위험 스킴 href 차단. */
export function Markdown({ text, onWikiLink }) {
  const escaped = String(text ?? '').replace(/</g, '&lt;');
  let html = marked.parse(escaped);
  html = html.replace(/href="(?!https?:|#|\/)[^"]*"/gi, 'href="#"');
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
