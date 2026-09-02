'use client';
// 기억 — 옵시디언식 워크스페이스(2026-08-21 유건 지시: "옵시디언 레이아웃 그대로 / 가로로 창 여러 개 /
// 한 화면에 패널·내용·그래프 중첩 금지").
// 좌: 파일 트리(풀블리드). 우: **탭이 있는 창(pane)** — 그래프 뷰도 한 탭, 문서도 각각 한 탭.
// 창은 최대 2개를 가로로 나란히(옆에 열기). 창 안에서는 한 번에 한 탭만 보인다(중첩 없음).
// 페이지는 뷰포트 높이에 고정되고 스크롤은 각 패널 안에서만 일어난다.
import { Suspense, use, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Icon, Markdown, Spinner, Skeleton, DangerModal, api, imeGuard, timeAgo, tsFromRel, resolveWikiRel, artifactDownload } from '../../../ui';
import { Graph2D } from '../graph2d'; // 2D 옵시디언식 — 3D 별자리(graphview)는 데크 위젯 전용
import { useLang } from '../../../i18n';
import { sideParam, withSide } from '../split.mjs';
import { useSplitAlive } from '../split-alive';
import { dispZoom } from '../zoom-math.mjs'; // 표시 배율 — 커서(뷰포트 px)→CSS px 환산(#334)

const GRAPH_TAB = { id: 'graph', kind: 'graph', root: null };
const MAX_TABS = 10;

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
  const router = useRouter();
  // 문서를 보조 패널(split-pane)로 — 주 화면(기억 페이지)은 그대로, ?side=doc:<rel>만 싣는다.
  // 패널 가용 축(실뷰포트 + 표시 배율, split-alive)이 죽었으면 진입로 자체를 넘기지 않는다(null → 행 버튼 미렌더) —
  // SplitPane이 죽은 축에서 null을 그리므로 게이트 없이 side를 세우면 무언 실패(분리 검수 #396 표면 C).
  const splitAlive = useSplitAlive();
  const sideOpen = splitAlive ? (rel) => router.replace(withSide(`${window.location.pathname}${window.location.search}`, sideParam({ type: 'doc', key: rel }))) : null;
  const [docs, setDocs] = useState(null);
  const [projects, setProjects] = useState([]); // 크루 산출물(vault/projects/) — 기억과 별도 축
  const [q, setQ] = useState('');
  const [meta, setMeta] = useState(null); // 회사·크루 — 그래프 크루 연결 토글용
  // 탐색기 툴바 상태(옵시디언): 정렬(수정시각 ↔ 이름)·모두 접기(세대 카운터)·검색 토글
  const [sort, setSort] = useState('mtime');
  const [treeGen, setTreeGen] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const sortDocs = (arr) => (sort === 'name'
    ? [...arr].sort((a, b) => a.title.localeCompare(b.title, 'ko'))
    : [...arr].sort((a, b) => (tsFromRel(b.rel) ?? b.mtime) - (tsFromRel(a.rel) ?? a.mtime)));

  // ── 창(pane)·탭 모델 — 옵시디언 워크스페이스. 창 = { id, tabs:[{id,kind,rel,root}], active }
  const [panes, setPanes] = useState(() => [{
    id: 1,
    tabs: initialDoc ? [GRAPH_TAB, { id: `doc:${initialDoc}`, kind: 'doc', rel: initialDoc }] : [GRAPH_TAB],
    active: initialDoc ? `doc:${initialDoc}` : 'graph',
  }]);
  const [focusPane, setFocusPane] = useState(1); // 마지막으로 만진 창 — 트리 클릭이 여기로 열린다
  const focused = panes.find((p) => p.id === focusPane) ?? panes[0];
  const activeTab = focused?.tabs.find((tb) => tb.id === focused.active) ?? null;
  const activeRel = activeTab?.kind === 'doc' ? activeTab.rel : null;

  /** 탭 열기/활성화 — split이면 두 번째 창에(없으면 만들고), 아니면 포커스 창에. 같은 탭이 있으면 활성화만. */
  function openTab(tab, { split = false } = {}) {
    setPanes((prev) => {
      let target = prev.find((p) => p.id === focusPane) ?? prev[0];
      let next = prev.map((p) => ({ ...p, tabs: [...p.tabs] }));
      if (split) {
        const other = next.find((p) => p.id !== target.id);
        if (other) target = other;
        else { const np = { id: Math.max(...next.map((p) => p.id)) + 1, tabs: [], active: null }; next.push(np); target = np; }
        setFocusPane(target.id);
      }
      const pane = next.find((p) => p.id === target.id);
      if (!pane.tabs.some((tb) => tb.id === tab.id)) {
        if (pane.tabs.length >= MAX_TABS) { // 가장 오래된 비활성 문서 탭부터 밀어낸다
          const i = pane.tabs.findIndex((tb) => tb.kind === 'doc' && tb.id !== pane.active);
          if (i >= 0) pane.tabs.splice(i, 1);
        }
        pane.tabs.push(tab);
      } else if (tab.kind === 'graph') { // 그래프 탭 재열기 = root 갱신
        pane.tabs = pane.tabs.map((tb) => (tb.id === 'graph' ? { ...tb, root: tab.root ?? null } : tb));
      }
      pane.active = tab.id;
      return next;
    });
  }
  const openDoc = (rel, opts) => { if (rel) openTab({ id: `doc:${rel}`, kind: 'doc', rel }, opts); };
  const openGraph = (root = null, opts) => openTab({ ...GRAPH_TAB, root }, opts);
  const openCompose = () => openTab({ id: 'compose', kind: 'compose' });
  function closeTab(paneId, tabId) {
    setPanes((prev) => {
      const next = prev.map((p) => ({ ...p, tabs: [...p.tabs] }));
      const pane = next.find((p) => p.id === paneId);
      if (!pane) return prev;
      const i = pane.tabs.findIndex((tb) => tb.id === tabId);
      if (i < 0) return prev;
      pane.tabs.splice(i, 1);
      if (pane.tabs.length === 0) {
        if (next.length > 1) { const rest = next.filter((p) => p.id !== paneId); setFocusPane(rest[0].id); return rest; }
        pane.tabs.push(GRAPH_TAB); pane.active = 'graph'; return next;
      }
      if (pane.active === tabId) pane.active = pane.tabs[Math.min(i, pane.tabs.length - 1)].id;
      return next;
    });
  }
  const activateTab = (paneId, tabId) => { setFocusPane(paneId); setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, active: tabId } : p))); };

  // 트리 패널 폭 — 드래그 핸들로 조절, 기기 로컬 기억(localStorage)
  const [treeW, setTreeW] = useState(300);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    const saved = Number(localStorage.getItem('argo-vault-tree-w'));
    if (saved >= 220 && saved <= 560) setTreeW(saved);
  }, []);
  useEffect(() => {
    if (!resizing) return;
    const move = (e) => {
      setTreeW(Math.min(560, Math.max(220, (e.clientX - (document.querySelector('.vault-tree')?.getBoundingClientRect().left ?? 0)) / dispZoom())));
    };
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

  useEffect(() => {
    const h = (e) => setQ(String(e.detail || '').toLowerCase());
    window.addEventListener('argo:search', h);
    return () => window.removeEventListener('argo:search', h);
  }, []);

  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMsg, setConsolidateMsg] = useState('');
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

  const visible = (docs ?? []).filter((d) => !q || d.title.toLowerCase().includes(q) || d.excerpt.toLowerCase().includes(q));
  const notes = visible.filter((d) => d.dir === 'notes').sort((a, b) => b.mtime - a.mtime);
  const journals = visible.filter((d) => d.dir === 'journal');
  const convs = visible.filter((d) => d.dir !== 'notes' && d.dir !== 'journal');
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
  // 트리 클릭: 기본 = 포커스 창에서 열기, ⌘/Alt 클릭 = 옆 창에 열기(옵시디언 ⌘클릭 관례)
  const rowOpen = (rel, e) => openDoc(rel, { split: !!(e?.metaKey || e?.altKey) });
  const graphActive = activeTab?.kind === 'graph';

  return (
    <div className="vault-split">
      {/* ── 좌: 탐색기 — 옵시디언/VS Code 표준 템플릿: 아이콘 툴바 → 루트 폴더(회사) → 폴더/파일 트리 ── */}
      <div className="vault-tree" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', width: treeW }}>
        <div className="vault-toolbar">
          <button className="tb" onClick={openCompose} title={t('vault.writeNote')} aria-label={t('vault.writeNote')}><Icon name="plus" size={14} /></button>
          <button className="tb" onClick={() => setSort((s) => (s === 'mtime' ? 'name' : 'mtime'))} title={sort === 'mtime' ? t('vault.sortTime') : t('vault.sortName')} aria-label={t('vault.sortTime')}><Icon name="sort" size={14} /></button>
          <button className="tb" onClick={() => setTreeGen((g) => g + 1)} title={t('vault.collapseAll')} aria-label={t('vault.collapseAll')}><Icon name="collapse" size={14} /></button>
          <button className={`tb${searchOpen || q ? ' on' : ''}`} onClick={() => setSearchOpen((v) => !v)} title={t('vault.toggleSearch')} aria-label={t('vault.toggleSearch')}><Icon name="search" size={14} /></button>
          <span style={{ flex: 1 }} />
          <button className={`tb${graphActive ? ' on' : ''}`} onClick={(e) => openGraph(null, { split: !!(e.metaKey || e.altKey) })} title={t('vault.graphTitle')} aria-label={t('vault.graphTitle')}><Icon name="memory" size={14} /></button>
          <button className="tb" onClick={consolidate} disabled={consolidating} title={t('vault.consolidateHint')} aria-label={t('vault.consolidateHint')}>
            {consolidating ? <Spinner size={12} /> : <Icon name="bolt" size={14} />}
          </button>
        </div>
        {(searchOpen || q) && (
          <div style={{ padding: '0 10px 6px', flex: 'none' }}>
            <input suppressHydrationWarning autoFocus value={q} onChange={(e) => setQ(e.target.value.toLowerCase())} placeholder={t('vault.searchTree')} {...imeGuard}
              style={{ width: '100%', height: 26, padding: '0 9px', fontSize: 12, background: 'var(--card-2)', border: '1px solid var(--border-soft)', borderRadius: 6, outline: 'none' }} />
          </div>
        )}
        {consolidateMsg && <span style={{ padding: '0 12px 6px', fontSize: 11.5, color: 'var(--fg-2)', flex: 'none' }}>{consolidateMsg}</span>}
        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 10 }}>
          {docs === null ? (
            <div style={{ padding: '4px 14px' }}><Skeleton h={140} /></div>
          ) : (
            <>
              {q && visible.length === 0 && visibleProjects.length === 0 && (
                <p style={{ padding: '8px 14px', color: 'var(--fg-2)', fontSize: 12.5 }}>{t('vault.noMemoryMatch')}</p>
              )}
              {/* 루트 폴더 = 회사(볼트). 옵시디언의 볼트 루트와 같은 자리. */}
              <Folder key={`root-${treeGen}`} label={meta?.company?.name ?? t('nav.memory')} open gen={treeGen} root>
                <Folder label={t('vault.tree.notes')} open gen={treeGen}>
                  {notes.length === 0 && !q && (docs.length + (projects?.length ?? 0)) > 0 && (
                    <p style={{ padding: '2px 12px 6px', color: 'var(--fg-3)', fontSize: 11.5 }}>{t('vault.notesEmpty')}</p>
                  )}
                  {sortDocs(notes).map((d) => <FileRow key={d.rel} d={d} active={activeRel === d.rel} onOpen={rowOpen} onSide={sideOpen} lang={lang} />)}
                </Folder>
                <Folder label={t('vault.tree.journal')} gen={treeGen}>
                  {sortDocs(journals).map((d) => <FileRow key={d.rel} d={d} active={activeRel === d.rel} onOpen={rowOpen} onSide={sideOpen} lang={lang} />)}
                </Folder>
                <Folder label={t('vault.tree.conversations')} gen={treeGen}>
                  {sortDocs(convs).map((d) => <FileRow key={d.rel} d={d} active={activeRel === d.rel} onOpen={rowOpen} onSide={sideOpen} lang={lang} />)}
                </Folder>
                <Folder label={t('vault.tree.projects')} open gen={treeGen}>
                  {projectGroups.map(([name, files]) => (
                    <Folder key={name} label={splitFolderLabel(name).title} title={name} gen={treeGen}>
                      {files.map((d) => d.binary ? (
                        <a key={d.rel} className="row" download
                          href={`/api/companies/${ws}/files?rel=${encodeURIComponent(d.rel)}&download=1`}
                          onClick={artifactDownload(`/api/companies/${ws}/files?rel=${encodeURIComponent(d.rel)}`, d.rel.split('/').pop())}
                          style={{ textDecoration: 'none', color: 'inherit' }}
                          title={`${fmtSize(d.size)} · ${t('vault.download')}`}>
                          <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{d.title}</span>
                          <span className="mono when" style={{ flex: 'none', fontSize: 9.5, color: 'var(--fg-3)' }}>{fmtSize(d.size)} ↓</span>
                        </a>
                      ) : (
                        <FileRow key={d.rel} d={d} active={activeRel === d.rel} onOpen={rowOpen} onSide={sideOpen} lang={lang} />
                      ))}
                    </Folder>
                  ))}
                </Folder>
              </Folder>
              {docs.length === 0 && (projects?.length ?? 0) === 0 && (
                <p style={{ padding: '8px 14px', color: 'var(--fg-2)', fontSize: 12.5 }}>{t('vault.empty')}</p>
              )}
            </>
          )}
        </div>
      </div>

      <div className={`vault-handle${resizing ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); setResizing(true); }} aria-hidden="true" />

      {/* ── 우: 창(pane)들 — 가로 나란히, 각자 탭 스트립 + 본문 ── */}
      <div className="vault-content" style={{ flex: 1, minWidth: 0, display: 'flex', minHeight: 0 }}>
        {panes.map((pane, pi) => {
          const cur = pane.tabs.find((tb) => tb.id === pane.active) ?? pane.tabs[0];
          const isFocus = pane.id === focusPane;
          return (
            <div key={pane.id} className={`vault-pane${isFocus ? ' focus' : ''}`} onMouseDown={() => setFocusPane(pane.id)}
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderLeft: pi > 0 ? '1px solid var(--border-soft)' : 0 }}>
              {/* 탭 스트립 */}
              <div className="vault-tabs">
                {pane.tabs.map((tb) => {
                  const title = tb.kind === 'graph' ? t('vault.graphTitle') : tb.kind === 'compose' ? t('vault.knowledgeNote') : (docs ?? []).concat(projects ?? []).find((d) => d.rel === tb.rel)?.title ?? tb.rel.split('/').pop();
                  return (
                    <div key={tb.id} className={`vault-tab${tb.id === pane.active ? ' active' : ''}`} onClick={() => activateTab(pane.id, tb.id)} title={title} role="tab" aria-selected={tb.id === pane.active}>
                      <span className="vault-tab-title">{title}</span>
                      <button className="vault-tab-x" onClick={(e) => { e.stopPropagation(); closeTab(pane.id, tb.id); }} aria-label={t('vault.closeTab')}>×</button>
                    </div>
                  );
                })}
                <span style={{ flex: 1 }} />
                {cur?.kind === 'doc' && panes.length < 2 && (
                  <button className="btn sm" style={{ padding: '0 8px', marginRight: 6 }} title={t('vault.openSide')} onClick={() => openDoc(cur.rel, { split: true })}>⫿</button>
                )}
              </div>
              {/* 본문 — 한 번에 한 탭 */}
              <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                {!cur ? null : cur.kind === 'graph' ? (
                  docs === null || !meta ? <Skeleton h={320} style={{ margin: 18 }} /> : (
                    <>
                      <Graph2D key={cur.root ?? 'all'} docs={docs} agents={meta.agents ?? []} onSelectDoc={(rel) => openDoc(rel)} focusRel={cur.root} />
                      {cur.root && (
                        <button className="chip" style={{ position: 'absolute', top: 10, left: 12, cursor: 'pointer' }} onClick={() => openGraph(null)}>{t('graph.backToAll')}</button>
                      )}
                    </>
                  )
                ) : cur.kind === 'compose' ? (
                  <ComposeView ws={ws} t={t} onSaved={async (rel) => { await loadDocs(); closeTab(pane.id, 'compose'); openDoc(rel); window.dispatchEvent(new Event('argo:refresh')); }} onCancel={() => closeTab(pane.id, 'compose')} />
                ) : (
                  <DocView key={cur.rel} ws={ws} rel={cur.rel} docs={docs} projects={projects} t={t}
                    onOpen={(rel, e) => openDoc(rel, { split: !!(e?.metaKey || e?.altKey) })}
                    onGraph={() => openGraph(cur.rel, { split: panes.length < 2 })}
                    onChanged={loadDocs}
                    onDeleted={() => { closeTab(pane.id, cur.id); loadDocs(); }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 노트 작성 탭 */
function ComposeView({ ws, t, onSaved, onCancel }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  async function save(e) {
    e.preventDefault();
    if (saving || !title.trim() || !body.trim()) return;
    setSaving(true); setMsg('');
    try {
      const r = await api(`/api/companies/${ws}/vault`, { title, content: body });
      onSaved(r.rel);
    } catch (err) { setMsg(String(err.message)); } finally { setSaving(false); }
  }
  return (
    <form onSubmit={save} style={{ display: 'grid', gap: 10, maxWidth: 860, padding: '24px 36px', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="card-title">{t('vault.knowledgeNote')}</span>
        <span className="microlabel">{t('vault.autoLinkOnSave')}</span>
      </div>
      <input suppressHydrationWarning className="input-bar" style={{ display: 'block', height: 38, padding: '0 14px', borderRadius: 10, outline: 'none' }}
        placeholder={t('vault.titlePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} {...imeGuard} />
      <textarea placeholder={t('vault.bodyPlaceholder')} value={body} onChange={(e) => setBody(e.target.value)}
        style={{ width: '100%', minHeight: 220, resize: 'vertical', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 14px', outline: 'none', fontSize: 13, lineHeight: 1.65 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="btn btn-primary sm" disabled={saving || !title.trim() || !body.trim()}>{saving ? <Spinner size={12} /> : t('vault.saveToMemory')}</button>
        <button type="button" className="btn sm" onClick={onCancel}>{t('vault.cancel')}</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{msg}</span>}
      </div>
    </form>
  );
}

/** 문서 탭 — 로드·뷰어·편집·삭제·다운로드·백링크가 한 탭 안에 독립적으로 산다(창 2개에서 서로 다른 문서 가능). */
function DocView({ ws, rel, docs, projects, t, onOpen, onGraph, onChanged, onDeleted }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [mutating, setMutating] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api(`/api/companies/${ws}/vault?rel=${encodeURIComponent(rel)}`)
      .then((d) => { if (live) setContent(d.content); })
      .catch((e) => { if (live) setContent(t('vault.docUnavailable', { msg: e.message })); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ws, rel]);
  const doc = (docs ?? []).find((d) => d.rel === rel);
  const stem = rel.replace(/\.md$/, '');
  const base = stem.split('/').pop();
  const backlinks = (docs ?? []).filter((d) => d.rel !== rel && (d.links ?? []).some((l) => l === stem || l === base || l === doc?.title));
  const dlName = rel.split('/').pop();
  const openWiki = (name) => onOpen(resolveWikiRel(name, docs, projects));
  async function saveEdit() {
    if (mutating) return;
    setMutating(true);
    try {
      await fetch(`/api/companies/${ws}/vault`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rel, content: draft }) })
        .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      setContent(draft); setEditing(false); onChanged?.();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) { setActionMsg(String(e.message)); } finally { setMutating(false); }
  }
  async function removeNote() {
    setMutating(true);
    try {
      await fetch(`/api/companies/${ws}/vault?rel=${encodeURIComponent(rel)}`, { method: 'DELETE' }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      setDeleteOpen(false); onDeleted?.();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) { setDeleteOpen(false); setActionMsg(String(e.message)); } finally { setMutating(false); }
  }
  if (loading) return <div style={{ padding: 24 }}><Spinner /></div>;
  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 36px 48px' }}>
      <div className="vault-reader" style={{ maxWidth: 760, margin: '0 auto' }}>
        <div className="vault-reader-bar" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', letterSpacing: '0.03em', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rel}</span>
          {!editing && (
            <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
              <button className="btn sm" onClick={onGraph} title={t('vault.localGraph')}><Icon name="memory" size={12} /></button>
              <a className="btn sm" download={dlName}
                href={`/api/companies/${ws}/vault?rel=${encodeURIComponent(rel)}&download=1`}
                onClick={artifactDownload(`/api/companies/${ws}/vault?rel=${encodeURIComponent(rel)}&download=1`, dlName)}
                style={{ textDecoration: 'none' }}>
                <Icon name="doc" size={12} /> MD
              </a>
              <button className="btn sm" onClick={() => window.print()} title={t('vault.printHint')}>PDF</button>
              {/* 오피스 내보내기 — 표는 xlsx/csv의 시트·행으로, 본문은 docx의 제목·문단·표로(server: src/office-export.mjs) */}
              {['docx', 'xlsx', 'csv'].map((f) => (
                <a key={f} className="btn sm" download={`${dlName.replace(/\.md$/, '')}.${f}`} style={{ textDecoration: 'none' }}
                  href={`/api/companies/${ws}/vault?rel=${encodeURIComponent(rel)}&format=${f}`}
                  onClick={artifactDownload(`/api/companies/${ws}/vault?rel=${encodeURIComponent(rel)}&format=${f}`, `${dlName.replace(/\.md$/, '')}.${f}`)}
                  title={t(`vault.export.${f}`)}>{f.toUpperCase()}</a>
              ))}
              {doc?.dir === 'notes' && (
                <>
                  <button className="btn sm" onClick={() => { setDraft(content); setEditing(true); }}><Icon name="edit" size={12} /> {t('vault.edit')}</button>
                  <button className="btn sm" onClick={() => setDeleteOpen(true)} disabled={mutating} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}><Icon name="trash" size={12} /> {t('vault.delete')}</button>
                </>
              )}
            </span>
          )}
        </div>
        {actionMsg && <p style={{ margin: '-6px 0 12px', fontSize: 12, color: 'var(--danger)' }}>{actionMsg}</p>}
        {editing ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
              style={{ width: '100%', minHeight: 380, resize: 'vertical', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', outline: 'none', fontSize: 12.5, lineHeight: 1.7, fontFamily: 'var(--mono, monospace)' }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn btn-primary sm" onClick={saveEdit} disabled={mutating || !draft.trim()}>{mutating ? <Spinner size={12} /> : t('vault.save')}</button>
              <button className="btn sm" onClick={() => setEditing(false)} disabled={mutating}>{t('vault.cancel')}</button>
              <span className="metric-sub2">{t('vault.saveHint')}</span>
            </div>
          </div>
        ) : (
          <>
            <Markdown text={content} onWikiLink={openWiki} wsId={ws} />
            {backlinks.length > 0 && (
              <div className="vault-reader-bar" style={{ marginTop: 28, paddingTop: 14, borderTop: '1px dashed var(--border-soft)' }}>
                <span className="microlabel" style={{ display: 'block', marginBottom: 8 }}>{t('vault.backlinks', { n: backlinks.length })}</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {backlinks.map((d) => <button key={d.rel} className="wikilink" onClick={(e) => onOpen(d.rel, e)}>{d.title}</button>)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {deleteOpen && (
        <DangerModal title={t('vault.deleteTitle')} description={t('vault.deleteDesc')} requireText={doc?.title ?? ''}
          phraseKey="danger.phrase.delete" confirmLabel={t('vault.deleteConfirm')} busy={mutating} onConfirm={removeNote} onClose={() => setDeleteOpen(false)} />
      )}
    </div>
  );
}

/** 산출물 폴더명 표시 분해 — 크루 규칙 `YYYYMMDD_슬러그_...`에서 날짜를 떼어 우측 칩으로, 언더스코어는 공백으로(표시만). */
function splitFolderLabel(name) {
  const m = /^(\d{4})(\d{2})(\d{2})_(.+)$/.exec(name);
  if (!m) return { title: name.replace(/_/g, ' '), date: null };
  return { title: m[4].replace(/_/g, ' '), date: `${m[2]}-${m[3]}` };
}

/** 폴더 행 — 옵시디언/VS Code 탐색기: 캐럿 + 이름. 카운트·아이콘·칩 없음. gen이 바뀌면(모두 접기) 접힌다(루트 제외). */
function Folder({ label, title, open: initialOpen = false, root = false, gen = 0, children }) {
  const [open, setOpen] = useState(root || initialOpen);
  useEffect(() => { if (gen > 0 && !root) setOpen(false); }, [gen, root]);
  return (
    <div>
      <button className="row" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={title ?? label}>
        <span style={{ display: 'inline-block', width: 10, flex: 'none', textAlign: 'center', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s', color: 'var(--fg-3)', fontSize: 9 }}>▸</span>
        <span style={{ minWidth: 0, flex: 1, fontWeight: root ? 600 : 500, color: 'var(--fg)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{label}</span>
      </button>
      {open && <div className="tree-kids">{children}</div>}
    </div>
  );
}

const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round((b ?? 0) / 1024))}KB`);

/** 파일 행 — 이름만(옵시디언). 시각은 호버·활성 시만. ⌘/Alt 클릭 = 옆 창에 열기. 캐럿 자리만큼 들여써 폴더 이름과 정렬. */
function FileRow({ d, active, onOpen, onSide, lang }) {
  const { t } = useLang();
  // '옆에 열기'는 <button> 안에 button을 넣을 수 없어 형제로 — 래퍼(.row-wrap)가 position 기준(사이드바 크루 행과 같은 패턴)
  return (
    <div className="row-wrap">
      <button onClick={(e) => onOpen(d.rel, e)} className={`row${active ? ' active' : ''}`} title={d.title} style={{ paddingLeft: 21 }}>
        <span style={{ minWidth: 0, flex: 1, fontWeight: 500, color: 'var(--fg)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{d.title}</span>
        <span className="mono when" style={{ flex: 'none', fontSize: 9.5, color: 'var(--fg-3)' }}>{timeAgo(tsFromRel(d.rel) ?? d.mtime, lang)}</span>
      </button>
      {onSide && (
        <button type="button" className="row-side" title={t('split.open')} aria-label={t('split.open')} onClick={(e) => { e.stopPropagation(); onSide(d.rel); }}>
          <Icon name="split" size={12} />
        </button>
      )}
    </div>
  );
}
