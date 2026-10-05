'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLang } from './i18n';
import { overlayActive, OVERLAY_EVENT, uiWorkActive, UI_WORK_EVENT } from './ui';
import { acknowledgeUpdateNotesVersion, closeUpdateNotes, isEditingElement, readUpdateNotesVersion,
  shouldAutoDismissUpdateNotes, shouldShowUpdateNotes, updateNotesFor, UPDATE_NOTES_BLUR_SETTLE_MS } from './update-notes-state.mjs';

// Later/error dismissals survive company navigation, but not a new app/browser session.
const dismissedVersions = new Set();
const bundleVersion = process.env.NEXT_PUBLIC_APP_VERSION || '';

// 자리: 상단바(56px) 바로 아래 오른쪽. 오른쪽 아래 고정이던 때는 크루 대화 보내기·데크 크루 영입·설정 '해제' 버튼을
// 덮었다(UX-A01, 2026-10-05). 높이는 하단 입력줄 구역(바닥 180px)을 남기도록 줄인다(test/display-zoom-layout 잠금).
export function UpdateNotesCard({ version, items, t, onConfirm, saving = false, error = '', onDismiss, onClose = onDismiss }) {
  const titleId = useId();
  return <section className="card card-float" role="dialog" aria-modal="false" aria-labelledby={titleId}
    onKeyDown={(event) => { if (event.key === 'Escape' && !saving) { event.stopPropagation(); onDismiss(); } }}
    style={{ position: 'fixed', right: 'max(16px, env(safe-area-inset-right))', top: '68px',
      width: 'min(420px, calc(90vw / var(--z, 1)))', maxWidth: 'calc(100% - max(16px, env(safe-area-inset-right)) - 16px)',
      maxHeight: 'max(120px, min(380px, calc(100vh / var(--z, 1) - 248px)))', overflowY: 'auto', overflowWrap: 'anywhere', zIndex: 90,
      background: 'var(--card)', boxShadow: 'var(--shadow-float)', color: 'var(--fg)' }}>
    <div className="card-head" style={{ gap: 8, alignItems: 'flex-start' }}>
      <h2 id={titleId} className="card-title" style={{ margin: 0, minWidth: 0, flex: 1, display: 'block', overflowWrap: 'anywhere' }}>{t('updates.title', { version })}</h2>
      <button type="button" className="btn sm" style={{ flexShrink: 0 }} disabled={saving} onClick={onClose} aria-label={t('common.close')}>×</button>
    </div>
    <div style={{ padding: '0 20px 18px', fontSize: 13, lineHeight: 1.6 }}>
      {items.length > 0 && <><p style={{ marginTop: 0, color: 'var(--fg-2)' }}>{t('updates.intro')}</p>
        <ul style={{ paddingLeft: 20, margin: '0 0 16px', display: 'grid', gap: 8 }}>
          {items.map((key) => <li key={key}>{t(key)}</li>)}
        </ul></>}
      {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="btn sm" disabled={saving} onClick={onDismiss}>{t('updates.later')}</button>
        {onConfirm && <button type="button" className="btn btn-primary sm" disabled={saving} onClick={onConfirm}>
          {t(saving ? 'updates.saving' : 'updates.confirm')}
        </button>}
      </div>
    </div>
  </section>;
}

export default function UpdateNotes({ current, ready, isApp, blocked = false }) {
  const { t } = useLang();
  const [record, setRecord] = useState(null);
  const [presentation, setPresentation] = useState(null);
  const [saving, setSaving] = useState(false);
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
  // 카드가 떠 있는데 입력을 시작하면 이번 실행에서는 접는다 — 숨겼다가 blur 때 다시 그리면 클릭을 먹는다(UX-A01).
  const visible = !!ready && items.length > 0 && !blocked && !surface.hidden && !surface.overlay && presentation?.key === key;
  useEffect(() => {
    if (shouldAutoDismissUpdateNotes({ visible, editing: surface.editing, saving })) dismiss();
  }, [visible, surface.editing, saving]); // eslint-disable-line react-hooks/exhaustive-deps
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

  if (!ready || !items.length || blocked || surface.hidden || surface.editing || surface.overlay || presentation?.key !== key) return null;
  return createPortal(<UpdateNotesCard version={current} items={presentation.errorOnly ? [] : items} t={t}
    onConfirm={presentation.errorOnly ? undefined : confirm} saving={saving}
    error={presentation.error ? t(presentation.error) : ''} onDismiss={dismiss} onClose={close} />, document.body);
}
