'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLang } from './i18n';
import { Icon, overlayActive, OVERLAY_EVENT, uiWorkActive, UI_WORK_EVENT } from './ui';
import { acknowledgeUpdateNotesVersion, closeUpdateNotes, isEditingElement, readUpdateNotesVersion,
  shouldAutoDismissUpdateNotes, shouldShowUpdateNotes, updateNotesCardPlacement, updateNotesFor, updateNotesView, UPDATE_NOTES_BLUR_SETTLE_MS,
  UPDATE_NOTES_INLINE_STYLE, UPDATE_NOTES_SLOT_ID } from './update-notes-state.mjs';

// Later/error dismissals survive company navigation, but not a new app/browser session.
const dismissedVersions = new Set();
const bundleVersion = process.env.NEXT_PUBLIC_APP_VERSION || '';

// 자리: 회사 화면은 본문 맨 위 자리에 흐름대로(inline — 아래 내용을 밀어낸다, 덮지 않는다. T6 발견: 떠 있는 카드가 데크 '설정에서 연결하기'를 덮었다).
// 자리가 없을 때만 떠 있는 카드 — 상단바(56px) 바로 아래 오른쪽. 오른쪽 아래 고정이던 때는 크루 대화 보내기·데크 크루 영입·설정 '해제' 버튼을
// 덮었다(UX-A01, 2026-10-05). 높이는 하단 입력줄 구역(바닥 180px)을 남기도록 줄인다(test/display-zoom-layout 잠금).
export function UpdateNotesCard({ version, items, t, onConfirm, saving = false, error = '', onDismiss, onClose = onDismiss, inline = false }) {
  const titleId = useId();
  const ref = useRef(null);
  // 칩은 늘 보이는 상단바에 있다 — 스크롤을 내린 데크에서 펼쳐도 본문 맨 위 카드가 보이게 한다(scrollMarginTop 72 = 붙박이 상단바 56 + 여백, 상단바 밑에 숨지 않게)
  useEffect(() => { if (inline) ref.current?.scrollIntoView?.({ block: 'nearest' }); }, [inline]);
  return <section ref={ref} className={inline ? 'card' : 'card card-float'} role="dialog" aria-modal="false" aria-labelledby={titleId} data-update-notes={inline ? 'inline' : 'float'}
    onKeyDown={(event) => { if (event.key === 'Escape' && !saving) { event.stopPropagation(); onDismiss(); } }}
    style={inline ? UPDATE_NOTES_INLINE_STYLE : { position: 'fixed', right: 'max(16px, env(safe-area-inset-right))', top: '68px',
      width: 'min(420px, calc(90vw / var(--z, 1)))', maxWidth: 'calc(100% - max(16px, env(safe-area-inset-right)) - 16px)',
      maxHeight: 'max(120px, min(380px, calc(100vh / var(--z, 1) - 248px)))', display: 'flex', flexDirection: 'column', overflow: 'hidden', overflowWrap: 'anywhere', zIndex: 90,
      background: 'var(--card)', boxShadow: 'var(--shadow-float)', color: 'var(--fg)' }}>
    <div className="card-head" style={{ gap: 8, alignItems: 'flex-start' }}>
      <h2 id={titleId} className="card-title" style={{ margin: 0, minWidth: 0, flex: 1, display: 'block', overflowWrap: 'anywhere' }}>{t('updates.title', { version })}</h2>
      <button type="button" className="btn sm" style={{ flexShrink: 0 }} disabled={saving} onClick={onClose} aria-label={t('common.close')}>×</button>
    </div>
    {/* 내용만 스크롤한다 — 버튼 줄은 카드 하단에 고정(UL2: 1280×800에서 380px 제한에 '나중에·확인했어요'가 스크롤 아래로 숨었다) */}
    <div style={{ padding: '0 20px', fontSize: 13, lineHeight: 1.6, overflowY: 'auto', minHeight: 0, flex: '1 1 auto' }}>
      {items.length > 0 && <><p style={{ marginTop: 0, color: 'var(--fg-2)' }}>{t('updates.intro')}</p>
        <ul style={{ paddingLeft: 20, margin: '0 0 16px', display: 'grid', gap: 8 }}>
          {items.map((key) => <li key={key}>{t(key)}</li>)}
        </ul></>}
      {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
    <div style={{ padding: '10px 20px 18px', display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', flex: 'none' }}>
      <button type="button" className="btn sm" disabled={saving} onClick={onDismiss}>{t('updates.later')}</button>
      {onConfirm && <button type="button" className="btn btn-primary sm" disabled={saving} onClick={onConfirm}>
        {t(saving ? 'updates.saving' : 'updates.confirm')}
      </button>}
    </div>
  </section>;
}

/** 접힌 안내 — 상단바 안의 작은 칩(layout.jsx #argo-topbar-notes 자리). 화면 위에 떠 있지 않아 아무것도 덮지 않는다.
    펼친 카드를 스스로 띄우면 데크의 '설정에서 연결하기'를, 상단바 아래 알약도 크루 대화의 방금 보낸 글을 덮었다
    (UX-A01 검증 2026-10-05 실측). 내용은 사용자가 칩을 눌렀을 때만 펼친다. */
export function UpdateNotesChip({ version, t, onExpand }) {
  // 접힌 칩은 아이콘(✦)만 남는다(2차 M2). 이름은 aria-label이 지킨다
  return <button type="button" className="chip topbar-chip topbar-chip-notes" onClick={onExpand} title={t('updates.title', { version })} aria-label={t('updates.chip')}
    style={{ flex: 'none', cursor: 'pointer', fontSize: 10.5, textTransform: 'none', color: 'var(--fg)', borderColor: 'var(--fg-3)' }}>
    <span className="dot" style={{ background: 'var(--primary)' }} aria-hidden="true" /><span className="chip-icon"><Icon name="memory" size={14} /></span><span className="chip-label">{t('updates.chip')}</span>
  </button>;
}

/** 칩 자리가 없는 화면(상단바 없는 레이아웃)의 대체 — 한 줄 알약. */
export function UpdateNotesPill({ version, t, onExpand, onClose }) {
  return <section className="card card-float" role="status" aria-label={t('updates.title', { version })}
    style={{ position: 'fixed', right: 'max(16px, env(safe-area-inset-right))', top: '64px', zIndex: 90,
      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 14px', borderRadius: 999,
      maxWidth: 'calc(100% - 32px)', background: 'var(--card)', boxShadow: 'var(--shadow-float)', color: 'var(--fg)' }}>
    <span style={{ fontSize: 12.5, fontWeight: 650, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('updates.title', { version })}</span>
    <button type="button" className="btn sm" style={{ flexShrink: 0 }} onClick={onExpand}>{t('updates.view')}</button>
    <button type="button" className="btn sm" style={{ flexShrink: 0 }} onClick={onClose} aria-label={t('common.close')}>×</button>
  </section>;
}

export default function UpdateNotes({ current, ready, isApp, blocked = false }) {
  const { t } = useLang();
  const [record, setRecord] = useState(null);
  const [presentation, setPresentation] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false); // 사용자가 '보기'를 누른 때만 펼친다
  const [surface, setSurface] = useState({ hidden: true, editing: false, overlay: false });
  const savingRef = useRef(false);
  const liveKey = useRef('');
  const key = `${isApp ? 'app' : 'web'}:${current}`;
  liveKey.current = key;
  const items = updateNotesFor(current, bundleVersion);

  useEffect(() => {
    let settle = null;
    const refresh = () => { clearTimeout(settle); setSurface({ hidden: document.hidden,
      editing: isEditingElement(document.activeElement), overlay: overlayActive() || uiWorkActive() }); };
    // 입력창을 떠난 직후(보내기 버튼으로 포커스가 옮겨지는 그 클릭 도중)에 카드를 그리지 않는다 — 잠시 머문 뒤에만 다시 판정한다.
    const afterBlur = () => { clearTimeout(settle); settle = setTimeout(refresh, UPDATE_NOTES_BLUR_SETTLE_MS); };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    document.addEventListener('focusin', refresh);
    document.addEventListener('focusout', afterBlur);
    window.addEventListener(OVERLAY_EVENT, refresh);
    window.addEventListener(UI_WORK_EVENT, refresh);
    return () => {
      clearTimeout(settle);
      document.removeEventListener('visibilitychange', refresh);
      document.removeEventListener('focusin', refresh);
      document.removeEventListener('focusout', afterBlur);
      window.removeEventListener(OVERLAY_EVENT, refresh);
      window.removeEventListener(UI_WORK_EVENT, refresh);
    };
  }, []);

  useEffect(() => {
    if (!ready || !items.length || dismissedVersions.has(key)) return;
    let active = true;
    readUpdateNotesVersion({ isApp }).then((version) => {
      if (active) setRecord({ key, version });
    }).catch(() => {
      if (!active) return;
      dismissedVersions.add(key);
      // An unread marker is not proof this release is unseen. Show only the error, not notes.
      setPresentation({ key, error: 'updates.readError', errorOnly: true });
    });
    return () => { active = false; };
  }, [ready, isApp, key, items.length]);

  useEffect(() => {
    if (shouldShowUpdateNotes({ current, bundleVersion, ready, loaded: record?.key === key,
      ackVersion: record?.version, dismissed: dismissedVersions.has(key), blocked, ...surface })) {
      setPresentation((previous) => previous?.key === key ? previous : { key, error: '' });
    }
  }, [current, ready, key, record, blocked, surface]);

  const dismiss = () => { dismissedVersions.add(key); setPresentation(null); };
  // 닫기(×) — 같은 버전에서는 다시 띄우지 않는다(확인 기록). 기록 실패면 이번 실행에서만 접힌다(dismiss와 같음).
  const close = () => {
    dismiss();
    if (!presentation?.errorOnly) closeUpdateNotes(current, { isApp }).then((ok) => { if (ok && liveKey.current === key) setRecord({ key, version: current }); });
  };
  // 펼친 카드가 떠 있는데 입력을 시작하면 이번 실행에서는 접는다 — 숨겼다가 blur 때 다시 그리면 클릭을 먹는다(UX-A01).
  // 상단바 칩은 아무것도 덮지 않으므로 입력과 무관하게 둔다.
  const visible = expanded && !!ready && items.length > 0 && !blocked && !surface.hidden && !surface.overlay && presentation?.key === key;
  useEffect(() => {
    if (shouldAutoDismissUpdateNotes({ visible, editing: surface.editing, saving })) dismiss();
  }, [visible, surface.editing, saving]); // dismiss는 매 렌더 새 함수지만 key 외 상태를 읽지 않아 deps에서 뺀다
  const confirm = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try {
      await acknowledgeUpdateNotesVersion(current, { isApp });
      dismissedVersions.add(key);
      if (liveKey.current === key) { setRecord({ key, version: current }); setPresentation(null); }
    } catch {
      dismissedVersions.add(key);
      if (liveKey.current === key) setPresentation({ key, error: 'updates.saveError' });
    } finally { savingRef.current = false; setSaving(false); }
  };

  if (!ready || !items.length || blocked || presentation?.key !== key) return null;
  // 접힌 상태 — 상단바 칩(덮는 것 없음, 입력 중에도 보임). 자리가 없으면 알약. 오류만 알릴 때·사용자가 펼쳤을 때만 카드
  const host = document.getElementById('argo-topbar-notes');
  const view = updateNotesView({ hasChipHost: !!host, expanded, errorOnly: !!presentation.errorOnly, error: presentation.error, ...surface });
  if (view === 'chip') return createPortal(<UpdateNotesChip version={current} t={t} onExpand={() => setExpanded(true)} />, host);
  if (view === 'pill') return createPortal(<UpdateNotesPill version={current} t={t} onExpand={() => setExpanded(true)} onClose={close} />, document.body);
  if (view !== 'card') return null;
  const place = updateNotesCardPlacement(document.getElementById(UPDATE_NOTES_SLOT_ID));
  return createPortal(<UpdateNotesCard version={current} items={presentation.errorOnly ? [] : items} t={t} inline={place.inline}
    onConfirm={presentation.errorOnly ? undefined : confirm} saving={saving}
    error={presentation.error ? t(presentation.error) : ''} onDismiss={dismiss} onClose={close} />, place.host ?? document.body);
}
