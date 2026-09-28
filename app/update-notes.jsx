'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLang } from './i18n';
import { overlayActive, OVERLAY_EVENT, uiWorkActive, UI_WORK_EVENT } from './ui';
import { acknowledgeUpdateNotesVersion, isEditingElement, readUpdateNotesVersion,
  shouldShowUpdateNotes, updateNotesFor } from './update-notes-state.mjs';

// Later/error dismissals survive company navigation, but not a new app/browser session.
const dismissedVersions = new Set();
const bundleVersion = process.env.NEXT_PUBLIC_APP_VERSION || '';

export function UpdateNotesCard({ version, items, t, onConfirm, saving = false, error = '', onDismiss }) {
  const titleId = useId();
  return <section className="card card-float" role="dialog" aria-modal="false" aria-labelledby={titleId}
    onKeyDown={(event) => { if (event.key === 'Escape' && !saving) { event.stopPropagation(); onDismiss(); } }}
    style={{ position: 'fixed', right: 'max(16px, env(safe-area-inset-right))', bottom: 'max(16px, env(safe-area-inset-bottom))',
      width: 'min(420px, calc(90vw / var(--z, 1)))', maxWidth: 'calc(100% - max(16px, env(safe-area-inset-right)) - 16px)',
      maxHeight: 'min(520px, calc(80vh / var(--z, 1)))', overflowY: 'auto', overflowWrap: 'anywhere', zIndex: 90,
      background: 'var(--card)', boxShadow: 'var(--shadow-float)', color: 'var(--fg)' }}>
    <div className="card-head" style={{ gap: 8, alignItems: 'flex-start' }}>
      <h2 id={titleId} className="card-title" style={{ margin: 0, minWidth: 0, flex: 1, display: 'block', overflowWrap: 'anywhere' }}>{t('updates.title', { version })}</h2>
      <button type="button" className="btn sm" style={{ flexShrink: 0 }} disabled={saving} onClick={onDismiss} aria-label={t('common.close')}>×</button>
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
    const refresh = () => setSurface({ hidden: document.hidden,
      editing: isEditingElement(document.activeElement), overlay: overlayActive() || uiWorkActive() });
    const afterBlur = () => queueMicrotask(refresh);
    refresh();
    document.addEventListener('visibilitychange', refresh);
    document.addEventListener('focusin', refresh);
    document.addEventListener('focusout', afterBlur);
    window.addEventListener(OVERLAY_EVENT, refresh);
    window.addEventListener(UI_WORK_EVENT, refresh);
    return () => {
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
    error={presentation.error ? t(presentation.error) : ''} onDismiss={dismiss} />, document.body);
}
