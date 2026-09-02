'use client';
// 보조 패널 — 본문 옆에 다른 크루 DM 또는 기억 문서를 나란히 연다. 상태는 ?side= 하나(split.mjs).
// 크루: CrewChat을 embedded로 그대로 임베드(초안·대기열 키 공유). 문서: vault API로 읽어 Markdown.
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Markdown, Skeleton, api } from '../../ui';
import { useLang } from '../../i18n';
import CrewChat from './crew/[slug]/page';
import { withSide } from './split.mjs';
// 표시 배율(zoom) — 커서 좌표는 뷰포트 px, 패널 폭은 CSS px라 배율로 나눠 맞춘다(배율 1 = 종전 동일)
import { dispZoom, clampPaneW as clampW } from './zoom-math.mjs';

const W_KEY = 'argo-split-w';
const W_DEFAULT = 480;

function DocPane({ ws, rel, side }) {
  const { t } = useLang();
  const [doc, setDoc] = useState(null); // null 로딩 | { content } | { error }
  useEffect(() => {
    let alive = true;
    setDoc(null);
    api(`/api/companies/${ws}/vault?rel=${encodeURIComponent(rel)}`)
      .then((d) => { if (alive) setDoc({ content: d.content ?? '' }); })
      .catch((e) => { if (alive) setDoc({ error: String(e?.message || e) }); });
    return () => { alive = false; };
  }, [ws, rel]);
  return (
    <div className="split-doc">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{rel}</span>
        {/* 기억 페이지는 ?doc=<rel>로 문서 선택을 받는다 — 패널은 유지한 채 주 화면만 이동 */}
        <Link className="btn sm" href={withSide(`/c/${ws}/vault?doc=${encodeURIComponent(rel)}`, side)} style={{ flex: 'none', textDecoration: 'none' }}>
          {t('split.openInVault')}
        </Link>
      </div>
      {doc === null ? <><Skeleton h={18} w="60%" /><Skeleton h={120} style={{ marginTop: 10 }} /></>
        : doc.error ? <div className="empty">{t('split.docMissing')}</div>
        : <Markdown text={doc.content} />}
    </div>
  );
}

/** side = { type:'crew'|'doc', key } (layout이 parseSide한 값), sideStr = 원문(링크 유지용). */
export function SplitPane({ ws, side, sideStr, title, subtitle, onClose }) {
  const { t } = useLang();
  const [w, setW] = useState(W_DEFAULT);
  const [resizing, setResizing] = useState(false);
  const wRef = useRef(W_DEFAULT);
  useEffect(() => {
    try { const v = Number(localStorage.getItem(W_KEY)); if (v) { wRef.current = clampW(v); setW(wRef.current); } } catch { /* 저장 불가 — 기본 폭 */ }
  }, []);
  useEffect(() => {
    if (!resizing) return;
    // 패널은 뷰포트 우측 끝에 붙어 있다 — 폭 = 뷰포트 우측 가장자리 − 커서 x
    const onMove = (e) => { wRef.current = clampW((window.innerWidth - e.clientX) / dispZoom()); setW(wRef.current); };
    const onUp = () => {
      setResizing(false);
      try { localStorage.setItem(W_KEY, String(wRef.current)); } catch { /* 무시 */ }
    };
    document.body.classList.add('split-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.classList.remove('split-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  // use(params)는 캐시된 프라미스를 기대한다 — 렌더마다 새 프라미스를 주면 매번 서스펜드한다
  const crewParams = useMemo(() => Promise.resolve({ ws, slug: side.key }), [ws, side.key]);
  return (
    <aside className="split-pane" style={{ '--split-w': `${w}px` }} aria-label={title}>
      <div className={`split-handle${resizing ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); setResizing(true); }} aria-hidden="true" />
      {/* 헤더 = 크루명 + 역할(주 화면 헤더와 같은 배치) + 닫기. '전체 화면으로(→)' 버튼은 뺐다 — 닫기와 기능이
          겹쳐 보인다는 실사용 지적(유건 2026-09-02). 패널의 뱃지(세션·카드·새 대화)도 임베드에서는 그리지 않는다. */}
      <div className="split-head">
        <span className="split-title" title={title}>{title}</span>
        {subtitle && (
          <span className="nav-sub" title={subtitle} style={{ maxWidth: 180, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn sm" onClick={onClose} title={t('split.close')} aria-label={t('split.close')} style={{ padding: '0 8px' }}>✕</button>
      </div>
      <div className="split-body">
        {side.type === 'crew' ? (
          <div className="split-chat">
            {/* key=slug — 크루가 바뀌면 상태(스레드·입력)를 새로 시작 */}
            <CrewChat key={side.key} params={crewParams} embedded onClose={onClose} />
          </div>
        ) : (
          <DocPane ws={ws} rel={side.key} side={sideStr} />
        )}
      </div>
    </aside>
  );
}
