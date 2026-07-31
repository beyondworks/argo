'use client';
// 기억 — 옵시디언식 2패널(2026-07-31 유건 지시: "아래로만 쌓여 보기 어렵다 → 워크트리 + 본문").
// 좌: 파일 트리(그래프 · 노트 · 산출물(프로젝트 폴더) · 일지 · 대화 — 접이식 + 카운트, 자체 스크롤).
// 우: 콘텐츠(기본=지식 그래프 전체 채움, 선택 시=종이 뷰어, 작성 시=노트 폼). 페이지 자체는
// 뷰포트 높이에 고정되어 스크롤이 각 패널 안에서만 일어난다 — 세로 나열 레이아웃 불안정의 종결.
import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon, Markdown, Spinner, Skeleton, DangerModal, api, imeGuard, timeAgo, tsFromRel, resolveWikiRel } from '../../../ui';
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
  // 그래프 실높이 — Constellation3D는 픽셀 고정 캔버스라 부모 실측값을 넘긴다(520 고정이면 큰 화면에서 하단이 비고 짧은 창에서 잘림 — 검수 실측).
  const [graphH, setGraphH] = useState(0);
  const graphRo = useRef(null);
  const graphBoxRef = useCallback((el) => {
    graphRo.current?.disconnect();
    graphRo.current = null;
    if (el) {
      const ro = new ResizeObserver(() => setGraphH(el.clientHeight));
      ro.observe(el);
      graphRo.current = ro;
    }
  }, []);

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

  return (
    // 뷰포트 고정 2패널 — 페이지는 안 흐르고 각 패널이 자체 스크롤한다(옵시디언 구조).
    // 높이·모바일 스택은 .vault-split(globals.css) — 인라인이면 미디어쿼리를 못 탄다.
    <div className="vault-split">
      {/* ── 좌: 워크트리 ── */}
      <div className="card vault-tree" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="card-head" style={{ paddingBottom: 8, flex: 'none' }}>
          <span className="card-title">{t('vault.header')}</span>
          <span className="rule" />
          <span className="chip">{docs ? docs.length + (projects?.length ?? 0) : '—'}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '0 14px 10px', flex: 'none' }}>
          <button className="btn sm" style={{ flex: 1 }} onClick={() => { setComposing(true); setSelected(null); }}>
            <Icon name="plus" size={12} /> {t('vault.writeNote')}
          </button>
          <button className="btn sm" onClick={consolidate} disabled={consolidating} title={t('vault.consolidateHint')} aria-label={t('vault.consolidateHint')}>
            {consolidating ? <Spinner size={12} /> : <Icon name="bolt" size={12} />}
          </button>
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
                  <p style={{ padding: '4px 16px 8px', paddingLeft: treePad(0), color: 'var(--fg-2)', fontSize: 11.5 }}>{t('vault.notesEmpty')}</p>
                )}
                {notes.map((d) => <DocRow key={d.rel} d={d} active={selected === d.rel} onOpen={openFromGraph} icon="bolt" lang={lang} pad={treePad(0)} />)}
              </TreeSection>
              <TreeSection label={t('vault.tree.projects')} count={visibleProjects.length} defaultOpen>
                {projectGroups.map(([name, files]) => (
                  <TreeSection key={name} label={name} count={files.length} defaultOpen depth={1} folder>
                    {files.map((d) => d.binary ? (
                      <a key={d.rel} className="row" download
                        href={`/api/companies/${ws}/files?rel=${encodeURIComponent(d.rel)}`}
                        style={{ textDecoration: 'none', color: 'inherit', paddingLeft: treePad(1, true) }}
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
                      <DocRow key={d.rel} d={{ ...d, links: d.links ?? [] }} active={selected === d.rel} onOpen={openFromGraph} icon="doc" lang={lang} pad={treePad(1, true)} />
                    ))}
                  </TreeSection>
                ))}
              </TreeSection>
              <TreeSection label={t('vault.tree.journal')} count={journals.length}>
                {journals.map((d) => <DocRow key={d.rel} d={d} active={selected === d.rel} onOpen={openFromGraph} icon="doc" lang={lang} pad={treePad(0)} />)}
              </TreeSection>
              <TreeSection label={t('vault.tree.conversations')} count={convs.length}>
                {convs.map((d) => <DocRow key={d.rel} d={d} active={selected === d.rel} onOpen={openFromGraph} icon="doc" lang={lang} pad={treePad(0)} />)}
              </TreeSection>
            </>
          )}
        </div>
      </div>

      {/* ── 우: 콘텐츠(그래프 / 작성 폼 / 종이 뷰어) ── */}
      <div className="card vault-content" style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: composing || selected ? 24 : '14px 18px' }}>
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
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 'none' }}>
                <span className="card-title">{t('vault.graphTitle')}</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span className="chip"><span className="dot" />{t('vault.conversation')}</span>
                  <span className="chip"><span style={{ width: 5, height: 5, borderRadius: 999, border: '1px solid currentColor' }} />{t('vault.note')}</span>
                  <button className="chip" onClick={() => setGraphOpen(true)} style={{ cursor: 'pointer' }}>{t('vault.viewLarge')}</button>
                </div>
              </div>
              {meta ? (
                <div ref={graphBoxRef} style={{ flex: 1, minHeight: 260 }}>
                  <Constellation3D company={meta.company} delegations={meta.delegations} agents={meta.agents ?? []} docs={docs ?? []} height={Math.max(240, graphH)} onOpen={() => setGraphOpen(true)} onSelectDoc={openFromGraph} />
                </div>
              ) : (
                <Skeleton h={320} style={{ margin: '8px 0' }} />
              )}
            </div>
          )
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
              <Markdown text={content} onWikiLink={openWiki} wsId={ws} />
            )}
          </div>
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
      {graphOpen && meta && docs && (
        <GraphModal
          ws={ws}
          company={meta.company}
          agents={meta.agents ?? []}
          delegations={meta.delegations}
          docs={docs}
          projects={projects}
          onClose={() => setGraphOpen(false)}
          onSelect={(rel) => { setGraphOpen(false); openFromGraph(rel); }}
        />
      )}
    </div>
  );
}

/** 접이식 트리 섹션 — 옵시디언 폴더 문법(▸ 라벨 · 카운트). depth로 들여쓰기, folder면 폴더 아이콘. */
/** 트리 들여쓰기 — 헤더 = 14 + depth·16, 자식 행 = 그 헤더 + 캐럿(10) + gap(11).
 *  두 식이 갈라지면 자식이 부모보다 왼쪽에 그려져 계층이 뒤집혀 보인다(검수 실측 4~5px 역전).
 *  folder 헤더는 폴더 아이콘(13)+gap(11)이 라벨을 24px 더 밀므로, 그 자식도 +24 해야
 *  라벨 기준 계층 단차가 산다(안 하면 자식 라벨 x = 부모 라벨 x — PR #204 검수 실측). */
const headerPad = (depth) => 14 + depth * 16;
const treePad = (depth, folder = false) => headerPad(depth) + 21 + (folder ? 24 : 0);

function TreeSection({ label, count, defaultOpen = false, depth = 0, folder = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button className="row" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        style={{ paddingLeft: headerPad(depth) }}>
        <span style={{ display: 'inline-block', width: 10, flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', color: 'var(--fg-3)', fontSize: 10 }}>▸</span>
        {folder && <span style={{ display: 'inline-flex', color: 'var(--fg-2)', flex: 'none' }}><Icon name="folder" size={13} /></span>}
        <span style={{ minWidth: 0, flex: 1, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{label}</span>
        <span className="mono" style={{ flex: 'none', fontSize: 10, color: 'var(--fg-3)' }}>{count}</span>
      </button>
      {open && children}
    </div>
  );
}

/** 파일 크기 표시 — 산출물 다운로드 행 전용(대략치면 충분). */
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round((b ?? 0) / 1024))}KB`);

/** 트리 파일 행 — 주제 노트·일지·대화·산출물이 같은 문법을 쓴다. pad = 트리 들여쓰기. */
function DocRow({ d, active, onOpen, icon, lang, pad = 14 }) {
  return (
    <button onClick={() => onOpen(d.rel)} className={`row${active ? ' active' : ''}`} style={{ paddingLeft: pad }}>
      <span style={{ display: 'inline-flex', color: 'var(--fg-2)', flex: 'none' }}>
        <Icon name={icon} size={14} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: active ? 700 : 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {d.title}
        </span>
        <span className="mono" style={{ display: 'block', fontSize: 10, color: 'var(--fg-3)', marginTop: 1 }}>
          {timeAgo(tsFromRel(d.rel) ?? d.mtime, lang)}{(d.links?.length ?? 0) > 0 && ` · LINK ${d.links.length}`}
        </span>
      </span>
    </button>
  );
}
