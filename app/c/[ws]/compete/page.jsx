'use client';
// 경쟁 시안 — 같은 과제를 크루 2~3명에게 동시에 맡기고, 시안을 나란히 비교해 채택한다(경쟁 PT).
// 격리: 경쟁 중 시안은 크루 개인 대화를 오염시키지 않고, 채택본만 승자 스레드에 기록된다.
// 레이아웃은 회의실과 같은 문법 — 헤더 라인 → 전체 높이 카드 → 하단 고정 컴포저 → 힌트 (UI 일관성).
import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Avatar, Icon, Markdown, ArgoSpinner, Skeleton, ConfirmModal, InputModal, DropUp, api, imeGuardWith } from '../../../ui';
import { useLang } from '../../../i18n';

const MAX_PICK = 3;

export default function Compete({ params }) {
  const { ws } = use(params);
  const { t } = useLang();
  const [agents, setAgents] = useState([]);
  const [list, setList] = useState(null);      // 좌측 레일 — 경쟁 목록
  const [renameComp, setRenameComp] = useState(null); // 경쟁명 편집 모달 대상
  // 경쟁명 편집·고정 — 세션 레일과 동일 계약(PATCH /compete/[id] {title}|{pinned})
  async function doRenameComp(title) {
    const c = renameComp; setRenameComp(null);
    if (!c) return;
    try {
      await fetch(`/api/companies/${ws}/compete/${c.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      loadList();
    } catch { /* 레일 갱신 실패는 다음 로드에서 복구 */ }
  }
  async function doTogglePin(c) {
    try {
      await fetch(`/api/companies/${ws}/compete/${c.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: !c.pinned }),
      });
      loadList();
    } catch { /* 동일 */ }
  }
  const [comp, setComp] = useState(null);      // 열람 중 경쟁 (null = 새 경쟁)
  const [prompt, setPrompt] = useState('');
  // 여러 줄 입력 — 줄바꿈(Shift+Enter)하면 입력창이 따라 자란다(유건 2026-08-23). 크루 대화창과 같은 규칙: 최대 6줄 후 내부 스크롤
  const composerRef = useRef(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    if (!prompt) { el.style.height = ''; return; }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [prompt]);
  const [pickedCrew, setPickedCrew] = useState(''); // 경쟁을 받을 크루 1명(slug)
  const [pickedModels, setPickedModels] = useState([]); // "runner:model" 페어 2~3개
  const [runners, setRunners] = useState(null); // 러너 카탈로그(연결 상태 포함) — 모델 선택지
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adoptTarget, setAdoptTarget] = useState(null); // 채택 확인 모달 대상(entrant key — 레거시는 slug)
  const compRef = useRef(null);
  compRef.current = comp;

  const loadList = useCallback(() => {
    api(`/api/companies/${ws}/compete`).then((d) => setList(d.competitions ?? [])).catch(() => setList([]));
  }, [ws]);
  useEffect(() => {
    loadList();
    api(`/api/companies/${ws}/agents`).then((d) => {
      const list = d.agents ?? [];
      setAgents(list);
      setPickedCrew((cur) => cur || (list[0]?.slug ?? '')); // 크루가 있으면 첫 크루 기본 선택(빈 드롭다운 방지)
    }).catch(() => {});
    api(`/api/runners?ws=${ws}`).then((d) => setRunners(d.runners ?? [])).catch(() => setRunners([]));
  }, [ws, loadList]);

  // 진행 중 경쟁 폴링 — 열람 중인 경쟁이 running이면 4초마다 갱신
  useEffect(() => {
    if (comp?.status !== 'running') return;
    const iv = setInterval(() => {
      api(`/api/companies/${ws}/compete/${comp.id}`)
        .then((d) => { if (compRef.current?.id === d.id) { setComp(d); if (d.status !== 'running') loadList(); } })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(iv);
  }, [ws, comp?.id, comp?.status, loadList]);

  // 모델 슬롯 편집 — pickedModels[i]를 드롭다운 슬롯 단위로 바꾼다(빈 값=슬롯 비움, 뒤 슬롯이 당겨짐)
  const setModelSlot = (i, v) => setPickedModels((prev) => {
    const next = [...prev];
    if (v) next[i] = v; else next.splice(i, 1);
    return next.filter(Boolean).slice(0, MAX_PICK);
  });

  async function start(e) {
    e.preventDefault();
    if (busy || !prompt.trim() || !pickedCrew || pickedModels.length < 2) return;
    setBusy(true); setError('');
    try {
      const entrants = pickedModels.map((pair) => {
        const [runner, ...rest] = pair.split(':');
        return { slug: pickedCrew, runner, model: rest.join(':') };
      });
      const d = await api(`/api/companies/${ws}/compete`, { prompt: prompt.trim(), entrants });
      setComp(d); setPrompt(''); setPickedModels([]);
      loadList();
    } catch (err) { setError(String(err.message)); } finally { setBusy(false); }
  }

  async function openComp(id) {
    if (!id) { setComp(null); setError(''); return; }
    try { setComp(await api(`/api/companies/${ws}/compete/${id}`)); setError(''); }
    catch (e) { setError(String(e.message)); }
  }

  function adopt(ref) { if (!busy) setAdoptTarget(ref); } // window.confirm(Tauri 무동작) 대신 인앱 ConfirmModal
  async function doAdopt() {
    const ref = adoptTarget;
    if (!ref || busy) return;
    setBusy(true); setError(''); setAdoptTarget(null);
    try {
      const d = await api(`/api/companies/${ws}/compete/${comp.id}`, { action: 'adopt', slug: ref });
      setComp(d); loadList();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (err) { setError(String(err.message)); } finally { setBusy(false); }
  }

  const winnerEnt = comp?.winner ? comp.entrants.find((x) => (x.key ?? x.slug) === comp.winner) : null;
  const winnerName = winnerEnt ? `${winnerEnt.name}${winnerEnt.modelLabel ? ` · ${winnerEnt.modelLabel}` : ''}` : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '216px minmax(0, 1fr)', gap: 18, alignItems: 'start', height: 'calc(100vh / var(--z, 1) - 100px)', marginBottom: -70 }}>
      {adoptTarget && (
        <ConfirmModal
          title={t('compete.adopt')}
          description={t('compete.confirmAdopt', { name: (() => { const e = comp?.entrants.find((x) => (x.key ?? x.slug) === adoptTarget); return e ? `${e.name}${e.modelLabel ? ` · ${e.modelLabel}` : ''}` : adoptTarget; })() })}
          confirmLabel={t('common.confirm')}
          tone="primary"
          busy={busy}
          onConfirm={doAdopt}
          onClose={() => setAdoptTarget(null)}
        />
      )}
      {/* offset 100 = topbar56+상단26+하단여백18, marginBottom -70 = .content 하단 패딩(88) 상쇄로 body 스크롤 방지(입력창 하향·대화영역 확대). 본문 컬럼 minHeight:0과 한 세트(회의실·DM 동일). */}
      {/* 경쟁 레일 — 지난 경쟁이 적재된다. 무템플릿 grid 함정 방지: minmax(0,1fr) */}
      <div className="side-rail" style={{ position: 'sticky', top: 72, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, width: 216 }}>
        <span className="microlabel" style={{ padding: '2px 6px 4px' }}>
          {t('compete.sessions.title')}{list?.length ? ` · ${list.length}` : ''}
        </span>
        <button className={`nav-item${!comp ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openComp(null)}>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t('compete.new')}</span>
            <span className="nav-sub">{t('compete.sessions.newSub')}</span>
          </span>
        </button>
        {(list ?? []).map((c) => {
          const active = comp?.id === c.id;
          const pinColor = active ? 'var(--primary-fg)' : 'var(--primary)'; // 활성 골드 배경 위 골드 핀 겹침 방지(세션 레일 공통)
          const actColor = active ? 'var(--primary-fg)' : 'var(--fg-3)';
          return (
          <div key={c.id} className="rail-item" style={{ position: 'relative' }}>
            <button className={`nav-item${active ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer', paddingRight: 48 }} onClick={() => openComp(c.id)}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600 }}>
                  {c.pinned && <Icon name="pin" size={11} style={{ flex: 'none', color: pinColor }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title || c.topic}</span>
                </span>
                <span className="nav-sub" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  {c.status === 'running' && <ArgoSpinner size={10} />}
                  {new Date(c.createdAt).toLocaleDateString('sv-SE')} · {c.entrants[0]?.modelLabel ? `${c.entrants[0].name} · ${c.entrants.map((e) => e.modelLabel ?? '?').join(' vs ')}` : c.entrants.map((e) => e.name).join(' · ')}
                </span>
              </span>
            </button>
            <span className="rail-actions" style={{ position: 'absolute', right: 5, top: 7, display: 'flex', gap: 1 }}>
              <button type="button" title={c.pinned ? t('chat.sessions.unpin') : t('chat.sessions.pin')} aria-label={c.pinned ? t('chat.sessions.unpin') : t('chat.sessions.pin')}
                onClick={(e) => { e.stopPropagation(); doTogglePin(c); }}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: c.pinned ? pinColor : actColor, cursor: 'pointer', borderRadius: 6 }}>
                <Icon name="pin" size={12} />
              </button>
              <button type="button" title={t('chat.sessions.rename')} aria-label={t('chat.sessions.rename')}
                onClick={(e) => { e.stopPropagation(); setRenameComp(c); }}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: actColor, cursor: 'pointer', borderRadius: 6 }}>
                <Icon name="edit" size={12} />
              </button>
            </span>
          </div>
          );
        })}
        {list !== null && list.length === 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '2px 6px', lineHeight: 1.5 }}>{t('compete.sessions.empty')}</span>
        )}
        {list === null && <Skeleton h={48} />}
      </div>

      {renameComp && (
        <InputModal
          title={t('chat.sessions.renameTitle')}
          defaultValue={renameComp.title || renameComp.topic || ''}
          placeholder={t('chat.sessions.renamePh')}
          confirmLabel={t('common.save')}
          onConfirm={doRenameComp}
          onClose={() => setRenameComp(null)}
        />
      )}

      {/* 본문 — 회의실과 동일 문법: 헤더 라인 / 전체 높이 카드 / 하단 컴포저 */}
      {/* 열 잠금 minmax(0,1fr) — 무템플릿 grid의 암묵 auto 열은 자식 min-content(컴포저 textarea
          고유폭·nowrap 상태 칩 등)만큼 부풀어, 표시 배율 2의 좁은 유효 폭에서 문서 가로 넘침을
          만든다(실측 scrollWidth 1428 > 1408 — 회의실 동종). 아이템 minWidth:0은 바깥 트랙만
          지키고 자기 내부 트랙은 못 지킨다. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'auto 1fr auto', gap: 12, height: '100%', minWidth: 0, minHeight: 0 }}>
        {/* 좁은 유효 폭 축소 규칙 — 라벨은 한 줄 ellipsis(단어별 세로 쌓임 방지), 상태 칩(nowrap)은
            안 들어가면 wrap으로 아랫줄에(회의실 헤더와 동일 문법). */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <span className="microlabel" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('compete.header')}</span>
          <span className="rule" style={{ flex: 1 }} />
          {comp?.status === 'running' && <span className="chip" style={{ flex: 'none' }}><ArgoSpinner size={11} /> {t('compete.running')}</span>}
          {comp?.winner && <span className="chip" style={{ borderColor: 'var(--warn)', color: 'var(--warn)', fontWeight: 700, flex: 'none' }}>{t('compete.adopted')}</span>}
        </div>

        {/* overflowWrap anywhere — 긴 무공백 토큰(URL·코드 조각)이 좁은 유효 폭에서 카드 내부 가로
            스크롤을 만들지 않게 한다(크루 채팅 .thread .card(globals)와 동형 처방 — 회의실은
            PR #350이 같은 처방을 진행 중). */}
        <div className="card" style={{ padding: '16px 18px', overflowY: 'auto', minHeight: 0, overflowWrap: 'anywhere' }}>
          {!comp ? (
            <div className="empty">{t('compete.emptyMain')}</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0 }}> {/* 열 잠금 — 본문 열과 같은 이유(과제문·시안 행 min-content 전파 차단) */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <Icon name="bolt" size={14} style={{ marginTop: 2, flex: 'none' }} />
                <span style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', minWidth: 0 }}>{comp.prompt}</span>
              </div>
              {comp.winner && (
                <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0 }}>
                  {t('compete.adoptedNote', { name: winnerName })}{' '}
                  <Link href={`/c/${ws}/crew/${winnerEnt?.slug ?? comp.winner}`} style={{ color: 'var(--primary-strong)', fontWeight: 650 }}>{t('compete.goCrew')} →</Link>
                </p>
              )}
              {/* 시안 나열 — 나란히 비교가 핵심 UX지만 고정 N열(트랙 min 0)은 좁은 유효 폭에서 시안
                  카드를 37 CSS px까지 눌러 채택 버튼·상태 칩이 이웃 카드 위로 겹친다(배율 2 실측 —
                  비교 자체가 불가). auto-fit + 최소폭 클램프 = 들어가는 만큼만 나란히, 안 들어가면
                  아랫줄로(전 시안 동시 가시 유지 — 가로 스크롤 대안은 오버레이 스크롤바가 돌출을
                  숨겨 뒷 시안의 발견성을 죽인다). min(…, 100%) 캡은 180px 미만 컨테이너에서 트랙
                  min이 컨테이너를 뚫는 것을 막는다(DropUp 트리거 클램프 동형). 180 = 종전 3열이
                  컨테이너 564 CSS px(배율 1 풀셸 뷰포트 ≈1126)에서 자연히 갖던 카드 폭 — 그 위
                  (1152·1280 노트북 폭 포함)는 3열 나란히가 종전과 동일하고 그 아래에서만 적층으로
                  갈린다(재검수 실측: 240이면 1152·1280의 멀쩡하던 3열까지 2+1로 바뀐다). */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 12, alignItems: 'start' }}>
                {comp.entrants.map((e) => {
                  const ref = e.key ?? e.slug; // 신형=key(모델 경쟁), 레거시=slug(크루 경쟁)
                  const isWinner = comp.winner === ref;
                  return (
                    <div key={ref} className="card" style={{
                      /* 열 잠금 — 카드 자신의 minWidth:0은 바깥(시안 나열) 트랙만 지킨다. 내부 암묵
                         auto 열은 Markdown 시안 본문 min-content로 부풀어 카드 밖으로 샌다. */
                      padding: '14px 16px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0,
                      ...(isWinner ? { borderColor: 'var(--warn)', boxShadow: '0 0 0 1px var(--warn)' } : {}),
                      ...(comp.winner && !isWinner ? { opacity: 0.55 } : {}),
                    }}>
                      {/* 카드 헤더 wrap — 아바타 24+gap 24+칩(nowrap) 고정 합이 협폭 카드(100% 클램프
                          1열, 실측 132 CSS px) 내용 폭을 넘으면 칩이 카드 밖으로 샌다(실측 +3px).
                          페이지 헤더와 동일 문법: 칩은 안 들어가면 아랫줄로. */}
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <Avatar name={e.name} size={24} />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 12.5, fontWeight: 650 }}>{e.name}</span>
                          {/* 모델 경쟁이면 어떤 모델의 답인지가 비교 축 — 역할 대신 모델을 보인다 */}
                          <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-3)', fontFamily: e.modelLabel ? 'var(--mono)' : undefined }}>{e.modelLabel || e.role}</span>
                        </span>
                        <span style={{ flex: 1 }} />
                        {e.status === 'running' && <ArgoSpinner size={13} />}
                        {isWinner && <span className="chip" style={{ borderColor: 'var(--warn)', color: 'var(--warn)', fontWeight: 700 }}>{t('compete.adopted')}</span>}
                        {e.status === 'error' && <span className="chip" style={{ color: 'var(--danger)' }}>{t('compete.failed')}</span>}
                      </div>
                      <div style={{ fontSize: 13, minWidth: 0 }}>
                        {e.status === 'running' && <Skeleton h={80} />}
                        {e.status === 'error' && <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0, whiteSpace: 'pre-wrap' }}>{e.error}</p>}
                        {e.status === 'done' && <Markdown text={e.reply ?? ''} wsId={ws} />}
                      </div>
                      {e.status === 'done' && !comp.winner && (
                        /* 버튼 줄바꿈·세로 자람 — .btn 전역 nowrap이 유일한 비축소 요소라 극단 협폭
                           (실측 en·1280 창 × 배율 2: 카드 58에 버튼 126)에서 카드 밖으로 샌다.
                           하단 바 새 경쟁 버튼과 동일 세트. */
                        <button className="btn btn-primary sm" disabled={busy} onClick={() => adopt(ref)} style={{ justifySelf: 'start', whiteSpace: 'normal', height: 'auto', minHeight: 28, padding: '4px 12px' }}>
                          {t('compete.adopt')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {comp ? (
          /* 열람 중 — 회의실 보관 열람과 동일한 하단 바 문법.
             바 wrap + 버튼 줄바꿈·세로 자람 — 버튼(.btn 전역 nowrap)이 유일한 비축소 요소라
             좁은 유효 폭(실측 en·1280 창 × 배율 2: 1335>1264)에서 문서 가로 넘침을 만들었다.
             .btn.sm 고정 height 28은 라벨 2줄에서 글자가 알약 밖으로 새므로 height auto 세트(회의실 동형). */
          <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, fontSize: 12.5, color: 'var(--fg-2)' }}>
            <Icon name="bolt" size={13} /> {comp.winner ? t('compete.closedBar') : comp.status === 'running' ? t('compete.runningBar') : t('compete.doneBar')}
            <span style={{ flex: 1 }} />
            <button className="btn btn-primary sm" style={{ whiteSpace: 'normal', height: 'auto', minHeight: 28, padding: '4px 12px' }} onClick={() => openComp(null)}>{t('compete.new')}</button>
          </div>
        ) : (
          /* 새 경쟁 컴포저 — 회의실 컴포저와 동일 문법: 칩 행 → input-bar → 힌트 */
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }}> {/* 열 잠금 — 본문 열과 같은 이유(한 층 아래 같은 함정: textarea 고유폭) */}
            {/* 라벨 열 공유 grid — 두 행의 박스 좌측 라인이 정렬된다(모델 선택 왼편 기준, 유건 지시 2026-07-21).
                드롭다운은 전부 DropUp(위로 열림) — 하단 배치라 네이티브 select 팝업이 아래로 열려 잘렸다. */}
            {/* 크루·모델 선택을 한 줄로(유건 2026-08-23) — 좁으면 줄바꿈 */}
            {/* 그룹 minWidth:0 — flex 아이템 자동 최소치(내용 min-content)가 좁은 유효 폭(배율 2,
                1280 창 실측 열 106 CSS px)에서 DropUp 바닥(148)을 그대로 전파해 문서 가로 넘침을
                만든다(실측 1283>1264 → 해제 후 1264=1264). DropUp 자체 클램프(ui.jsx)와 한 세트. */}
            <div style={{ display: 'flex', gap: '6px 14px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="microlabel">{t('compete.pick')}</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}>
                {/* 크루 1명 — 등록된 모든 크루 중 선택 */}
                <DropUp value={pickedCrew} disabled={busy} width={220} placeholder="—"
                  groups={[{ items: agents.map((a) => ({ value: a.slug, label: `${a.name} — ${a.role}` })) }]}
                  onChange={setPickedCrew} />
                {agents.length === 0 && (
                  <Link href={`/c/${ws}`} style={{ fontSize: 12, color: 'var(--primary-strong)', fontWeight: 650 }}>{t('nav.hire')} →</Link>
                )}
              </div>
              <span className="microlabel">{t('compete.pickModels')}</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}>
                {/* 슬롯 — 연결된 러너의 모델만, 러너별 그룹. 다른 슬롯이 고른 모델은 비활성(중복 방지). */}
                {runners === null ? <Skeleton h={28} w={220} /> : (() => {
                  const connected = (runners ?? []).filter((r) => r.authed && r.models?.length);
                  if (!connected.length) {
                    return <Link href={`/c/${ws}/settings`} style={{ fontSize: 12, color: 'var(--primary-strong)', fontWeight: 650 }}>{t('compete.connectFirst')} →</Link>;
                  }
                  const slotGroups = (slot, clearable) => [
                    ...(clearable ? [{ items: [{ value: '', label: t('compete.modelSlotOptPh') }] }] : []),
                    ...connected.map((r) => ({
                      label: r.name,
                      items: r.models.map((m) => {
                        const pair = `${r.id}:${m.id}`;
                        return {
                          value: pair, label: m.label,
                          disabled: pickedModels.includes(pair) && pickedModels[slot] !== pair,
                          badge: m.gated ? t('runner.gatedBadge') : m.free ? t('runner.freeBadge') : undefined,
                        };
                      }),
                    })),
                  ];
                  return (<>
                    <DropUp value={pickedModels[0] ?? ''} disabled={busy} width={210} placeholder={t('compete.modelSlotPh')}
                      groups={slotGroups(0, false)} onChange={(v) => setModelSlot(0, v)} />
                    <span className="microlabel" aria-hidden>vs</span>
                    <DropUp value={pickedModels[1] ?? ''} disabled={busy} width={210} placeholder={t('compete.modelSlotPh')}
                      groups={slotGroups(1, false)} onChange={(v) => setModelSlot(1, v)} />
                    {/* 3번째는 선택 — 앞 2개를 고른 뒤에만 열린다. 빈 값 선택 = 슬롯 비우기 */}
                    <DropUp value={pickedModels[2] ?? ''} disabled={busy || pickedModels.length < 2} width={210}
                      placeholder={t('compete.modelSlotOptPh')} groups={slotGroups(2, true)} onChange={(v) => setModelSlot(2, v)} />
                  </>);
                })()}
              </div>
            </div>
            {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
            <form onSubmit={start} className="input-bar" style={{ background: 'var(--card-2)', alignItems: 'flex-end', borderRadius: 22 }}>
              <textarea suppressHydrationWarning
                ref={composerRef}
                rows={1}
                placeholder={t('compete.placeholder')}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={busy}
                {...imeGuardWith((e) => {
                  if (e.key !== 'Enter' || e.shiftKey) return; // Shift+Enter = 줄바꿈
                  e.preventDefault(); e.currentTarget.form?.requestSubmit(); // Enter = 시작
                })}
              />
              <button className="btn btn-primary btn-icon" disabled={busy || !prompt.trim() || !pickedCrew || pickedModels.length < 2} aria-label={t('compete.start')}>
                {busy ? <ArgoSpinner size={14} /> : <Icon name="send" size={15} />}
              </button>
            </form>
            <p style={{ fontSize: 11, color: pickedModels.length >= 2 ? 'var(--warn)' : 'var(--fg-3)', margin: 0 }}>
              {pickedModels.length >= 2 ? t('compete.costNote', { n: pickedModels.length }) : t('compete.hint')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
