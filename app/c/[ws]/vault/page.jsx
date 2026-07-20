'use client';
// 기억 — 3D 지식 그래프(공유 엔진) + 기록 표 + 종이 뷰어. 탑바 검색으로 필터.
import { Suspense, use, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon, Markdown, Spinner, Skeleton, DangerModal, api, imeGuard, timeAgo, tsFromRel } from '../../../ui';
import { Constellation3D, GraphModal } from '../graphview';
import { useLang } from '../../../i18n';

export default function VaultPage({ params }) {
  return (
    <Suspense>
      <Vault params={params} />
    </Suspense>
  );
}

function Vault({ params }) {
  const { ws } = use(params);
  const { t, lang } = useLang();
  const initialDoc = useSearchParams().get('doc');
  const [docs, setDocs] = useState(null);
  const [projects, setProjects] = useState([]); // 크루 산출물(vault/projects/) — 기억과 별도 축
  const [selected, setSelected] = useState(initialDoc || null);
  const [content, setContent] = useState('');
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [q, setQ] = useState('');
  const [meta, setMeta] = useState(null); // 회사·크루 — 그래프 허브용
  const [graphOpen, setGraphOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteMsg, setNoteMsg] = useState('');

  function loadDocs() {
    return api(`/api/companies/${ws}/vault`)
      .then((d) => { setDocs(d.docs); setProjects(d.projects ?? []); })
      .catch(() => setDocs([]));
  }
  useEffect(() => {
    loadDocs();
    api(`/api/companies/${ws}`).then(setMeta).catch(() => setMeta({}));
  }, [ws]);

  async function saveNote(e) {
    e.preventDefault();
    if (savingNote || !noteTitle.trim() || !noteBody.trim()) return;
    setSavingNote(true); setNoteMsg('');
    try {
      const r = await api(`/api/companies/${ws}/vault`, { title: noteTitle, content: noteBody });
      setNoteTitle(''); setNoteBody(''); setComposing(false);
      await loadDocs();
      setSelected(r.rel);
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (err) {
      setNoteMsg(String(err.message));
    } finally {
      setSavingNote(false);
    }
  }

  useEffect(() => {
    const h = (e) => setQ(String(e.detail || '').toLowerCase());
    window.addEventListener('argo:search', h);
    return () => window.removeEventListener('argo:search', h);
  }, []);

  useEffect(() => {
    if (!selected) { setContent(''); return; }
    let live = true; // 문서 A→B 빠른 전환 시 느린 A 응답이 B 화면을 덮는 것 차단
    setLoadingDoc(true);
    api(`/api/companies/${ws}/vault?rel=${encodeURIComponent(selected)}`)
      .then((d) => { if (live) setContent(d.content); })
      .catch((e) => { if (live) setContent(t('vault.docUnavailable', { msg: e.message })); })
      .finally(() => { if (live) setLoadingDoc(false); });
    return () => { live = false; };
  }, [ws, selected]);

  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMsg, setConsolidateMsg] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [mutating, setMutating] = useState(false);
  const [actionMsg, setActionMsg] = useState(''); // 편집·삭제 실패 인라인 표시 — 네이티브 alert 금지(Tauri 무동작)
  const viewerRef = useRef(null);
  /** 그래프에서 기억 클릭 — 뷰어에 열고 화면을 그 자리로 끌어온다(클릭했는데 아무 변화 없어 보이는 것 방지). */
  const openFromGraph = (rel) => {
    setSelected(rel);
    requestAnimationFrame(() => viewerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  useEffect(() => { setEditing(false); setActionMsg(''); }, [selected]); // 문서를 바꾸면 편집 모드·에러 해제

  /** 주제 노트 직접 수정 — 크루가 다음 턴부터 바로 이 내용을 읽는다. */
  async function saveEdit() {
    if (mutating) return;
    setMutating(true);
    try {
      await fetch(`/api/companies/${ws}/vault`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rel: selected, content: draft }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      setContent(draft); setEditing(false);
      loadDocs();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) {
      setActionMsg(String(e.message));
    } finally {
      setMutating(false);
    }
  }

  const [deleteOpen, setDeleteOpen] = useState(false);
  async function removeNote() {
    setMutating(true);
    try {
      await fetch(`/api/companies/${ws}/vault?rel=${encodeURIComponent(selected)}`, { method: 'DELETE' })
        .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      setSelected(null); setDeleteOpen(false);
      loadDocs();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) {
      setDeleteOpen(false); // 모달을 내리고 뷰어에 실패 사유 표시
      setActionMsg(String(e.message));
    } finally {
      setMutating(false);
    }
  }

  async function consolidate() {
    if (consolidating) return;
    setConsolidating(true); setConsolidateMsg('');
    try {
      const r = await api(`/api/companies/${ws}/vault/consolidate`, {});
      setConsolidateMsg(r.notes.length ? t('vault.notesUpdated', { n: r.notes.length }) : t('vault.nothingToConsolidate'));
      await loadDocs();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) {
      setConsolidateMsg(String(e.message));
    } finally {
      setConsolidating(false);
    }
  }

  const openWiki = (name) => setSelected(name.endsWith('.md') ? name : `${name}.md`);
  const visible = (docs ?? []).filter((d) => !q || d.title.toLowerCase().includes(q) || d.excerpt.toLowerCase().includes(q));
  // 주제 노트가 1급 시민 — 일지·이전 기록은 근거 추적용 보관함(접힘)으로 강등
  const notes = visible.filter((d) => d.dir === 'notes').sort((a, b) => b.mtime - a.mtime);
  const archives = visible.filter((d) => d.dir !== 'notes');
  // 산출물도 탑바 검색을 태운다 — 제목·프로젝트 폴더명 매칭
  const visibleProjects = (projects ?? []).filter((d) => !q || d.title.toLowerCase().includes(q) || d.project.toLowerCase().includes(q));
  const selectedDoc = (docs ?? []).find((d) => d.rel === selected);

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span className="microlabel">{t('vault.header')}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          {consolidateMsg && <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{consolidateMsg}</span>}
          <span className="microlabel">{docs ? t('vault.records', { n: docs.length }) : ''}</span>
          <button className="btn sm" onClick={consolidate} disabled={consolidating} title={t('vault.consolidateHint')}>
            {consolidating ? <Spinner size={12} /> : <><Icon name="bolt" size={13} /> {t('vault.consolidate')}</>}
          </button>
          <button className="btn sm" onClick={() => setComposing((v) => !v)}>
            <Icon name="plus" size={13} /> {t('vault.writeNote')}
          </button>
        </span>
      </div>

      {composing && (
        <form onSubmit={saveNote} className="card fade-up" style={{ padding: 18, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="card-title">{t('vault.knowledgeNote')}</span>
            <span className="microlabel">{t('vault.autoLinkOnSave')}</span>
          </div>
          <input suppressHydrationWarning
            className="input-bar"
            style={{ display: 'block', height: 38, padding: '0 14px', borderRadius: 10, outline: 'none' }}
            placeholder={t('vault.titlePlaceholder')}
            value={noteTitle}
            onChange={(e) => setNoteTitle(e.target.value)}
            {...imeGuard}
          />
          <textarea
            placeholder={t('vault.bodyPlaceholder')}
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
            style={{
              width: '100%', minHeight: 130, resize: 'vertical',
              background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12,
              padding: '10px 14px', outline: 'none', fontSize: 13, lineHeight: 1.65,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-primary sm" disabled={savingNote || !noteTitle.trim() || !noteBody.trim()}>
              {savingNote ? <Spinner size={12} /> : t('vault.saveToMemory')}
            </button>
            <button type="button" className="btn sm" onClick={() => setComposing(false)}>{t('vault.cancel')}</button>
            {noteMsg && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{noteMsg}</span>}
          </div>
        </form>
      )}

      {docs === null ? (
        <>
          <Skeleton h={200} style={{ borderRadius: 16 }} />
          <Skeleton h={320} style={{ borderRadius: 16 }} />
        </>
      ) : docs.length === 0 && (projects?.length ?? 0) === 0 ? (
        <div className="empty">{t('vault.empty')}</div>
      ) : (
        <>
          <div className="card" style={{ padding: '14px 18px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="card-title">{t('vault.graphTitle')}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <span className="chip"><span className="dot" />{t('vault.conversation')}</span>
                <span className="chip"><span style={{ width: 5, height: 5, borderRadius: 999, border: '1px solid currentColor' }} />{t('vault.note')}</span>
                <button className="chip" onClick={() => setGraphOpen(true)} style={{ cursor: 'pointer' }}>{t('vault.viewLarge')}</button>
              </div>
            </div>
            {meta ? (
              <Constellation3D company={meta.company} delegations={meta.delegations} agents={meta.agents ?? []} docs={docs} height={240} onOpen={() => setGraphOpen(true)} onSelectDoc={openFromGraph} />
            ) : (
              <Skeleton h={240} style={{ margin: '8px 0' }} />
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 14, alignItems: 'start' }}>
            {/* 기록 패널 — 탑바(56px) 아래 고정, 목록은 자체 스크롤. 우측 뷰어만 페이지와 함께 흐른다 */}
            <div className="card" style={{ position: 'sticky', top: 70, maxHeight: 'calc(100vh - 92px)', overflowY: 'auto' }}>
              <div className="card-head" style={{ paddingBottom: 10 }}>
                <span className="card-title">{t('vault.records2')}</span>
                <span className="chip">{visible.length}</span>
              </div>
              {visible.length === 0 && (
                <p style={{ padding: '0 18px 16px', color: 'var(--fg-2)', fontSize: 13 }}>{t('vault.noMemoryMatch')}</p>
              )}
              <div className="microlabel" style={{ padding: '8px 18px 4px' }}>
                {t('vault.knownByCompany', { n: notes.length })}
              </div>
              {notes.length === 0 && (
                <p style={{ padding: '4px 18px 12px', color: 'var(--fg-2)', fontSize: 12 }}>
                  {t('vault.noOrganizedYet')}
                </p>
              )}
              {notes.map((d) => <DocRow key={d.rel} d={d} active={selected === d.rel} onOpen={setSelected} icon="bolt" lang={lang} />)}
              {/* 크루 산출물(projects/) — md는 종이 뷰어, 그 외는 즉시 다운로드.
                  이전엔 어떤 목록에도 안 잡혀 Finder로 긴 경로를 찾아가야 했다(고객 신고 2026-07-20). */}
              {visibleProjects.length > 0 && (
                <>
                  <div className="microlabel" style={{ padding: '10px 18px 4px', borderTop: '1px dashed var(--border-soft)' }}>
                    {t('vault.projectsGroup', { n: visibleProjects.length })}
                  </div>
                  {visibleProjects.map((d) => d.binary ? (
                    <a key={d.rel} className="row" download
                      href={`/api/companies/${ws}/files?rel=${encodeURIComponent(d.rel)}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}>
                      <span style={{ display: 'inline-flex', color: 'var(--fg-2)', flex: 'none' }}><Icon name="clip" size={14} /></span>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{d.title}</span>
                        <span className="mono" style={{ display: 'block', fontSize: 10, color: 'var(--fg-3)', marginTop: 1 }}>
                          {d.project && `${d.project} · `}{fmtSize(d.size)} · {timeAgo(d.mtime, lang)}
                        </span>
                      </span>
                      <span className="microlabel" style={{ flex: 'none' }}>{t('vault.download')}</span>
                    </a>
                  ) : (
                    <DocRow key={d.rel} d={{ ...d, links: d.links ?? [] }} active={selected === d.rel} onOpen={setSelected} icon="doc" lang={lang} />
                  ))}
                </>
              )}
              {archives.length > 0 && (
                <>
                  <button className="microlabel" onClick={() => setShowArchive((v) => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '10px 18px 6px', borderTop: '1px dashed var(--border-soft)', cursor: 'pointer' }}>
                    <span style={{ display: 'inline-block', transform: showArchive ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
                    {t('vault.archiveToggle', { n: archives.length })}
                  </button>
                  {showArchive && archives.map((d) => <DocRow key={d.rel} d={d} active={selected === d.rel} onOpen={setSelected} icon="doc" lang={lang} />)}
                </>
              )}
            </div>

            <div ref={viewerRef} className="card" style={{ padding: 24, minHeight: 340, scrollMarginTop: 84 }}>
              {!selected ? (
                <div style={{ color: 'var(--fg-2)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="doc" size={14} /> {t('vault.selectHint')}
                </div>
              ) : loadingDoc ? (
                <Spinner />
              ) : (
                <div style={{ maxWidth: 860 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', letterSpacing: '0.03em', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected}</span>
                    {selectedDoc?.dir === 'notes' && !editing && (
                      <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
                        <button className="btn sm" onClick={() => { setDraft(content); setEditing(true); }}>
                          <Icon name="edit" size={12} /> {t('vault.edit')}
                        </button>
                        <button className="btn sm" onClick={() => setDeleteOpen(true)} disabled={mutating} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
                          <Icon name="trash" size={12} /> {t('vault.delete')}
                        </button>
                      </span>
                    )}
                  </div>
                  {actionMsg && <p style={{ margin: '-6px 0 12px', fontSize: 12, color: 'var(--danger)' }}>{actionMsg}</p>}
                  {editing ? (
                    <div style={{ display: 'grid', gap: 10 }}>
                      <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                        style={{ width: '100%', minHeight: 380, resize: 'vertical', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', outline: 'none', fontSize: 12.5, lineHeight: 1.7, fontFamily: 'var(--font-mono, monospace)' }} />
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button className="btn btn-primary sm" onClick={saveEdit} disabled={mutating || !draft.trim()}>
                          {mutating ? <Spinner size={12} /> : t('vault.save')}
                        </button>
                        <button className="btn sm" onClick={() => setEditing(false)} disabled={mutating}>{t('vault.cancel')}</button>
                        <span className="metric-sub2">{t('vault.saveHint')}</span>
                      </div>
                    </div>
                  ) : (
                    <Markdown text={content} onWikiLink={openWiki} />
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {deleteOpen && (
        <DangerModal
          title={t('vault.deleteTitle')}
          description={t('vault.deleteDesc')}
          requireText={selectedDoc?.title ?? ''}
          phraseKey="danger.phrase.delete"
          confirmLabel={t('vault.deleteConfirm')}
          busy={mutating}
          onConfirm={removeNote}
          onClose={() => setDeleteOpen(false)}
        />
      )}
      {graphOpen && meta && docs && (
        <GraphModal
          ws={ws}
          company={meta.company}
          agents={meta.agents ?? []}
          delegations={meta.delegations}
          docs={docs}
          onClose={() => setGraphOpen(false)}
          onSelect={(rel) => { setGraphOpen(false); openFromGraph(rel); }}
        />
      )}
    </div>
  );
}

/** 기록 패널 행 — 주제 노트와 보관함이 같은 문법을 쓴다. */
/** 파일 크기 표시 — 산출물 다운로드 행 전용(대략치면 충분). */
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round((b ?? 0) / 1024))}KB`);

function DocRow({ d, active, onOpen, icon, lang }) {
  return (
    <button onClick={() => onOpen(d.rel)} className={`row${active ? ' active' : ''}`}>
      <span style={{ display: 'inline-flex', color: 'var(--fg-2)', flex: 'none' }}>
        <Icon name={icon} size={14} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: active ? 700 : 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {d.title}
        </span>
        <span className="mono" style={{ display: 'block', fontSize: 10, color: 'var(--fg-3)', marginTop: 1 }}>
          {timeAgo(tsFromRel(d.rel) ?? d.mtime, lang)}{d.links.length > 0 && ` · LINK ${d.links.length}`}
        </span>
      </span>
    </button>
  );
}
