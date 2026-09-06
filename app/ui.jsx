'use client';
// 공용 클라이언트 조각들 — 화면 전체가 같이 쓴다.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resolveTab } from './tabs-state.mjs';
import { marked } from 'marked';
import { useLang } from './i18n';
import { rewriteVaultHref } from '../src/vault-links.mjs'; // 산출물 링크 재작성(순수 — 테스트는 src 쪽)
import { dropUpClamp } from './c/[ws]/zoom-math.mjs'; // 표시 배율(#334) 좌표 환산 계열 — DropUp 패널 클램프

// SSR에는 layout effect가 없다(서버 렌더 경고) — 클라이언트에서만 "그리기 전" 실행이 필요한
// 팝오버 클램프용 별칭. 서버에서는 useEffect로 동작이 같다(열림은 클라이언트 상호작용에서만 발생).
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
  split: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM13 4v16',
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
  eye: 'M2.1 12S5.5 5.5 12 5.5 21.9 12 21.9 12 18.5 18.5 12 18.5 2.1 12 2.1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  tasks: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  mail: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l9 6 9-6', // 쪽지함
  pin: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
  sort: 'M3 6h18M6 12h12M10 18h4',          // 탐색기 정렬(옵시디언 툴바)
  check: 'M20 6 9 17l-5-5',                 // 완료 조건 배지(루틴 목록)
  collapse: 'M7 11l5-5 5 5M7 19l5-5 5 5',   // 모두 접기(옵시디언 툴바)
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
        {/* 바늘 — 3시 방향으로 그려두고 그룹 회전으로 스윕. 회전 원점은 로컬 (0,0)이고 중심 이동은
            SVG 속성 translate(사용자 좌표계)로 한다: 표시 배율(zoom, #334)에서 WebKit(Tauri 웹뷰)은
            svg 내부 요소의 px transform-origin을 배율만큼 한 번 더 곱해 회전 중심이 어긋난다
            (실측 2026-09-02: 배율 2에서 꼬리가 중심에서 (−22.4, +80.2)px — 원점 (60,60)→(120,120) 계산과 일치).
            0은 몇 배를 곱해도 0이라 엔진 무관. CSS transition은 그대로 유지된다. */}
        <g transform={`translate(${cx} ${cy})`}>
          <g style={{
            transform: `rotate(${start + (v / 100) * sweep}deg)`,
            transformOrigin: '0 0',
            transition: 'transform 1s cubic-bezier(0.34, 1.3, 0.4, 1)',
          }}>
            <line x1={0} y1={0} x2={r - 14} y2={0} stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" />
          </g>
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

/** [[위키링크]] → 실제 문서 rel 해석 — 기억 페이지·그래프 모달 두 뷰어가 공유하는 단일 정본
 *  (두 창이 같은 링크에 다르게 반응하면 안 된다 — PR #208 검수 M-3).
 *  [[이름]]은 vault 루트 rel이 아니라 대개 노트 이름이라 .md만 붙이면 404였다.
 *  notes/ 접두 추정(경로 포함이면 그대로) → 파일명 → 제목 순으로 docs+산출물(md만 — 비md는
 *  뷰어(readDoc)가 .md를 강제해 매칭해도 404, 노트 폴백 문구가 더 일관)을 매칭한다.
 *  대소문자 무시하되 반환은 정본 d.rel — macOS ci-FS에선 내용은 열리는데 selected가
 *  rel과 불일치해 편집·삭제 버튼이 사라진다(L-2). 동률은 rel 사전순 첫 항목(L-3, 안정 참조). */
export function resolveWikiRel(name, docs, projects) {
  const bare = String(name).replace(/\.md$/i, '');
  const lower = bare.toLowerCase();
  const guess = bare.includes('/') ? `${bare}.md` : `notes/${bare}.md`;
  const pool = [...(docs ?? []), ...(projects ?? []).filter((p) => !p.binary)];
  const pick = (match) => pool.filter(match).map((d) => d.rel).sort()[0];
  const hit = pick((d) => d.rel.toLowerCase() === guess.toLowerCase())
    ?? pick((d) => d.rel.toLowerCase().endsWith(`/${lower}.md`))
    ?? pick((d) => String(d.title ?? '').toLowerCase() === lower);
  return hit ?? guess;
}

/** 에이전트 응답(마크다운) 렌더 — raw HTML 이스케이프 + 위험 스킴 href 차단.
    wsId를 주면 vault 상대 링크(산출물)는 죽이지 않고 뷰어/다운로드 URL로 재작성한다 —
    크루에게 "경로를 알려라"고 시켜 놓고 그 링크를 '#'로 죽이던 모순 해소(제보 2026-07-30).
    화이트리스트 재작성(rewriteVaultHref)이라 XSS 방어 방향은 그대로다. */
/** 마크다운 렌더 — **memo + useMemo 필수**(실사용 제보 2026-08-07 "채팅 타이핑이 느리다",
    특히 대화가 긴 크루). 채팅 화면은 입력 상태와 메시지 목록이 같은 컴포넌트에 있어 **키 한 타마다
    스레드 전체가 재렌더**된다. 여기서 파싱을 다시 하면 그 비용이 전부 타이핑 지연이 된다 —
    실측(349메시지·크루 168건/117k자 스레드): 1회 전체 렌더 13~15ms(node warm), 웹뷰에선 React
    재조정·DOM 교체가 얹혀 더 크다. text·wsId가 그대로면 파싱도 렌더도 건너뛴다.
    ⚠ 이 memo를 풀거나 내부 계산을 useMemo 밖으로 꺼내면 그 지연이 그대로 돌아온다. */
export const Markdown = memo(function Markdown({ text, onWikiLink, wsId }) {
  const html = useMemo(() => {
    const escaped = String(text ?? '').replace(/</g, '&lt;');
    let out = marked.parse(escaped);
    out = out.replace(/href="((?!https?:|#|\/)[^"]*)"/gi, (_, h) => {
      const url = rewriteVaultHref(h, wsId);
      return url ? `href="${url.replace(/"/g, '&quot;')}"` : 'href="#"';
    });
    // 이미지 src는 동일출처 파일 라우트("/...")만 허용 — 크루 답변 속 외부 http/data 이미지는
    // 추적 픽셀·데이터 유출 벡터라 태그째 제거한다. "//evil.com"(프로토콜 상대)도 차단.
    out = out.replace(/<img\b[^>]*>/gi, (tag) => /\ssrc="\/(?!\/)[^"]*"/i.test(tag) ? tag : '');
    // 크루가 주는 링크는 항상 새 창 — 대화 흐름을 벗어나지 않는다
    out = out.replace(/<a /gi, '<a target="_blank" rel="noopener noreferrer" ');
    out = out.replace(/\[\[(.+?)\]\]/g, (_, p) => {
      const attr = p.replace(/"/g, '&quot;'); // marked 이스케이프에 의존하지 않고 속성 breakout 자체 차단
      return `<span class="wikilink" data-wiki="${attr}">${p}</span>`;
    });
    return out;
  }, [text, wsId]);
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
});

/** 한글 IME 조합 중 Enter가 폼 전송으로 새는 것을 막는다 — 입력에 {...imeGuard} 스프레드. */
export const imeGuard = {
  onKeyDown: (e) => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault(); },
};

/** 자기 Enter 처리가 **따로 있는** 입력용 — `{...imeGuardWith(handler)}`.
    스프레드와 명시 onKeyDown을 한 태그에 같이 쓰면 나중에 온 쪽이 앞의 것을 통째로 덮어쓴다.
    실제로 그렇게 죽었다(신고 2026-07-31: 이름을 고치고 Enter를 눌러도 저장이 안 됐다 — 스프레드가
    뒤에 있어 제출 핸들러가 사라졌다). 순서를 규율로 지키는 대신, 합쳐서 넘길 자리를 만들어
    **트랩 자체를 없앤다**(같은 태그에 둘이 공존하면 test/jsx-prop-order가 red). */
export const imeGuardWith = (onKeyDown) => ({
  onKeyDown: (e) => {
    if (e.key === 'Enter' && e.nativeEvent.isComposing) { e.preventDefault(); return; } // 조합 중 Enter는 확정만
    onKeyDown(e);
  },
});

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
    const err = new Error(data.error || fallback);
    err.data = data; // 에러 바디의 부가 필드(예: chat의 failed·saved)를 호출부가 읽을 수 있게
    throw err;
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
              style={field} autoFocus
              {...imeGuardWith((e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } })} />
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

/** 위로 열리는 드롭박스 — 네이티브 <select>는 팝업 방향을 못 정해 하단 배치 화면에서 아래로 열려 잘린다
    (유건 지시 2026-07-21: 입력바 위 컨트롤은 전부 위로 연다). 채팅 ModelMenu와 같은 팝오버 문법.
    groups = [{ label?, items: [{ value, label, disabled?, badge? }] }] — 러너별 optgroup 대응. */
export function DropUp({ value, placeholder = '—', groups, onChange, disabled, width = 210, align = 'left', height = 28, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  // 위 공간이 패널(최대 300)보다 좁으면 아래로 연다 — 뷰포트 상단에서 항목이 잘려 선택 불가하던
  // 회귀(사후 검수 실측 2026-07-25: 시각 팝업 상단 95px 잘림 → 00~03시 클릭 불가) 방지.
  const [below, setBelow] = useState(false);
  // 좌우 클램프(CSS px) — 패널 폭이 아래로는 minWidth(≥190), 위로는 무상한(라벨 nowrap max-content,
  // #357 검수 실측 404 CSS px)이라 좁은 열·우측 끝 트리거에서 뷰포트를 뚫던 선재 결함(#357 검증
  // 실측: en·1280 배율 2에서 right 1415 > clientWidth 1264) 방지. #350(회의실 멘션)의 min·max 100%
  // 처방은 여기 부적합 — 기준 박스(래퍼)가 좁은 트리거 자체 + shrink-to-fit이라 일반 폭에서 패널이
  // 트리거 폭으로 퇴행한다. 대신 setBelow(상하 뒤집기)와 동형의 열림 시점 실측 시프트.
  const [clamp, setClamp] = useState({ shift: 0, maxW: 0 });
  const boxRef = useRef(null);
  const panelRef = useRef(null);
  const naturalW = useRef(0); // 패널 자연 폭(CSS px) — 상한 적용 전 1회 실측. CSS px는 배율 무관이라 재클램프에 재사용
  // 그리기 전(useIsoLayoutEffect) 실측 — useEffect(그린 뒤)면 클램프 전 자연 폭 프레임이 문서 폭을
  // 실제로 늘린다(분리 검수 F1 실측: 첫 프레임 sw 2202 → 다음 프레임 1502, 클래식 스크롤바에선 깜빡임).
  useIsoLayoutEffect(() => {
    if (!open) { setEntered(false); setClamp({ shift: 0, maxW: 0 }); naturalW.current = 0; return; }
    // 패널 자연 폭을 재고 뷰포트 좌우를 뚫은 만큼 안쪽으로 민다. offsetWidth는 등장 transform
    // (scale 0.97)을 무시한 배치 폭이고, 최초 렌더는 상한 미적용(clamp.maxW 0)이라 자연 폭 그대로다.
    // 재측정(배율·창 크기 변경)은 저장해 둔 자연 폭을 쓴다 — 상한이 걸린 뒤의 offsetWidth를 다시
    // 재면 자연 폭을 잃는다(닫힘 리셋이 다음 열림의 1회 실측을 보장하는 이유이기도 하다).
    const measure = () => {
      if (!boxRef.current || !panelRef.current) return;
      if (!naturalW.current) naturalW.current = panelRef.current.offsetWidth;
      setClamp(dropUpClamp(boxRef.current.getBoundingClientRect(),
        document.documentElement.clientWidth, naturalW.current, align === 'right'));
    };
    measure();
    const raf = requestAnimationFrame(() => setEntered(true));
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    // 열린 채 배율(cmd +/- → argo:zoom)·창 크기가 바뀌면 시프트·상한이 낡아 결함이 되돌아온다
    // (분리 검수 F2 실측: 배율 1→2 전환 시 패널 right 2253 > cw 1264 재발) — 같은 실측으로 재클램프.
    window.addEventListener('resize', measure);
    window.addEventListener('argo:zoom', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', measure);
      window.removeEventListener('argo:zoom', measure);
    };
  }, [open, align]);
  const cur = groups.flatMap((g) => g.items).find((i) => i.value === value);
  return (
    /* 축소 규칙 — 래퍼·트리거에 minWidth 0: flex 아이템의 자동 최소치(내용 min-content, 라벨 실측
       148 CSS px)가 좁은 유효 폭(표시 배율 2, 열 106 CSS px)에서 행을 뚫고 문서 가로 넘침을
       만들었다(경쟁 시안 실측 1283>1264 → 1264=1264). 바닥을 없애면 컨테이너가 좁을 때만 flex
       수축이 일하고 라벨은 자체 ellipsis로 줄어든다. 트리거 상한은 종전 그대로 확정 길이
       maxWidth: width — min(width, 100%)처럼 %를 섞으면 shrink-to-fit 래퍼 상대라 intrinsic
       기여를 못 잡아, width보다 긴 라벨에서 래퍼만 max-content로 자라는 보이지 않는 죽은 폭
       (검수 실측 156.5px, 바깥클릭 닫기 오동작 동반)이 생긴다. 일반 폭 레이아웃은 종전과 동일
       (minWidth:0은 선호 크기에 무영향) — 소비자 9곳(경쟁 4·쪽지 1·루틴 4). */
    <div ref={boxRef} style={{ position: 'relative', display: 'inline-flex', minWidth: 0 }}>
      <button type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => { setBelow((boxRef.current?.getBoundingClientRect()?.top ?? Infinity) < 320); setOpen((v) => !v); }}
        style={{ height, padding: '0 9px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8,
          fontSize: 12, color: cur ? 'var(--fg)' : 'var(--fg-3)', cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 7, maxWidth: width, minWidth: 0, opacity: disabled ? 0.55 : 1 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cur?.label ?? placeholder}</span>
        <span aria-hidden style={{ fontSize: 8, color: 'var(--fg-3)', flex: 'none' }}>▴</span>
      </button>
      {open && (
        <div ref={panelRef} className="card card-float" role="listbox" style={{
          position: 'absolute', [below ? 'top' : 'bottom']: 'calc(100% + 6px)',
          [align === 'right' ? 'right' : 'left']: align === 'right' ? -clamp.shift : clamp.shift, zIndex: 40,
          // min·max 동시 클램프(#350 교훈: min > max면 min이 이겨 클램프 무효) — 실측 전(maxW 0,
          // 불투명 0 프레임)엔 자연 폭 그대로 재고, 실측 후 뷰포트 상한을 건다. 100vw 근사는
          // 스크롤바 폭만큼 새서(실측 1280 vs clientWidth 1264) 상한도 계산부(clientWidth)가 낸다.
          minWidth: clamp.maxW ? Math.min(Math.max(width, 190), clamp.maxW) : Math.max(width, 190),
          maxWidth: clamp.maxW || undefined, maxHeight: 300, overflowY: 'auto', padding: 6,
          boxShadow: '0 8px 28px rgba(0,0,0,.14)', transformOrigin: `${below ? 'top' : 'bottom'} ${align}`,
          transform: entered ? 'none' : `scale(0.97) translateY(${below ? -4 : 4}px)`, opacity: entered ? 1 : 0,
          transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1), opacity 160ms cubic-bezier(0.23,1,0.32,1)' }}>
          {groups.map((g, gi) => (
            <div key={g.label ?? gi} style={{ padding: '2px 0' }}>
              {g.label && <div className="microlabel" style={{ padding: '4px 8px 2px' }}>{g.label}</div>}
              {g.items.map((it) => {
                const active = it.value === value;
                return (
                  <button key={String(it.value)} type="button" role="option" aria-selected={active} disabled={it.disabled}
                    onClick={() => { onChange(it.value); setOpen(false); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                      background: active ? 'var(--card-2)' : 'none', border: 0, borderRadius: 7,
                      cursor: it.disabled ? 'not-allowed' : 'pointer', padding: '6px 8px', fontSize: 12.5,
                      color: it.disabled ? 'var(--fg-3)' : 'var(--fg)', opacity: it.disabled ? 0.55 : 1 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                    {it.badge && <span className="microlabel" style={{ fontSize: 9.5, color: 'var(--fg-3)' }}>{it.badge}</span>}
                    {active && <span aria-hidden style={{ fontSize: 11, color: 'var(--fg-2)' }}>✓</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 베타 피드백 — 인앱에서 작성하면 서버(/api/feedback)가 Supabase에 저장한다. 브라우저(메일앱)를 열지 않는다. */
/** 가로 탭 바 — 설정·크루 카드 공용(크루 서랍 .crew-tab과 같은 룩). tabs: [{ id, label, count?, tone? }] */
export function Tabs({ tabs, value, onChange, label, className = '' }) {
  return (
    <div className={`tabbar ${className}`.trim()} role="tablist" aria-label={label}>
      {tabs.map((tb) => (
        <button key={tb.id} type="button" role="tab" className="tab" aria-selected={value === tb.id} data-tone={tb.tone || undefined}
          onClick={() => onChange(tb.id)}>
          {tb.label}{tb.count != null && <span className="tab-n">{tb.count}</span>}
        </button>
      ))}
    </div>
  );
}
/** 마지막 탭 기억 — localStorage(기기 편의). 우선순위는 tabs-state.mjs(resolveTab): ?tab= → 저장값 → 기본.
    저장값은 **마운트 뒤**에 적용한다(i18n `argo-lang`·theme와 같은 관례) — 초기 렌더에서 localStorage를 읽으면 서버 HTML(기본 탭)과
    클라 첫 렌더가 달라 하이드레이션 불일치가 난다(분리 검수 실측: 서버가 그린 '일반'이 0.5초 보였다 교체). storage 접근은 전부 try/catch. */
export function useRememberedTab(key, ids, fallback, queryTab) {
  const [tab, setTabState] = useState(() => resolveTab({ query: queryTab, stored: null, ids, fallback }));
  useEffect(() => {
    if (queryTab && ids.includes(queryTab)) { setTabState(queryTab); return; } // 딥링크가 저장값보다 우선(같은 페이지 ?tab= 이동 포함)
    let stored = null;
    try { stored = localStorage.getItem(key); } catch { /* 저장소 차단 — 기본 탭 유지 */ }
    if (stored && ids.includes(stored)) setTabState(stored);
  }, [key, queryTab, ids]);
  const setTab = (id) => { setTabState(id); try { localStorage.setItem(key, id); } catch { /* 저장 실패는 무시 */ } };
  return [tab, setTab];
}

export function FeedbackModal({ onClose }) {
  const { t } = useLang();
  useScrollLock();
  const [text, setText] = useState('');
  const [state, setState] = useState(''); // '' | 'sending' | 'sent' | 'error'
  const [errMsg, setErrMsg] = useState(''); // 서버가 갈라준 실패 사유 — 있으면 제네릭 대신 이걸 보여준다
  // 이 배포가 제보를 공개 이슈로 옮기는가 — 켜져 있을 때만 고지한다(꺼진 배포에선 거짓말이 된다)
  const [publicIssues, setPublicIssues] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/api/feedback').then((r) => r.json()).then((d) => { if (live) setPublicIssues(!!d.publicIssues); }).catch(() => {});
    return () => { live = false; };
  }, []);
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
      // 서버가 원인을 갈라준 문구(세션 만료 등)는 그대로 보여준다 — 제네릭 "다시 시도"는
      // 재시도로 안 풀리는 상태(재로그인 필요)를 영원히 숨긴다(실측 2026-08-14).
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || '');
      setState('sent');
      setTimeout(onClose, 1300);
    } catch (e) { setErrMsg(e?.message || ''); setState('error'); }
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
              {publicIssues && <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0, lineHeight: 1.6 }}>{t('feedback.publicNote')}</p>}
              <textarea suppressHydrationWarning value={text} onChange={(e) => setText(e.target.value)} placeholder={t('feedback.placeholder')}
                rows={5} autoFocus {...imeGuard}
                style={{ padding: '10px 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }} />
              {state === 'error' && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{errMsg || t('feedback.error')}</span>}
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

/** Tauri 데스크톱 감지 — 분산 복제 방지용 단일 출처(분리 검수 MEDIUM 2026-07-28). */
export const isTauriApp = () => typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || navigator.userAgent.includes('Tauri'));

/** 산출물 다운로드 onClick — 데스크톱 앱은 <a download>가 무동작(WKWebView/WebView2, 실사용 제보
    2026-08-07: "채팅·산출물에서 클릭해도 다운로드 안 됨 — 크루에게 저장을 시켜야 했다")이라
    가로채서 바이트를 IPC로 넘겨 다운로드 폴더에 저장하고, 저장된 파일을 파인더/탐색기에
    하이라이트해 보여준다(reveal = 완료 피드백). 브라우저는 기본 앵커(download 속성)가 담당 —
    핸들러가 아무것도 하지 않고 즉시 반환한다. 앵커 href에 함께 붙는 &download=1은 브라우저
    폴백용(서버가 Content-Disposition: attachment로 응답 — download 속성 유실 상황도 방어). */
// IPC 상한 — 바이트가 JSON 배열로 직렬화되므로 큰 파일은 웹뷰를 얼린다. 넘으면 서버 강제
// 다운로드(&download=1)로 넘긴다: 웹뷰가 못 받으면 못 받는 대로 브라우저 경로가 받는다
// (검수 MEDIUM 2026-08-07 — "무동작"이 "앱 정지"로 바뀌는 실패를 만들지 않는다).
const DOWNLOAD_IPC_CAP = 25 * 1024 * 1024;

/** 결제 포털 열기 — 세션을 가진 이 문맥이 URL을 받아, 외부 URL만 연다.
    앱 웹뷰는 302를 못 따라가고(CSP), 링크를 시스템 브라우저로 넘기면 기기 마커 쿠키가 없어 401이
    된다(둘 다 막다른 길 — 실측 2026-08-19). 실패는 앵커 기본 동작(라우트가 원인 문구로 응답)에 맡긴다. */
export function openBillingPortal(e) {
  e.preventDefault();
  fetch('/api/me/billing/portal?json=1')
    .then((r) => (r.ok ? r.json() : null))
    .then(async (j) => {
      if (!j?.url) { window.location.href = '/api/me/billing/portal'; return; } // 원인 문구를 보여준다
      if (isTauriApp()) await import('@tauri-apps/plugin-opener').then((m) => m.openUrl(j.url));
      else window.open(j.url, '_blank', 'noopener');
    })
    .catch(() => { window.location.href = '/api/me/billing/portal'; });
}

export function artifactDownload(url, name) {
  return async (e) => {
    if (!isTauriApp()) return; // 브라우저 — <a download> 기본 동작 유지
    e.preventDefault();
    // 실패·초과 시 공통 폴백 — 서버가 attachment로 응답하는 URL로 항해한다. 조용한 무동작으로
    // 끝내면 이 기능이 고치려던 증상(클릭해도 아무 일 없음)과 화면이 같아진다(검수 MEDIUM).
    const fallback = () => { window.location.href = url.includes('?') ? `${url}&download=1` : `${url}?download=1`; };
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      if (blob.size > DOWNLOAD_IPC_CAP) { fallback(); return; }
      const buf = new Uint8Array(await blob.arrayBuffer());
      const { invoke } = await import('@tauri-apps/api/core');
      const path = await invoke('save_download', { name, data: Array.from(buf) });
      // 저장 위치 공개 — 실패해도 저장 자체는 됐으므로 조용히 무시(구버전 바이너리 등)
      await import('@tauri-apps/plugin-opener').then((m) => m.revealItemInDir(path)).catch(() => {});
    } catch (err) {
      console.error('[argo] 산출물 저장 실패 — 서버 다운로드로 폴백:', err?.message ?? err);
      fallback();
    }
  };
}

// 픽커가 한 번 실패하면 앱 전체가 기억한다 — 실패는 기기 단위 사실(구버전 바이너리에 dialog
// 플러그인 부재 등)이라, 카드마다 한 번씩 헛클릭시킬 이유가 없다(분리 검수 LOW-3).
// 성공하면 반드시 되돌린다: 안 내리면 "픽커가 방금 멀쩡히 열렸는데 열 수 없다고 말하는" 거짓말이
// 남는다(재검수 LOW-1) — 이 플래그로 막으려던 바로 그 오류다.
// 이벤트로도 알린다 — 이미 떠 있는 카드들은 마운트 이펙트를 다시 돌지 않아 플래그만으론 안 배운다(재검수 LOW-2).
export const FOLDER_DIALOG_EVENT = 'argo:folder-dialog';
let folderDialogBroken = false;
export const isFolderDialogBroken = () => folderDialogBroken;
function setFolderDialogBroken(v) {
  if (folderDialogBroken === v) return;
  folderDialogBroken = v;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FOLDER_DIALOG_EVENT));
}

/** 네이티브 폴더 대화상자 — 경로 문자열 또는 null(사용자 취소). **실패는 throw한다.**
    취소와 실패를 부르는 쪽이 갈라야 하는 이유: 픽커가 죽은 채(구버전 바이너리엔 dialog
    플러그인이 없다 — v0.1.32 실사고) 경로 입력 폴백까지 감춰버리면 막다른 길이 된다. */
export async function openFolderDialog(title) {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true, multiple: false, title });
    setFolderDialogBroken(false); // 열렸다 = 이 기기에서 픽커는 살아 있다(과거 실패 기록 무효화)
    return typeof dir === 'string' && dir ? dir : null;
  } catch (e) {
    setFolderDialogBroken(true);
    console.warn('[argo] 폴더 픽커 실패:', e?.message ?? e);
    throw e; // 부르는 쪽이 폴백을 열고 **사유를 표시**해야 한다 — 삼키면 v0.1.32 사고 재현
  }
}
