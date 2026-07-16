'use client';
// 공용 클라이언트 조각들 — 화면 전체가 같이 쓴다.
import { useEffect, useState } from 'react';
import { marked } from 'marked';
import { useLang } from './i18n';

marked.setOptions({ breaks: true, gfm: true });

/* ─── 스크롤 락 — 모달/팝업 열림 동안 body 스크롤 차단(뒷 페이지 간섭·스크롤 체이닝 방지).
   중첩 모달 대비 참조 카운트 — 마지막 하나가 닫힐 때만 원복. ─── */
let _lockCount = 0, _prevOverflow = '';
export function useScrollLock() {
  useEffect(() => {
    if (_lockCount === 0) { _prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    _lockCount += 1;
    return () => { _lockCount -= 1; if (_lockCount <= 0) { _lockCount = 0; document.body.style.overflow = _prevOverflow; } };
  }, []);
}

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
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  market: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 21V13',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  play: 'M6 4l14 8-14 8V4z',
  edit: 'M17 3l4 4L8 20H4v-4L17 3zM14 6l4 4',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6',
  clip: 'M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  tasks: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  pin: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
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

export function Logo({ size = 14 }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--fg)' }}>
      <StarMark size={size + 1} />
      <span className="mono" style={{ fontWeight: 600, fontSize: size, letterSpacing: '0.16em' }}>ARGO</span>
    </span>
  );
}

export function Avatar({ name, sm = false }) {
  return <span className={`avatar${sm ? ' sm' : ''}`}>{(name || '?').slice(0, 1)}</span>;
}

/** 아르고 생각중 스피너 — 브랜드 별이 노 젓는 박자로 회전한다(가속-활강). 색은 테마 액센트. */
export function ArgoSpinner({ size = 16 }) {
  const { t } = useLang();
  return (
    <span className="argo-spin" role="status" aria-label={t('ui.inProgress')} style={{ display: 'inline-flex', color: 'var(--accent)' }}>
      <StarMark size={size} />
    </span>
  );
}

export function Dots() {
  const { t } = useLang();
  return (
    <span className="dots" role="status" aria-label={t('ui.inProgress')}>
      <i /><i /><i />
    </span>
  );
}

export function Spinner({ size = 14 }) {
  const { t } = useLang();
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label={t('ui.loading')}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ h = 16, w = '100%', style }) {
  return <span className="skeleton" style={{ display: 'block', height: h, width: w, ...style }} />;
}

/** 계기 숫자 카운트업 — 마운트 시 0에서 목표까지 이징. */
export function Num({ value, unit, size = 34, duration = 750, style }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min((t - t0) / duration, 1);
      setV(Math.round(value * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return (
    <div className="num" style={{ fontSize: size, ...style }}>
      {v}{unit && <small>{unit}</small>}
    </div>
  );
}

/** 도트 매트릭스 차트 — 막대 대신 잉크 도트. 마운트 시 아래에서 위로 점등. */
export function Bars({ data, rows = 8 }) {
  const { t } = useLang();
  const max = Math.max(...data.map((d) => d.count), 1);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '0 2px' }}>
      {data.map((d, i) => {
        const filled = d.count === 0 ? 0 : Math.max(Math.round((d.count / max) * rows), 1);
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, minWidth: 0 }} title={t('ui.barTitle', { date: d.date, n: d.count })}>
            <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 3 }}>
              {Array.from({ length: rows }, (_, r) => {
                const lit = on && r < filled;
                return (
                  <span key={r} style={{
                    width: 7, height: 7, borderRadius: 2,
                    background: lit ? 'var(--accent)' : 'transparent',
                    border: `1px solid ${lit ? 'var(--accent)' : 'var(--border-soft)'}`,
                    transition: 'background 0.25s, border-color 0.25s',
                    transitionDelay: `${i * 25 + r * 55}ms`,
                  }} />
                );
              })}
            </div>
            <span className="mono" style={{ fontSize: 9, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>
              {d.date.slice(3)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 아날로그 다이얼 게이지 — 틱 눈금 + 바늘 스윕 애니메이션. value: 0~100 */
export function Dial({ value, size = 120, label }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setV(Math.min(Math.max(value, 0), 100)), 120);
    return () => clearTimeout(t);
  }, [value]);
  const cx = size / 2, cy = size / 2, r = size / 2 - 8;
  const start = -220, sweep = 260; // 좌하단에서 우하단까지
  const ticks = Array.from({ length: 26 }, (_, i) => {
    const a = ((start + (i / 25) * sweep) * Math.PI) / 180;
    const long = i % 5 === 0;
    return {
      x1: cx + Math.cos(a) * (r - (long ? 8 : 4.5)), y1: cy + Math.sin(a) * (r - (long ? 8 : 4.5)),
      x2: cx + Math.cos(a) * r, y2: cy + Math.sin(a) * r,
      on: (i / 25) * 100 <= v && v > 0,
      delay: i * 28,
    };
  });
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size}>
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={t.on ? 'var(--accent)' : 'var(--border-soft)'} strokeWidth={t.on ? 1.5 : 1}
            style={{ transition: 'stroke 0.2s', transitionDelay: `${t.delay}ms` }} />
        ))}
        {/* 바늘 — 0시 방향으로 그려두고 그룹 회전으로 스윕 */}
        <g style={{
          transform: `rotate(${start + (v / 100) * sweep}deg)`,
          transformOrigin: `${cx}px ${cy}px`,
          transition: 'transform 1s cubic-bezier(0.34, 1.3, 0.4, 1)',
        }}>
          <line x1={cx} y1={cy} x2={cx + r - 14} y2={cy} stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" />
        </g>
        <circle cx={cx} cy={cy} r="3" fill="var(--accent)" />
      </svg>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 4, textAlign: 'center' }}>
        <span className="mono" style={{ fontSize: 16, fontWeight: 600 }}>{Math.round(v)}%</span>
        {label && <span className="microlabel" style={{ display: 'block', marginTop: -2 }}>{label}</span>}
      </div>
    </div>
  );
}

/** 라이브 시계 — 계기판의 모노 타임코드. */
export function Clock() {
  const [now, setNow] = useState('');
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      setNow(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="topbar-clock" suppressHydrationWarning>{now}</span>;
}

/** 에이전트 응답(마크다운) 렌더 — raw HTML 이스케이프 + 위험 스킴 href 차단. */
export function Markdown({ text, onWikiLink }) {
  const escaped = String(text ?? '').replace(/</g, '&lt;');
  let html = marked.parse(escaped);
  html = html.replace(/href="(?!https?:|#|\/)[^"]*"/gi, 'href="#"');
  // 이미지 src는 동일출처 파일 라우트("/...")만 허용 — 크루 답변 속 외부 http/data 이미지는
  // 추적 픽셀·데이터 유출 벡터라 태그째 제거한다. "//evil.com"(프로토콜 상대)도 차단.
  html = html.replace(/<img\b[^>]*>/gi, (tag) => /\ssrc="\/(?!\/)[^"]*"/i.test(tag) ? tag : '');
  // 크루가 주는 링크는 항상 새 창 — 대화 흐름을 벗어나지 않는다
  html = html.replace(/<a /gi, '<a target="_blank" rel="noopener noreferrer" ');
  html = html.replace(/\[\[(.+?)\]\]/g, (_, p) => {
    const attr = p.replace(/"/g, '&quot;'); // marked 이스케이프에 의존하지 않고 속성 breakout 자체 차단
    return `<span class="wikilink" data-wiki="${attr}">${p}</span>`;
  });
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

/** 한글 IME 조합 중 Enter가 폼 전송으로 새는 것을 막는다 — 입력에 {...imeGuard} 스프레드. */
export const imeGuard = {
  onKeyDown: (e) => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault(); },
};

export async function api(path, opts) {
  const res = await fetch(path, opts && {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // api()는 훅 밖(컴포넌트 외부)에서도 호출되므로 localStorage를 직접 읽는다.
    const lang = (typeof window !== 'undefined' && localStorage.getItem('argo-lang')) || 'ko';
    const fallback = lang === 'en' ? `Request failed (${res.status})` : `요청 실패 (${res.status})`;
    throw new Error(data.error || fallback);
  }
  return data;
}

export function timeAgo(input, lang = 'ko') {
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (lang === 'en') {
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
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

/** 깃헙식 파괴 확인 모달 — 이름을 똑같이 입력 + 확인 문구 입력이 맞아야 실행된다.
 *  (규칙: 해고·회사 보관 등 파괴적 액션은 window.confirm 금지, 항상 이것 사용) */
export function DangerModal({ title, description, requireText, phraseKey = 'danger.phrase.delete', confirmLabel, busy, onConfirm, onClose }) {
  const { t } = useLang();
  useScrollLock();
  const [nameIn, setNameIn] = useState('');
  const [phraseIn, setPhraseIn] = useState('');
  const phrase = t(phraseKey);
  const ok = nameIn === requireText && phraseIn === phrase;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const field = { height: 34, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13, width: '100%' };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'var(--overlay)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <div className="card card-float fade-up" style={{ width: 'min(420px, 100%)', borderColor: 'var(--danger)' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title" style={{ color: 'var(--danger)' }}>{title}</span>
          <span className="rule" />
          <button type="button" className="btn sm" onClick={onClose}>{t('common.close')} ESC</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'grid', gap: 12 }}>
          <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.65 }}>{description}</p>
          <label style={{ display: 'grid', gap: 5 }}>
            <span style={{ fontSize: 12 }}>{t('danger.typeName')} <strong className="mono" style={{ fontSize: 11.5 }}>{requireText}</strong></span>
            <input suppressHydrationWarning value={nameIn} onChange={(e) => setNameIn(e.target.value)} style={field} autoFocus />
          </label>
          <label style={{ display: 'grid', gap: 5 }}>
            <span style={{ fontSize: 12 }}>{t('danger.typePhrase')} <strong className="mono" style={{ fontSize: 11.5 }}>{phrase}</strong></span>
            <input suppressHydrationWarning value={phraseIn} onChange={(e) => setPhraseIn(e.target.value)} style={field} />
          </label>
          <button
            className="btn sm"
            disabled={!ok || busy}
            onClick={onConfirm}
            style={{ color: 'var(--danger)', borderColor: 'var(--danger)', justifyContent: 'center', opacity: ok ? 1 : 0.4 }}
          >
            {busy ? <Spinner size={12} /> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 경량 확인 모달 — 파괴/확정 액션용(타입-투-컨펌 없이). window.confirm 대체(Tauri 데스크톱 웹뷰 호환).
    tone: 'danger'(삭제류) | 'primary'(확정류). */
export function ConfirmModal({ title, description, confirmLabel, tone = 'danger', busy, onConfirm, onClose }) {
  const { t } = useLang();
  useScrollLock();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const danger = tone === 'danger';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'var(--overlay)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <div className="card card-float fade-up" style={{ width: 'min(400px, 100%)', ...(danger ? { borderColor: 'var(--danger)' } : {}) }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title" style={danger ? { color: 'var(--danger)' } : undefined}>{title}</span>
          <span className="rule" />
          <button type="button" className="btn sm" onClick={onClose}>{t('common.close')} ESC</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'grid', gap: 14 }}>
          <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.65 }}>{description}</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
            <button type="button" className={danger ? 'btn sm' : 'btn btn-primary sm'} disabled={busy} onClick={onConfirm}
              style={danger ? { color: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}>
              {busy ? <Spinner size={12} /> : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 경량 입력 모달 — 텍스트 한 줄 입력(예: 이름 변경). window.prompt 대체(Tauri 데스크톱 웹뷰 호환).
    onConfirm(value)로 트림된 값을 넘긴다. 빈 값이면 확정 불가. */
export function InputModal({ title, label, defaultValue = '', placeholder, confirmLabel, busy, onConfirm, onClose }) {
  const { t } = useLang();
  useScrollLock();
  const [val, setVal] = useState(defaultValue);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const submit = () => { const v = val.trim(); if (v && !busy) onConfirm(v); };
  const field = { height: 34, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13, width: '100%' };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'var(--overlay)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <div className="card card-float fade-up" style={{ width: 'min(400px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">{title}</span>
          <span className="rule" />
          <button type="button" className="btn sm" onClick={onClose}>{t('common.close')} ESC</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 5 }}>
            {label && <span style={{ fontSize: 12 }}>{label}</span>}
            <input suppressHydrationWarning value={val} onChange={(e) => setVal(e.target.value)} placeholder={placeholder}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
              style={field} autoFocus {...imeGuard} />
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary sm" disabled={busy || !val.trim()} onClick={submit}>
              {busy ? <Spinner size={12} /> : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 베타 피드백 — 인앱에서 작성하면 서버(/api/feedback)가 Supabase에 저장한다. 브라우저(메일앱)를 열지 않는다. */
export function FeedbackModal({ onClose }) {
  const { t } = useLang();
  useScrollLock();
  const [text, setText] = useState('');
  const [state, setState] = useState(''); // '' | 'sending' | 'sent' | 'error'
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const send = async () => {
    const v = text.trim();
    if (!v || state === 'sending') return;
    setState('sending');
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: v }),
      });
      if (!r.ok) throw new Error();
      setState('sent');
      setTimeout(onClose, 1300);
    } catch { setState('error'); }
  };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'var(--overlay)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <div className="card card-float fade-up" style={{ width: 'min(440px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">{t('feedback.title')}</span>
          <span className="rule" />
          <button type="button" className="btn sm" onClick={onClose}>{t('common.close')} ESC</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'grid', gap: 12 }}>
          {state === 'sent' ? (
            <p style={{ fontSize: 13, color: 'var(--fg-2)', padding: '14px 2px', textAlign: 'center' }}>{t('feedback.sent')}</p>
          ) : (
            <>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('feedback.desc')}</p>
              <textarea suppressHydrationWarning value={text} onChange={(e) => setText(e.target.value)} placeholder={t('feedback.placeholder')}
                rows={5} autoFocus {...imeGuard}
                style={{ padding: '10px 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }} />
              {state === 'error' && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{t('feedback.error')}</span>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn sm" onClick={onClose} disabled={state === 'sending'}>{t('common.cancel')}</button>
                <button type="button" className="btn btn-primary sm" disabled={state === 'sending' || !text.trim()} onClick={send}>
                  {state === 'sending' ? <Spinner size={12} /> : t('feedback.send')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
