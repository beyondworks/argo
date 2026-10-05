// 페이지 — 블록 편집(지연 로드), 파일 끌어다 놓기(문서함에 저장하고 놓은 자리에 '/파일' 블록), 공유·비공개·버전·우클릭. 저장 버튼 없음.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { t, ago, useLang, getLang, registerDict } from '../core/i18n.js';
import { PAGEVIEW_DICT } from './pageview-i18n.js';
import { useStore, createPage, savePage, trashPage, getState } from '../core/store.js';
import { navigate, Link } from '../core/router.jsx';
import { LoadFail } from '../ui/LoadFail.jsx';
import { baseOf } from '../core/commands.js';
import { menuProps } from '../ui/Menu.jsx';
import { useUi, setUi } from '../core/ui-state.js';
import { loadPageContent } from '../core/pull.js';
import { outbox } from '../core/sync.js';
import { canManage, getMode } from '../core/session.js';
import { restore, forget, heldKey } from '../core/save.js';
import { dragHasFiles, filesFromTransfer, fmtBytes } from '../core/files.js';
import { blockAfter, dropSpot } from './drop-spot.js';
import { serverVersion, shouldReload, pageBusy } from '../core/page-live.js';

registerDict(PAGEVIEW_DICT);

const Editor = lazy(() => import('./Editor.jsx'));

/** 다른 기기가 먼저 저장했을 때 — 사람이 고른다: 서버 값으로 새로 불러오기 / 내 변경을 사본으로 지키기 */
function ConflictBanner({ page }) {
  const reload = async () => { forget(heldKey(page.id)); await outbox.drop(`page:${page.id}`); await loadPageContent(page.id, { force: true }); setUi({ conflict: null }); };
  const keepCopy = async () => {
    // 위키 최상위를 못 만드는 사람은 원본 아래에 사본을 둔다
    const mine = restore(heldKey(page.id), null) ?? page;                            // 새로고침 뒤라면 화면은 서버 본문 — 사본은 남겨 둔 내 변경으로
    createPage(page.space, page.parent ?? (canManage(page.space) ? null : page.id), { title: t('page.copyTitle', { title: mine.title || t('page.untitled') }), content: mine.content });
    await reload();
    showToast(t('page.copySaved'));
  };
  return (
    <div className="conflict" role="alert">
      <div><b>{t('page.conflict')}</b><p className="dim small">{t('page.conflictHint')}</p></div>
      <div className="row-actions"><button type="button" className="btn" onClick={keepCopy}>{t('page.conflictCopy')}</button><button type="button" className="btn primary" onClick={reload}>{t('page.conflictReload')}</button></div>
    </div>
  );
}

const hasModules = (doc) => doc?.type === 'moduleGrid' || (doc?.content?.some(hasModules) ?? false);
const isBlank = (doc) => !hasModules(doc) && !JSON.stringify(doc ?? {}).includes('"text"');

/** 빈 새 페이지 아래 "템플릿에서 시작"(유건 9/27, 노션 방식) — 글을 쓰기 시작하면 사라진다. 기본·조직·내 것 3층 */
function TemplatePicker({ page }) {
  useLang();
  const pages = useStore((s) => s.pages);
  const [lib, setLib] = useState(null);
  useEffect(() => { let live = true; import('../data/templates.js').then((m) => live && setLib(m)); return () => { live = false; }; }, []);
  const orgKey = page.space !== 'me' && page.space !== 'shared' ? page.space : null;
  const saved = pages.filter((p) => p.template && p.id !== page.id);
  const org = saved.filter((p) => p.space !== 'me' && (!orgKey || p.space === orgKey));
  const mine = saved.filter((p) => p.space === 'me');
  const apply = (tpl) => savePage(page.id, { title: tpl.title, content: tpl.content, loadedAt: Date.now() }); // loadedAt이 바뀌면 편집기가 새 본문으로 다시 뜬다
  const useSaved = async (tp) => {
    if (tp.content === undefined) await loadPageContent(tp.id);
    const cur = getState().pages.find((x) => x.id === tp.id);
    if (cur?.content) apply({ title: cur.title, content: cur.content });
  };
  const menuFor = (tp) => (tp.space === 'me' || canManage(tp.space) ? [
    { label: t('tpl.edit'), icon: 'doc', run: () => navigate(`${baseOf(tp.space)}/p/${tp.id}`) },
    { label: t('page.trash'), icon: 'trash', danger: true, run: () => showToast(t('page.trashed'), { undo: trashPage(tp.id) }) }, // 다른 휴지통 보내기(commands.js)와 같이 알림·되돌리기(OFC-19)
  ] : [{ heading: t('tpl.readOnly') }]);
  const group = (label, items) => items.length > 0 && <div className="tpl-group"><span className="label">{label}</span><div className="tpl-grid">{items}</div></div>;
  return (
    <section className="tpl-picker" aria-label={t('tpl.start')}>
      <span className="tpl-title">{t('tpl.start')}</span>
      {!lib ? <div className="skeleton-lines"><span /></div> : <>
        {group(t('tpl.basic'), lib.BUILTINS.filter((b) => b.group === 'basic').map((b) => <button key={b.id} type="button" className="tpl-item" onClick={() => apply(lib.builtin(b.id, getLang()))}><Icon name="doc" size={14} className="dim" />{b.title[getLang() === 'en' ? 1 : 0]}</button>))}
        {group(t('tpl.intranet'), lib.BUILTINS.filter((b) => b.group === 'intranet').map((b) => <button key={b.id} type="button" className="tpl-item" onClick={() => apply(lib.builtin(b.id, getLang()))}><Icon name="layout" size={14} className="dim" />{b.title[getLang() === 'en' ? 1 : 0]}</button>))}
        {group(t('tpl.org'), org.map((tp) => <button key={tp.id} type="button" className="tpl-item" onClick={() => useSaved(tp)} {...menuProps(() => menuFor(tp))}><Icon name="person" size={14} className="dim" />{tp.title || t('page.untitled')}</button>))}
        {group(t('tpl.mine'), mine.map((tp) => <button key={tp.id} type="button" className="tpl-item" onClick={() => useSaved(tp)} {...menuProps(() => menuFor(tp))}><Icon name="template" size={14} className="dim" />{tp.title || t('page.untitled')}</button>))}
      </>}
    </section>
  );
}


export function PageView({ id, space }) {
  useLang();
  const page = useStore((s) => s.pages.find((p) => p.id === id));
  const [over, setOver] = useState(false);
  const [files, setFiles] = useState([]); // 올리는 중이거나 실패한 파일만 — 올라간 파일은 본문의 파일 블록이 된다
  const editorRef = useRef(null);
  const { conflict } = useUi();
  const needsBody = page && page.content === undefined;
  const needsAccess = page && page.access === undefined && getMode() !== 'sample';
  const canEdit = page?.access === 'edit' || page?.access === 'full' || (getMode() === 'sample' && page?.space !== 'shared');
  // 목록에는 본문이 없다 — 열 때 불러온다. 못 읽으면 회색 자리 대신 '불러오지 못했습니다 · 다시 시도', 서버에 없으면 '찾을 수 없음'(OFC-06)
  const [load, setLoad] = useState(null), [again, setAgain] = useState(0); // load: null | 'missing' | 'error'
  useEffect(() => {
    if (!needsBody && !needsAccess) return undefined;
    let live = true; setLoad(null);
    loadPageContent(id).then((d) => { if (live && d === null) setLoad('missing'); }, () => { if (live) setLoad('error'); });
    return () => { live = false; };
  }, [id, needsBody, needsAccess, again]);
  useEffect(() => { if (restore(heldKey(id), null)) setUi({ conflict: id }); }, [id]); // 고르지 않은 충돌이 남아 있으면 다시 묻는다
  // 열어 둔 페이지 최신화(16차): 탭·창으로 돌아올 때 판 번호만 읽어 비교하고, 바뀌었으면 본문을 다시 읽는다. 같은 페이지는 10초에 한 번까지,
  // 안 저장한 편집이 있으면 건너뛴다(그 저장이 충돌 안내로 이어진다). 주기 폴링은 없다. 같은 브라우저의 다른 창은 core/page-live.js가 바로 맞춘다
  useEffect(() => {
    if (getMode() !== 'signedIn') return undefined;
    let last = Date.now();
    const check = async () => {
      if (document.hidden || Date.now() - last < 10_000) return;
      last = Date.now();
      const cur = getState().pages.find((p) => p.id === id);
      if (!cur || cur.content === undefined || cur.fresh || pageBusy(id)) return;
      const remote = await serverVersion(id).catch(() => null);
      const now = getState().pages.find((p) => p.id === id);
      if (now && shouldReload({ local: now.version, remote, busy: pageBusy(id) })) loadPageContent(id, { skip: () => pageBusy(id) }).catch(() => {});
    };
    document.addEventListener('visibilitychange', check);
    addEventListener('focus', check);
    return () => { document.removeEventListener('visibilitychange', check); removeEventListener('focus', check); };
  }, [id]);
  // 없는 페이지 — 돌아갈 곳을 함께(UX-O05). 머리줄의 제목·저장됨·별은 App이 숨긴다
  if (!page || load === 'missing') return <div className="page-wrap"><div className="empty-state"><Icon name="doc" size={20} /><p>{t('page.missing')}</p><Link to={baseOf(space ?? 'me')} className="btn sm">{t('cmd.goHome')}</Link></div></div>;
  // 끌어 놓은 파일 → 문서함에 저장(용량·형식 검사는 문서함과 같다) → 놓은 자리에 '/파일' 블록. 예전에는 진행 막대만 흉내 냈다(10/4 PARITY-ALL)
  const drop = async (e) => {
    e.preventDefault(); setOver(false);
    if (!canEdit || page.space === 'shared') return;                               // 공유받은 페이지는 남의 문서함이라 파일 블록을 넣지 않는다(편집기 '/파일'과 같다)
    if (editorRef.current && !editorRef.current.isEditable) return;               // 모르는 내용이 있어 잠긴 편집기 — 올려도 블록이 저장되지 않는다(16차 검수 M3)
    const list = filesFromTransfer(e.dataTransfer);
    if (!list.length) return;
    const ed = editorRef.current;
    const hit = ed && !ed.isDestroyed ? ed.view.posAtCoords({ left: e.clientX, top: e.clientY }) : null;
    // 놓은 줄을 쪼개지 않고 그 줄이 든 맨 바깥 블록 뒤에(목록 안에 들어가지 않는다). 올리는 동안 문서가 바뀌면 그만큼 따라가고, 넣을 때 지금 문서로 다시 맞춘다(범위 밖이면 끝에)
    const spot = dropSpot(ed, hit ? blockAfter(ed.state.doc, hit.pos) : null);
    const rows = list.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, size: f.size, reason: null }));
    const mark = (key, reason) => setFiles((cur) => cur.map((x) => (x.key === key ? { ...x, reason } : x)));
    setFiles((cur) => [...cur, ...rows]);
    let n = 0, up = 0, i = 0;
    try {
      const { uploadOne, refreshFiles } = await import('../files/api.js');
      for (; i < list.length; i++) {
        const key = rows[i].key; // 고친 줄 표시는 나중에 그려지므로 i가 아니라 이 줄의 키를 잡아 둔다
        const r = await uploadOne(page.space, list[i]).catch(() => ({ ok: false, reason: 'request' }));
        if (!r.ok) { mark(key, r.reason); continue; }
        up += 1;
        const live = editorRef.current;
        let placed = false;
        if (live && !live.isDestroyed) {
          try {
            placed = live.chain().insertContentAt(spot.place(live), { type: 'fileRef', attrs: { id: r.file.id, space: page.space, title: r.file.title } }).run();
            if (placed) spot.moved(live.state.selection.to);                          // 여러 개면 놓은 순서대로 이어서
          } catch (err) { console.warn('[office] file block insert failed', err?.message); }
        }
        if (placed) { n += 1; setFiles((cur) => cur.filter((x) => x.key !== key)); }
        else mark(key, 'notPlaced');                                                     // 문서함에는 올라갔다 — 줄이 '올리는 중'에 멈추지 않게 안내로 바꾼다
      }
      if (up) refreshFiles().catch(() => {});
    } catch { for (; i < list.length; i++) mark(rows[i].key, 'request'); }               // 올리기 코드를 못 받았다 — 남은 줄을 실패로
    finally { spot.stop(); }
    if (n) showToast(t('page.uploaded', { n }));
  };
  const reasonText = (r) => (r === 'notPlaced' ? t('page.notPlaced') : t(`files.reason.${r}`) !== `files.reason.${r}` ? t(`files.reason.${r}`) : t('files.err.request'));
  return (
    <div className={`page-wrap doc${hasModules(page.content) ? ' wide' : ''}${over ? ' file-over' : ''}`} onDragOver={(e) => { if (canEdit && dragHasFiles(e.dataTransfer)) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }} onDrop={drop}>
      <div className="doc-meta">
        {page.restricted && <span className="badge"><Icon name="lock" size={12} />{t('page.restricted')}</span>}
        <span className="dim small">{t('page.edited', { when: ago(page.updated) })}</span>
        {canEdit && !needsBody && <button type="button" className="btn sm ghost" onClick={() => navigate(`${baseOf(page.space)}/business/library?target=${encodeURIComponent(page.id)}`)}><Icon name="plus" size={14} />{t('library.addModule')}</button>}
      </div>
      {page.template && <p className="restricted-note"><Icon name="template" size={12} />{t('tpl.editing')}</p>}
      {page.restricted && <p className="restricted-note"><Icon name="lock" size={12} />{t('page.restrictedNote')}</p>}
      {conflict === page.id && <ConflictBanner page={page} />}
      {needsBody && load === 'error' ? <LoadFail onRetry={() => setAgain((n) => n + 1)} />
        : needsBody ? <div className="prose skeleton-lines"><span /><span /><span /></div>
        : <Suspense fallback={<div className="prose skeleton-lines"><span /><span /><span /></div>}><Editor key={`${page.id}:${page.loadedAt ?? 0}`} page={page} canEdit={canEdit} hostRef={editorRef} /></Suspense>}
      {canEdit && !needsBody && !page.template && isBlank(page.content) && <TemplatePicker page={page} />}
      {files.length > 0 && <div className="attachments">
        {files.map((f) => <div key={f.key} className="attachment"><Icon name="file" size={14} /><span className="mono-name">{f.name}</span><small className="mono dim">{fmtBytes(f.size)}</small>
          {f.reason ? <><small role="alert">{reasonText(f.reason)}</small><button type="button" className="icon-btn sm" aria-label={t('close')} onClick={() => setFiles((cur) => cur.filter((x) => x.key !== f.key))}><Icon name="x" size={12} /></button></>
            : <small className="dim" role="status">{t('page.uploading')}</small>}</div>)}
      </div>}
      {over && <div className="drop-hint page">{t('page.dropFiles')}</div>}
    </div>
  );
}
