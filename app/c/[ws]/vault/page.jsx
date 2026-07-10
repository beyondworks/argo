'use client';
// 기억 — 3D 지식 그래프(공유 엔진) + 기록 표 + 종이 뷰어. 탑바 검색으로 필터.
import { Suspense, use, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon, Markdown, Spinner, Skeleton, api, imeGuard, timeAgo, tsFromRel } from '../../../ui';
import { Constellation3D, GraphModal } from '../graphview';

export default function VaultPage({ params }) {
  return (
    <Suspense>
      <Vault params={params} />
    </Suspense>
  );
}

function Vault({ params }) {
  const { ws } = use(params);
  const initialDoc = useSearchParams().get('doc');
  const [docs, setDocs] = useState(null);
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
    return api(`/api/companies/${ws}/vault`).then((d) => setDocs(d.docs)).catch(() => setDocs([]));
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
    setLoadingDoc(true);
    api(`/api/companies/${ws}/vault?rel=${encodeURIComponent(selected)}`)
      .then((d) => setContent(d.content))
      .catch((e) => setContent(`(문서를 열 수 없습니다: ${e.message})`))
      .finally(() => setLoadingDoc(false));
  }, [ws, selected]);

  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMsg, setConsolidateMsg] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [mutating, setMutating] = useState(false);

  useEffect(() => { setEditing(false); }, [selected]); // 문서를 바꾸면 편집 모드 해제

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
      alert(String(e.message));
    } finally {
      setMutating(false);
    }
  }

  async function removeNote() {
    const doc = (docs ?? []).find((d) => d.rel === selected);
    if (!window.confirm(`"${doc?.title ?? selected}" 노트를 삭제할까요?\n크루가 더 이상 이 지식을 참조하지 않습니다. (파일은 .trash/에 보관)`)) return;
    setMutating(true);
    try {
      await fetch(`/api/companies/${ws}/vault?rel=${encodeURIComponent(selected)}`, { method: 'DELETE' })
        .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      setSelected(null);
      loadDocs();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) {
      alert(String(e.message));
    } finally {
      setMutating(false);
    }
  }

  async function consolidate() {
    if (consolidating) return;
    setConsolidating(true); setConsolidateMsg('');
    try {
      const r = await api(`/api/companies/${ws}/vault/consolidate`, {});
      setConsolidateMsg(r.notes.length ? `주제 노트 ${r.notes.length}건 갱신` : '정리할 새 일지가 없습니다');
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
  const selectedDoc = (docs ?? []).find((d) => d.rel === selected);

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span className="microlabel">Vault · 회사가 쌓아온 항해일지</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          {consolidateMsg && <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{consolidateMsg}</span>}
          <span className="microlabel">{docs ? `${docs.length} Records` : ''}</span>
          <button className="btn sm" onClick={consolidate} disabled={consolidating} title="새 일지를 주제 노트로 정제합니다 (매일 새벽 자동)">
            {consolidating ? <Spinner size={12} /> : <><Icon name="bolt" size={13} /> 기억 정리</>}
          </button>
          <button className="btn sm" onClick={() => setComposing((v) => !v)}>
            <Icon name="plus" size={13} /> 노트 작성
          </button>
        </span>
      </div>

      {composing && (
        <form onSubmit={saveNote} className="card fade-up" style={{ padding: 18, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="card-title">지식 노트</span>
            <span className="microlabel">저장 즉시 자동 링크</span>
          </div>
          <input suppressHydrationWarning
            className="input-bar"
            style={{ display: 'block', height: 38, padding: '0 14px', borderRadius: 10, outline: 'none' }}
            placeholder="제목 — 예: 쿠키 브랜드 카피 톤 가이드"
            value={noteTitle}
            onChange={(e) => setNoteTitle(e.target.value)}
            {...imeGuard}
          />
          <textarea
            placeholder="회사가 기억해야 할 내용을 적어주세요. 크루가 다음 턴부터 참조합니다."
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
              {savingNote ? <Spinner size={12} /> : '기억에 저장'}
            </button>
            <button type="button" className="btn sm" onClick={() => setComposing(false)}>취소</button>
            {noteMsg && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{noteMsg}</span>}
          </div>
        </form>
      )}

      {docs === null ? (
        <>
          <Skeleton h={200} style={{ borderRadius: 16 }} />
          <Skeleton h={320} style={{ borderRadius: 16 }} />
        </>
      ) : docs.length === 0 ? (
        <div className="empty">아직 기록된 기억이 없습니다. 크루와 첫 대화를 나누면 여기에 쌓입니다.</div>
      ) : (
        <>
          <div className="card" style={{ padding: '14px 18px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="card-title">기억 그래프</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <span className="chip"><span className="dot" />대화</span>
                <span className="chip"><span style={{ width: 5, height: 5, borderRadius: 999, border: '1px solid currentColor' }} />노트</span>
                <button className="chip" onClick={() => setGraphOpen(true)} style={{ cursor: 'pointer' }}>크게 보기 ↗</button>
              </div>
            </div>
            {meta ? (
              <Constellation3D company={meta.company} delegations={meta.delegations} agents={meta.agents ?? []} docs={docs} height={240} onOpen={() => setGraphOpen(true)} />
            ) : (
              <Skeleton h={240} style={{ margin: '8px 0' }} />
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 14, alignItems: 'start' }}>
            {/* 기록 패널 — 탑바(56px) 아래 고정, 목록은 자체 스크롤. 우측 뷰어만 페이지와 함께 흐른다 */}
            <div className="card" style={{ position: 'sticky', top: 70, maxHeight: 'calc(100vh - 92px)', overflowY: 'auto' }}>
              <div className="card-head" style={{ paddingBottom: 10 }}>
                <span className="card-title">기록</span>
                <span className="chip">{visible.length}</span>
              </div>
              {visible.length === 0 && (
                <p style={{ padding: '0 18px 16px', color: 'var(--fg-2)', fontSize: 13 }}>검색과 일치하는 기억이 없습니다.</p>
              )}
              <div className="microlabel" style={{ padding: '8px 18px 4px' }}>
                회사가 아는 것 · {notes.length}
              </div>
              {notes.length === 0 && (
                <p style={{ padding: '4px 18px 12px', color: 'var(--fg-2)', fontSize: 12 }}>
                  아직 정리된 지식이 없습니다 — 크루와 일하면 새벽 정리가 주제 노트로 만들어줍니다.
                </p>
              )}
              {notes.map((d) => <DocRow key={d.rel} d={d} active={selected === d.rel} onOpen={setSelected} icon="bolt" />)}
              {archives.length > 0 && (
                <>
                  <button className="microlabel" onClick={() => setShowArchive((v) => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '10px 18px 6px', borderTop: '1px dashed var(--border-soft)', cursor: 'pointer' }}>
                    <span style={{ display: 'inline-block', transform: showArchive ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
                    일지 보관함 · {archives.length} — 결론의 근거(대화 원본)
                  </button>
                  {showArchive && archives.map((d) => <DocRow key={d.rel} d={d} active={selected === d.rel} onOpen={setSelected} icon="doc" />)}
                </>
              )}
            </div>

            <div className="card" style={{ padding: 24, minHeight: 340 }}>
              {!selected ? (
                <div style={{ color: 'var(--fg-2)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="doc" size={14} /> 왼쪽 목록이나 그래프의 별을 눌러 기억을 열어보세요.
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
                          <Icon name="edit" size={12} /> 편집
                        </button>
                        <button className="btn sm" onClick={removeNote} disabled={mutating} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
                          <Icon name="trash" size={12} /> 삭제
                        </button>
                      </span>
                    )}
                  </div>
                  {editing ? (
                    <div style={{ display: 'grid', gap: 10 }}>
                      <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                        style={{ width: '100%', minHeight: 380, resize: 'vertical', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', outline: 'none', fontSize: 12.5, lineHeight: 1.7, fontFamily: 'var(--font-mono, monospace)' }} />
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button className="btn btn-primary sm" onClick={saveEdit} disabled={mutating || !draft.trim()}>
                          {mutating ? <Spinner size={12} /> : '저장'}
                        </button>
                        <button className="btn sm" onClick={() => setEditing(false)} disabled={mutating}>취소</button>
                        <span className="metric-sub2">저장 즉시 크루가 이 내용을 참조합니다</span>
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

      {graphOpen && meta && docs && (
        <GraphModal
          company={meta.company}
          agents={meta.agents ?? []}
          delegations={meta.delegations}
          docs={docs}
          onClose={() => setGraphOpen(false)}
          onSelect={(rel) => { setSelected(rel); setGraphOpen(false); }}
        />
      )}
    </div>
  );
}

/** 기록 패널 행 — 주제 노트와 보관함이 같은 문법을 쓴다. */
function DocRow({ d, active, onOpen, icon }) {
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
          {timeAgo(tsFromRel(d.rel) ?? d.mtime)}{d.links.length > 0 && ` · LINK ${d.links.length}`}
        </span>
      </span>
    </button>
  );
}
