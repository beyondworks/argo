// 페이지 — 블록 편집(지연 로드), 파일 끌어다 놓기(최대 50MB), 공유·비공개·버전·우클릭. 저장 버튼 없음.
import { lazy, Suspense, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { t, ago, useLang } from '../core/i18n.js';
import { useStore } from '../core/store.js';
import { dragHasFiles, filesFromTransfer, fmtBytes, MAX_FILE } from '../core/files.js';

const Editor = lazy(() => import('./Editor.jsx'));

export function PageView({ id }) {
  useLang();
  const page = useStore((s) => s.pages.find((p) => p.id === id));
  const [over, setOver] = useState(false);
  const [files, setFiles] = useState([]);
  if (!page) return <div className="page-wrap"><div className="empty-state"><Icon name="doc" size={20} /><p>{t('trash.empty')}</p></div></div>;
  const drop = (e) => {
    e.preventDefault(); setOver(false);
    const list = filesFromTransfer(e.dataTransfer);
    const ok = list.filter((f) => f.size <= MAX_FILE);
    if (ok.length < list.length) showToast(t('page.tooBig'));
    if (!ok.length) return;
    // 초안: 진행률을 흉내 낸다(P1: XHR 업로드 진행률 → 버킷 office)
    const added = ok.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, size: f.size, pct: 0 }));
    setFiles((cur) => [...cur, ...added]);
    added.forEach((a) => { let p = 0; const tick = setInterval(() => { p = Math.min(100, p + 20 + Math.random() * 30); setFiles((cur) => cur.map((x) => (x.key === a.key ? { ...x, pct: p } : x))); if (p >= 100) clearInterval(tick); }, 160); });
    showToast(t('page.uploaded', { n: ok.length }));
  };
  return (
    <div className={`page-wrap doc${over ? ' file-over' : ''}`} onDragOver={(e) => { if (dragHasFiles(e.dataTransfer)) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }} onDrop={drop}>
      <div className="doc-meta">
        {page.restricted && <span className="badge"><Icon name="lock" size={12} />{t('page.restricted')}</span>}
        <span className="dim small">{t('page.edited', { when: ago(page.updated) })}</span>
      </div>
      {page.restricted && <p className="restricted-note"><Icon name="lock" size={12} />{t('page.restrictedNote')}</p>}
      <Suspense fallback={<div className="prose skeleton-lines"><span /><span /><span /></div>}><Editor key={page.id} page={page} /></Suspense>
      {files.length > 0 && <div className="attachments">
        {files.map((f) => <div key={f.key} className="attachment"><Icon name="file" size={14} /><span className="mono-name">{f.name}</span><small className="mono dim">{fmtBytes(f.size)}</small>
          {f.pct < 100 ? <span className="progress"><span style={{ width: `${f.pct}%` }} /></span> : <Icon name="check" size={14} className="ok" />}</div>)}
      </div>}
      {over && <div className="drop-hint page">{t('page.dropFiles')}</div>}
    </div>
  );
}
