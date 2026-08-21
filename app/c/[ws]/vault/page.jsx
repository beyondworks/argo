'use client';
// 기억 — 옵시디언식 2패널(2026-07-31 유건 지시: "아래로만 쌓여 보기 어렵다 → 워크트리 + 본문").
// 좌: 파일 트리(그래프 · 노트 · 산출물(프로젝트 폴더) · 일지 · 대화 — 접이식 + 카운트, 자체 스크롤).
// 우: 콘텐츠(기본=지식 그래프 전체 채움, 선택 시=종이 뷰어, 작성 시=노트 폼). 페이지 자체는
// 뷰포트 높이에 고정되어 스크롤이 각 패널 안에서만 일어난다 — 세로 나열 레이아웃 불안정의 종결.
import { Suspense, use, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon, Markdown, Spinner, Skeleton, DangerModal, api, imeGuard, timeAgo, tsFromRel, resolveWikiRel, artifactDownload } from '../../../ui';
import { Graph2D } from '../graph2d'; // 2D 옵시디언식 — 3D 별자리(graphview)는 데크 위젯 전용
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
  const [meta, setMeta] = useState(null); // 회사·크루 — 그래프 크루 연결 토글용
  const [composing, setComposing] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteMsg, setNoteMsg] = useState('');
  // 트리 패널 폭 — 드래그 핸들로 조절, 기기 로컬 기억(localStorage)
  const [treeW, setTreeW] = useState(320);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    const saved = Number(localStorage.getItem('argo-vault-tree-w'));
    if (saved >= 220 && saved <= 560) setTreeW(saved);
  }, []);
  useEffect(() => {
    if (!resizing) return;
    const move = (e) => setTreeW(Math.min(560, Math.max(220, e.clientX - (document.querySelector('.vault-tree')?.getBoundingClientRect().left ?? 0))));
    const up = () => { setResizing(false); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [resizing]);
  useEffect(() => { if (!resizing) localStorage.setItem('argo-vault-tree-w', String(treeW)); }, [treeW, resizing]);

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [mutating, setMutating] = useState(false);
  const [actionMsg, setActionMsg] = useState(''); // 편집·삭제 실패 인라인 표시 — 네이티브 alert 금지(Tauri 무동작)
  /** 그래프에서 기억 클릭 — 우측이 곧바로 뷰어로 바뀐다(2패널이라 스크롤 이동 불필요). */
  const openFromGraph = (rel) => { setComposing(false); setSelected(rel); };

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

  // 위키링크 해석 — 그래프 모달과 공유하는 resolveWikiRel(ui.jsx 정본) 하나로. 산출물(md) 링크까지 연다.
  const openWiki = (name) => setSelected(resolveWikiRel(name, docs, projects));
  const visible = (docs ?? []).filter((d) => !q || d.title.toLowerCase().includes(q) || d.excerpt.toLowerCase().includes(q));
  const notes = visible.filter((d) => d.dir === 'notes').sort((a, b) => b.mtime - a.mtime);
  // 일지·대화를 한 덩어리 "보관함"으로 뭉개지 않는다 — 트리에서 각자 접이식 섹션(옵시디언식).
  const journals = visible.filter((d) => d.dir === 'journal');
  const convs = visible.filter((d) => d.dir !== 'notes' && d.dir !== 'journal');
  // 산출물도 탑바 검색을 태운다 — 제목·프로젝트 폴더명 매칭. 프로젝트 폴더 단위로 묶는다.
  const visibleProjects = (projects ?? []).filter((d) => !q || d.title.toLowerCase().includes(q) || d.project.toLowerCase().includes(q));
  const projectGroups = [];
  {
    const byName = new Map();
    for (const d of visibleProjects) {
      const key = d.project || t('vault.tree.noProject');
      if (!byName.has(key)) { byName.set(key, []); projectGroups.push([key, byName.get(key)]); }
      byName.get(key).push(d);
    }
  }
  const selectedDoc = (docs ?? []).find((d) => d.rel === selected);
  // 백링크 — 이 문서를 [[링크]]로 가리키는 기억. 링크 표기는 세 갈래가 실재한다:
  // 전체 stem("notes/브랜드-전략") · 파일명 stem("브랜드-전략") · 문서 제목("브랜드 전략") — 셋 다 대조
  // (첫 판본이 전체 stem만 봐서 실파일 백링크 2건이 0건으로 나왔다, 격리 서버 실측).
  const selStem = selected ? selected.replace(/\.md$/, '') : null;
  const selBase = selStem ? selStem.split('/').pop() : null;
  const backlinks = selStem
    ? (docs ?? []).filter((d) => d.rel !== selected
      && (d.links ?? []).some((l) => l === selStem || l === selBase || l === selectedDoc?.title))
    : [];
  const dlName = selected ? selected.split('/').pop() : 'memory.md';

  return (
    // 뷰포트 고정 2패널 — 페이지는 안 흐르고 각 패널이 자체 스크롤한다(옵시디언 구조).
    // 높이·모바일 스택은 .vault-split(globals.css) — 인라인이면 미디어쿼리를 못 탄다.
    <div className="vault-split">
      {/* ── 좌: 워크트리 — 카드 껍데기 없는 풀블리드 패널(옵시디언식, 유건 지시 2026-08-21) ── */}
      <div className="vault-tree" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', width: treeW }}>
        {/* 헤더 한 줄 — 제목·카운트·아이콘 버튼 2개(작성·정리). 긴 부제는 뺐다(공간만 먹고 위계를 흐림). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 12px 6px 14px', flex: 'none' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{t('nav.memory')}</span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{docs ? docs.length + (projects?.length ?? 0) : '—'}</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => { setComposing(true); setSelected(null); }} title={t('vault.writeNote')} aria-label={t('vault.writeNote')} style={{ padding: '0 8px' }}>
            <Icon name="plus" size={12} />
          </button>
          <button className="btn sm" onClick={consolidate} disabled={consolidating} title={t('vault.consolidateHint')} aria-label={t('vault.consolidateHint')} style={{ padding: '0 8px' }}>
            {consolidating ? <Spinner size={12} /> : <Icon name="bolt" size={12} />}
          </button>
        </div>
        {/* 트리 전용 검색 — 탑바 검색(argo:search)과 같은 q를 공유한다 */}
        <div style={{ padding: '0 12px 8px 14px', flex: 'none' }}>
          <input suppressHydrationWarning value={q} onChange={(e) => setQ(e.target.value.toLowerCase())} placeholder={t('vault.searchTree')} {...imeGuard}
            style={{ width: '100%', height: 28, padding: '0 10px', fontSize: 12, background: 'var(--card-2)', border: '1px solid var(--border-soft)', borderRadius: 7, outline: 'none' }} />
        </div>
        {consolidateMsg && <span style={{ padding: '0 16px 8px', fontSize: 11.5, color: 'var(--fg-2)', flex: 'none' }}>{consolidateMsg}</span>}
        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 10 }}>
          {docs === null ? (
            <div style={{ padding: '4px 14px' }}><Skeleton h={140} /></div>
          ) : (
            <>
              {/* 그래프 — 트리의 첫 항목. 클릭 = 우측을 그래프로(선택 해제) */}
              <button className={`row${!selected && !composing ? ' active' : ''}`} onClick={() => { setComposing(false); setSelected(null); }}>
                <span style={{ display: 'inline-flex', color: 'var(--fg-2)', flex: 'none' }}><Icon name="memory" size={14} /></span>
                <span style={{ fontSize: 12.5, fontWeight: !selected && !composing ? 700 : 600 }}>{t('vault.graphTitle')}</span>
              </button>
              {docs.length === 0 && (projects?.length ?? 0) === 0 && (
                <p style={{ padding: '8px 16px', color: 'var(--fg-2)', fontSize: 12.5 }}>{t('vault.empty')}</p>
              )}
              {q && visible.length === 0 && visibleProjects.length === 0 && (
                <p style={{ padding: '8px 16px', color: 'var(--fg-2)', fontSize: 12.5 }}>{t('vault.noMemoryMatch')}</p>
              )}
              <TreeSection label={t('vault.tree.notes')} count={notes.length} defaultOpen>
                {/* 빈 상태 안내 — 검색 중(q)엔 "일치 없음"과, 완전 빈 회사에선 vault.empty와 겹치므로 숨긴다 */}
                {notes.length === 0 && !q && (docs.length + (projects?.length ?? 0)) > 0 && (
                  <p style={{ padding: '4px 16px 8px 24px', color: 'var(--fg-2)', fontSize: 11.5 }}>{t('vault.notesEmpty')}</p>
                )}
                {notes.map((d) => <DocRow key={d.rel} d={d} active={selected === d.rel} onOpen={openFromGraph} lang={lang} />)}
              </TreeSection>
              <TreeSection label={t('vault.tree.projects')} count={visibleProjects.length} defaultOpen>
                {projectGroups.map(([name, files]) => (
                  <TreeSection key={name} label={name} count={files.length} defaultOpen depth={1} folder>
                    {files.map((d) => d.binary ? (
                      <a key={d.rel} className="row" download
                        href={`/api/companies/${ws}/files?rel=${encodeURIComponent(d.rel)}&download=1`}
                        onClick={artifactDownload(`/api/companies/${ws}/files?rel=${encodeURIComponent(d.rel)}`, d.rel.split('/').pop())}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                        title={`${fmtSize(d.size)} · ${t('vault.download')}`}>
                        <span style={{ display: 'inline-flex', color: 'var(--fg-2)', flex: 'none' }}><Icon name="clip" size={13} /></span>
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{d.title}</span>
                          {/* 크기·수정시각을 본문 서브라벨로 — title 툴팁만으론 터치·데스크톱 앱에서 못 본다(PR #204 검수) */}
                          <span className="mono" style={{ display: 'block', fontSize: 10, color: 'var(--fg-3)', marginTop: 1 }}>
                            {fmtSize(d.size)} · {timeAgo(d.mtime, lang)}
                          </span>
                        </span>
                        <span className="microlabel" style={{ flex: 'none' }}>{t('vault.download')}</span>
                      </a>
                    ) : (
                      <DocRow key={d.rel} d={{ ...d, links: d.links ?? [] }} active={selected === d.rel} onOpen={openFromGraph} lang={lang} />
                    ))}
                  </TreeSection>
                ))}
              </TreeSection>
              <TreeSection label={t('vault.tree.journal')} count={journals.length}>
                {journals.map((d) => <DocRow key={d.rel} d={d} active={selected === d.rel} onOpen={openFromGraph} lang={lang} />)}
              </TreeSection>
              <TreeSection label={t('vault.tree.conversations')} count={convs.length}>
                {convs.map((d) => <DocRow key={d.rel} d={d} active={selected === d.rel} onOpen={openFromGraph} lang={lang} />)}
              </TreeSection>
            </>
          )}
        </div>
      </div>

      {/* 폭 조절 핸들 */}
      <div className={`vault-handle${resizing ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); setResizing(true); }} aria-hidden="true" />

      {/* ── 우: 콘텐츠(그래프 / 작성 폼 / 종이 뷰어) — 풀블리드 ── */}
      <div className="vault-content" style={{ flex: 1, minWidth: 0, overflowY: selected && !editing ? 'hidden' : 'auto', padding: composing ? '28px 36px 48px' : selected ? 0 : '14px 18px', display: selected && !editing ? 'flex' : 'block' }}>
        {composing ? (
          <form onSubmit={saveNote} style={{ display: 'grid', gap: 10, maxWidth: 860 }}>
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
                width: '100%', minHeight: 220, resize: 'vertical',
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
        ) : !selected ? (
          docs === null ? (
            <Skeleton h={320} style={{ margin: '8px 0' }} />
          ) : (
            // 2D 그래프가 패널 전체 — 헤더 없이(옵시디언 그래프 뷰). 토글·힌트는 캔버스 위 오버레이.
            <div style={{ height: '100%', margin: '-14px -18px' }}>
              {meta ? (
                <Graph2D docs={docs ?? []} agents={meta.agents ?? []} onSelectDoc={openFromGraph} />
              ) : (
                <Skeleton h={320} style={{ margin: '8px 18px' }} />
              )}
            </div>
          )
        ) : loadingDoc ? (
          <Spinner />
        ) : (
          // 뷰어 — 중앙 종이 컬럼(스크롤) + 우측 로컬 그래프 레일(옵시디언 리딩 뷰 + 로컬 그래프).
          <>
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '28px 36px 48px' }}>
          <div className="vault-reader" style={{ maxWidth: 760, margin: '0 auto' }}>
            <div className="vault-reader-bar" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', letterSpacing: '0.03em', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected}</span>
              {!editing && (
                <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
                  {/* 원문 md 다운로드 — 데스크톱 웹뷰의 a[download] 무동작은 artifactDownload가 처리(#241과 동일 경로) */}
                  <a className="btn sm" download={dlName}
                    href={`/api/companies/${ws}/vault?rel=${encodeURIComponent(selected)}&download=1`}
                    onClick={artifactDownload(`/api/companies/${ws}/vault?rel=${encodeURIComponent(selected)}&download=1`, dlName)}
                    style={{ textDecoration: 'none' }}>
                    <Icon name="doc" size={12} /> MD
                  </a>
                  <button className="btn sm" onClick={() => window.print()} title={t('vault.printHint')}>PDF</button>
                  {selectedDoc?.dir === 'notes' && (
                    <>
                      <button className="btn sm" onClick={() => { setDraft(content); setEditing(true); }}>
                        <Icon name="edit" size={12} /> {t('vault.edit')}
                      </button>
                      <button className="btn sm" onClick={() => setDeleteOpen(true)} disabled={mutating} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
                        <Icon name="trash" size={12} /> {t('vault.delete')}
                      </button>
                    </>
                  )}
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
              <>
                <Markdown text={content} onWikiLink={openWiki} wsId={ws} />
                {backlinks.length > 0 && (
                  // 백링크 — 이 문서를 [[링크]]한 기억(옵시디언 리딩 뷰 하단과 동일한 문법)
                  <div className="vault-reader-bar" style={{ marginTop: 28, paddingTop: 14, borderTop: '1px dashed var(--border-soft)' }}>
                    <span className="microlabel" style={{ display: 'block', marginBottom: 8 }}>{t('vault.backlinks', { n: backlinks.length })}</span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {backlinks.map((d) => (
                        <button key={d.rel} className="wikilink" onClick={() => openFromGraph(d.rel)}>{d.title}</button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          </div>
          {!editing && (
            // 로컬 그래프 — 선택 문서 중심 깊이 2(옵시디언 우측 패널). 인쇄에선 숨김(.vault-reader-bar 클래스 공유).
            <div className="vault-reader-bar" style={{ width: 300, flex: 'none', borderLeft: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <span className="microlabel" style={{ padding: '12px 14px 4px', flex: 'none' }}>{t('vault.localGraph')}</span>
              <div style={{ flex: 1, minHeight: 0 }}>
                <Graph2D docs={docs ?? []} agents={meta?.agents ?? []} onSelectDoc={openFromGraph} focusRel={selected} compact />
              </div>
            </div>
          )}
          </>
        )}
      </div>

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
    </div>
  );
}

// (들여쓰기 계산 headerPad/treePad는 삭제 — 2026-08-21 옵시디언 레이아웃: 계층은 .tree-kids 가이드라인이 담당)

/** 산출물 폴더명 표시 분해 — 크루 규칙 `YYYYMMDD_슬러그_...`에서 날짜를 떼어 우측 칩으로, 언더스코어는 공백으로.
    표시만 바꾼다(파일명·데이터 불변). 날짜 접두가 앞자리를 다 먹어 의미 있는 글자가 3~4자만 남던 것(실측). */
function splitFolderLabel(name) {
  const m = /^(\d{4})(\d{2})(\d{2})_(.+)$/.exec(name);
  if (!m) return { title: name.replace(/_/g, ' '), date: null };
  return { title: m[4].replace(/_/g, ' '), date: `${m[2]}-${m[3]}` };
}

/** 접이식 섹션/폴더 — 옵시디언 레이아웃: 캐럿 + 라벨(굵게) + 카운트. 폴더 아이콘 없음, 자식은 가이드라인 안에.
    depth 0(섹션)은 마이크로라벨 위계, depth 1(폴더)은 본문 굵게. */
function TreeSection({ label, count, defaultOpen = false, depth = 0, folder = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const { title, date } = folder ? splitFolderLabel(label) : { title: label, date: null };
  return (
    <div>
      <button className="row" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={label}>
        <span style={{ display: 'inline-block', width: 9, flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', color: 'var(--fg-3)', fontSize: 9 }}>▸</span>
        {depth === 0
          ? <span className="microlabel" style={{ minWidth: 0, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{title}</span>
          : <span style={{ minWidth: 0, flex: 1, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{title}</span>}
        {date && <span className="mono" style={{ flex: 'none', fontSize: 9.5, color: 'var(--fg-3)' }}>{date}</span>}
        <span className="mono" style={{ flex: 'none', fontSize: 10, color: 'var(--fg-3)' }}>{count}</span>
      </button>
      {open && <div className="tree-kids">{children}</div>}
    </div>
  );
}

/** 파일 크기 표시 — 산출물 다운로드 행 전용(대략치면 충분). */
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round((b ?? 0) / 1024))}KB`);

/** 트리 파일 행 — 옵시디언 밀도의 **한 줄** 행(유건 지시 2026-08-21 "더 깔끔하고 가벼운 워크트리").
    서브라벨 줄을 없애고 시각은 우측에 옅게 — 두 줄 행은 문서 수백 개에서 트리를 무겁게 만들었다.
    링크 수는 트리에서 빼고 뷰어 하단 백링크 섹션이 담당한다. pad = 트리 들여쓰기. */
// 아이콘 없음(유건 지시 "불필요한 아이콘") — 옵시디언처럼 제목만. 들여쓰기는 가이드라인(.tree-kids)이 담당하므로
// pad 인자는 무시한다(호출부 호환용). 시각은 호버·활성 시에만(.when).
function DocRow({ d, active, onOpen, lang }) {
  return (
    <button onClick={() => onOpen(d.rel)} className={`row${active ? ' active' : ''}`} title={d.title}>
      <span style={{ minWidth: 0, flex: 1, fontSize: 12.5, fontWeight: active ? 600 : 450, color: 'var(--fg)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
        {d.title}
      </span>
      <span className="mono when" style={{ flex: 'none', fontSize: 9.5, color: 'var(--fg-3)' }}>
        {timeAgo(tsFromRel(d.rel) ?? d.mtime, lang)}
      </span>
    </button>
  );
}
