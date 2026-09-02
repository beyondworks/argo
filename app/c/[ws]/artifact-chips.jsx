'use client';
// 산출물 칩 + 인라인 미리보기 — 크루 채팅과 회의실이 **같은 컴포넌트**를 쓴다(회의실 산출물 바로 보기·바로 가기,
// 유건 요청 2026-09-02). 크루 채팅 page.jsx에서 이관(PR #200 계열 원본) — 칩 클릭(md=뷰어, 그 외=다운로드) +
// 눈 토글(메시지 안에서 펼침). 한 벌만 두는 이유: 열람 계약(뷰어·files API·미리보기 형식)이 화면마다 갈리면
// 같은 파일이 크루 채팅에선 열리고 회의실에선 안 열리는 비대칭이 생긴다.
import { useEffect, useState } from 'react';
import { Icon, Markdown, Spinner, api, artifactDownload } from '../../ui';
import { useLang } from '../../i18n';

/* ─── 산출물 인라인 미리보기 ───
   "채팅에서 바로 주는 산출물은 채팅창에서 바로 볼 수 있으면 좋겠다"(2026-07-31)의 1차 대응.
   칩 클릭(md=뷰어, 그 외=다운로드)은 그대로 두고, 옆 눈 버튼으로 메시지 안에서 펼쳐 본다.
   서버 협조 지점 2곳(지우면 pdf/svg 미리보기가 깨진다): ① next.config.mjs가 files 라우트에
   한해 same-origin 프레임을 허용한다(전역 DENY 유지) — pdf <iframe>의 전제. ② svg는 files API가
   octet-stream으로 주므로(의도 — MIME 확장은 스크립트 표면) 텍스트로 받아 blob <img>로 우회한다.
   files/route.js 자체는 무수정: Content-Disposition 없이 정확한 MIME이라 img 인라인은 이미 된다. */
const PREVIEW_IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const PREVIEW_TEXT_EXTS = new Set(['txt', 'csv', 'json', 'log', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'html', 'css', 'yml', 'yaml', 'toml', 'xml']);
const PREVIEW_TEXT_CAP = 64 * 1024; // bytes — 큰 파일 보호: 이만큼만 받고 스트림을 끊은 뒤 잘림 표기

function previewKind(rel) {
  if (rel.endsWith('.md')) return 'md'; // md는 vault 전역(뷰어와 동일 원천) — files API 접두 밖일 수 있어 vault API로 읽는다
  const ext = rel.split('.').pop().toLowerCase();
  if (PREVIEW_IMG_EXTS.has(ext)) return 'img';
  if (ext === 'svg') return 'svg'; // files API가 octet-stream으로 주므로 <img src=URL>은 안 그려진다 — 텍스트로 받아 blob(image/svg+xml)로
  if (ext === 'pdf') return 'pdf';
  if (PREVIEW_TEXT_EXTS.has(ext)) return 'text';
  return 'none';
}

/** 미리보기 본문 — 형식별 렌더. 접힘이 기본이라 이 컴포넌트는 펼친 rel에만 마운트된다(불필요 fetch 없음). */
function ArtifactPreview({ ws, rel }) {
  const { t } = useLang();
  const kind = previewKind(rel);
  const name = rel.split('/').pop();
  const fileUrl = `/api/companies/${ws}/files?rel=${encodeURIComponent(rel)}`;
  const needsFetch = kind === 'md' || kind === 'text' || kind === 'svg';
  const [st, setSt] = useState({ status: needsFetch ? 'loading' : 'ready' });
  useEffect(() => {
    if (!needsFetch) return;
    let alive = true;
    let blobUrl = null;
    (async () => {
      try {
        if (kind === 'md') {
          const d = await api(`/api/companies/${ws}/vault?rel=${encodeURIComponent(rel)}`);
          const content = String(d.content ?? '');
          if (alive) setSt({ status: 'ready', text: content.slice(0, PREVIEW_TEXT_CAP), truncated: content.length > PREVIEW_TEXT_CAP });
          return;
        }
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(String(res.status));
        // 상한 스트림 컷 — cap 초과분은 받지 않고 끊는다(대용량이 탭을 굳히지 않게)
        const reader = res.body.getReader();
        const chunks = []; let size = 0; let truncated = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); size += value.length;
          if (size > PREVIEW_TEXT_CAP) { truncated = true; reader.cancel().catch(() => {}); break; }
        }
        const buf = new Uint8Array(size);
        let off = 0; for (const c of chunks) { buf.set(c, off); off += c.length; }
        if (kind === 'svg') {
          if (truncated) { if (alive) setSt({ status: 'unsupported' }); return; } // 잘린 svg는 이미지가 못 된다 — 정직하게 다운로드 안내
          blobUrl = URL.createObjectURL(new Blob([buf], { type: 'image/svg+xml' }));
          if (!alive) { URL.revokeObjectURL(blobUrl); return; }
          setSt({ status: 'ready', src: blobUrl });
        } else if (alive) {
          setSt({ status: 'ready', text: new TextDecoder().decode(buf), truncated });
        }
      } catch {
        if (alive) setSt({ status: 'error' });
      }
    })();
    return () => { alive = false; if (blobUrl) URL.revokeObjectURL(blobUrl); };
    // fileUrl은 ws·rel의 파생값 — 의존성은 원천(ws·rel)으로 충분
  }, [ws, rel, kind, needsFetch]);
  const note = (msg) => (
    <div className="ap-note">
      <span style={{ minWidth: 0 }}>{msg}</span>
      <a className="btn sm" style={{ flex: 'none' }} href={`${fileUrl}&download=1`} download={name} onClick={artifactDownload(fileUrl, name)}>{t('vault.download')}</a>
    </div>
  );
  if (st.status === 'loading') return <div className="artifact-preview fade-up"><div className="ap-note" style={{ justifyContent: 'flex-start' }}><Spinner size={13} />{t('chat.preview')}…</div></div>;
  if (st.status === 'error') return <div className="artifact-preview fade-up">{note(t('chat.preview.error'))}</div>;
  if (kind === 'none' || st.status === 'unsupported') return <div className="artifact-preview fade-up">{note(t('chat.preview.unsupported'))}</div>;
  return (
    <div className="artifact-preview fade-up">
      {/* 로드 실패는 조용한 빈 상자가 아니라 텍스트 경로와 같은 계약(오류 안내+다운로드)으로 —
          img는 onError가 신뢰되고, iframe은 브라우저가 404를 프레임 안에 그려 best-effort다. */}
      {kind === 'img' && <div className="ap-body"><img src={fileUrl} alt={name} onError={() => setSt({ status: 'error' })} /></div>}
      {kind === 'svg' && <div className="ap-body"><img src={st.src} alt={name} onError={() => setSt({ status: 'error' })} /></div>}
      {/* inline=1 = 캐시 분리(라우트는 무시하는 파라미터) — 같은 URL의 다운로드 응답이 옛
          X-Frame-Options: DENY와 함께 24h 캐시돼 있으면 iframe이 그 사본을 재생해 빈 프레임이
          된다(실측: 헤더 교체 후에도 캐시 재생으로 차단 지속 → 캐시버스트로 즉시 렌더). */}
      {kind === 'pdf' && <iframe src={`${fileUrl}&inline=1`} title={name} onError={() => setSt({ status: 'error' })} />}
      {kind === 'md' && <div className="ap-body ap-md"><Markdown text={st.text} wsId={ws} /></div>}
      {kind === 'text' && <div className="ap-body"><pre className="ap-text">{st.text}</pre></div>}
      {st.truncated && note(t('chat.preview.truncated'))}
    </div>
  );
}

/** 산출물 칩 줄 — 기존 칩(클릭=뷰어/다운로드)에 눈 토글을 붙인다. 메시지당 하나만 펼침(채팅 흐름 보호). */
export function ArtifactChips({ ws, rels }) {
  const { t } = useLang();
  const [open, setOpen] = useState(null); // 펼친 rel
  // 세션 전환·스레드 갱신으로 rels가 바뀌어도 컴포넌트 인스턴스는 목록 key={i}로 재사용된다 —
  // 목록 밖 open을 그대로 그리면 다른 대화의 산출물 패널이 남는다(검수 MEDIUM-1 재현). 렌더는 항상 클램프.
  const shown = rels.includes(open) ? open : null;
  return (
    <>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {rels.map((rel) => {
          const name = rel.split('/').pop();
          const md = rel.endsWith('.md');
          const opened = shown === rel;
          return (
            <span key={rel} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <a className="memo-chip" download={md ? undefined : name}
                href={md ? `/c/${ws}/vault?doc=${encodeURIComponent(rel)}` : `/api/companies/${ws}/files?rel=${encodeURIComponent(rel)}&download=1`}
                onClick={md ? undefined : artifactDownload(`/api/companies/${ws}/files?rel=${encodeURIComponent(rel)}`, name)}
                title={`${t('chat.createdDocs')} — ${rel}`}>
                <Icon name="doc" size={12} />{name}
              </a>
              <button type="button" className="memo-chip ap-toggle" aria-expanded={opened}
                title={opened ? t('chat.preview.close') : t('chat.preview')}
                aria-label={`${opened ? t('chat.preview.close') : t('chat.preview')} — ${name}`}
                style={opened ? { color: 'var(--primary-strong)', borderColor: 'var(--primary)' } : undefined}
                onClick={() => setOpen(opened ? null : rel)}>
                <Icon name="eye" size={12} />
              </button>
            </span>
          );
        })}
      </span>
      {shown && <ArtifactPreview key={shown} ws={ws} rel={shown} />}
    </>
  );
}
