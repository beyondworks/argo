// 설정 저장본 메뉴·창(유건 10/1 6차 확정 1) — 홈 '저장본' 버튼을 누를 때 받는다(첫 화면 JS 150KB 상한, PresetButton.jsx).
// 규칙(무엇을 저장하고 어떻게 되돌리는지)은 core/presets-model.js. 쓰기는 저장·지우기(저장본 줄 1회)와 되돌리기(홈 배치 1회)뿐이다.
// 공용 메뉴(ui/Menu.jsx)는 줄마다 단추가 하나라 '각 줄에 지우기'를 못 담는다 — 같은 모양(.menu)의 작은 펼침 목록을 여기 둔다.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { t, getLang, setLang, registerDict, useLang } from '../core/i18n.js';
import { useStore, getState, saveLayout } from '../core/store.js';
import { readTheme, readShell, applyTheme, applyShell, isFullWidth, toggleWidth } from '../core/theme.js';
import { readCustom, saveCustom, refreshCustom, isEmpty, EMPTY } from '../core/custom-theme.js';
import { PRESETS_KEY, PRESET_LIMIT, NAME_MAX, presetsFor, capture, addPreset, removePreset, applyPreset } from '../core/presets-model.js';
import { reloadLayout } from '../core/pull.js';
import { record } from '../core/history.js';
import { PRESET_DICT } from './presets-i18n.js';
import './presets.css';

registerDict(PRESET_DICT);

const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { month: getLang() === 'en' ? 'short' : 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); };
const display = () => { const c = readCustom(); return { theme: readTheme(), shell: readShell(), custom: isEmpty(c) ? null : c, lang: getLang(), width: isFullWidth() ? 'full' : 'center' }; };

/** 저장본 줄 쓰기 — 못 쓰면(아직 안 불러옴·다른 기기와 충돌) 알리고 false. 충돌이면 서버 값을 새로 불러온다 */
function commit(items) {
  if (saveLayout(PRESETS_KEY, items)) return true;
  if (getState().layouts[PRESETS_KEY]?.conflict) { reloadLayout(PRESETS_KEY).catch(() => {}); showToast(t('presets.reloaded')); }
  else showToast(t('presets.blocked'));
  return false;
}

export default function Presets({ space, items: home, open }) {
  useLang();
  const all = useStore((s) => s.layouts[PRESETS_KEY]?.items);
  const list = presetsFor(all, space);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState(null); // { kind: 'save' | 'overwrite' | 'restore' | 'delete', ... }
  const seen = useRef(null); // 버튼을 다시 누르면 닫는다(개발 모드의 효과 두 번 실행에도 한 번만 바뀌게)
  useEffect(() => { if (seen.current === open) return; const first = !seen.current; seen.current = open; setMenu((m) => first || !m); }, [open]);
  const close = () => setDialog(null);

  const save = (preset, replace) => {
    const r = addPreset(getState().layouts[PRESETS_KEY]?.items, preset, { replace });
    if (r.exists) return setDialog({ kind: 'overwrite', preset });
    if (r.error) return setDialog({ kind: 'save', name: preset.name, err: r.error });
    if (commit(r.items)) { close(); showToast(t('presets.saved', { name: preset.name })); }
  };
  const restore = (p) => {
    const key = `home:${space}`;
    const ok = applyPreset(p, { current: getState().layouts[key]?.items, saveHome: (h) => { const ok = saveLayout(key, h); if (ok) record(key, home); return ok; }, // 배치 되돌리기(⌘Z)에 쌓는다(7차)
      applyTheme, applyShell,
      saveCustom: (c) => saveCustom(c ?? EMPTY), refreshCustom, setLang, setWidth: (full) => { if (isFullWidth() !== full) toggleWidth(); } });
    close();
    showToast(ok ? t('presets.restored', { name: p.name }) : t('home.layoutBlocked'));
  };
  const remove = (p) => { if (commit(removePreset(getState().layouts[PRESETS_KEY]?.items, space, p.name))) { close(); showToast(t('presets.deleted', { name: p.name })); } };

  const foot = (go, label, cls = 'primary', form) => <><button type="button" className="btn" onClick={close}>{t('presets.cancel')}</button>
    <button type={form ? 'submit' : 'button'} form={form} className={`btn ${cls}`} onClick={form ? undefined : go}>{label}</button></>;
  const d = dialog;
  return <>
    {menu && <PresetMenu anchor={open.at} list={list} onClose={() => setMenu(false)}
      onSave={() => setDialog({ kind: 'save', name: t('presets.defaultName', { when: when(new Date().toISOString()) }) })}
      onPick={(p) => setDialog({ kind: 'restore', preset: p })} onDelete={(p) => setDialog({ kind: 'delete', preset: p })} />}
    {d?.kind === 'save' && <Modal open width={420} title={t('presets.save')} onClose={close} footer={foot(null, t('presets.saveGo'), 'primary', 'preset-save')}>
      <form id="preset-save" className="preset-form" onSubmit={(e) => { e.preventDefault(); save(capture({ space, name: d.name, home, display: display(), at: new Date().toISOString() }), false); }}>
        <label className="field-block"><span className="label">{t('presets.name')}</span>
          <input className="input" value={d.name} maxLength={NAME_MAX} onChange={(e) => setDialog({ ...d, name: e.target.value, err: null })} /></label>
        <p className="dim small">{t('presets.saveHint')}</p>
        {d.err && <p className="preset-err small" role="alert">{t(`presets.err.${d.err}`, { n: PRESET_LIMIT })}</p>}
      </form>
    </Modal>}
    {d?.kind === 'overwrite' && <Modal open width={420} title={t('presets.overwriteTitle')} onClose={close} footer={foot(() => save({ ...d.preset, at: new Date().toISOString() }, true), t('presets.overwriteGo'))}>
      <p>{t('presets.overwriteBody', { name: d.preset.name })}</p>
    </Modal>}
    {d?.kind === 'restore' && <Modal open width={420} title={t('presets.restoreTitle')} onClose={close} footer={foot(() => restore(d.preset), t('presets.restoreGo'))}>
      <p>{t('presets.restoreBody', { name: d.preset.name })}</p><p className="dim small">{t('presets.restoreTip')}</p>
    </Modal>}
    {d?.kind === 'delete' && <Modal open width={420} title={t('presets.deleteTitle')} onClose={close} footer={foot(() => remove(d.preset), t('presets.deleteGo'), 'danger')}>
      <p>{t('presets.deleteBody', { name: d.preset.name })}</p>
    </Modal>}
  </>;
}

/** 버튼 아래 펼침 목록 — 공용 메뉴와 같은 닫기 규칙(바깥 누르기·Esc·스크롤·창 크기), 화살표로 단추 사이를 옮긴다 */
function PresetMenu({ anchor, list, onClose, onSave, onPick, onDelete }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const shut = (back = true) => { onClose(); if (back) anchor?.focus?.({ preventScroll: true }); };
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect(), el = ref.current, W = window.visualViewport?.width ?? innerWidth;
    setPos({ x: Math.max(8, Math.min(r.right - el.offsetWidth, W - el.offsetWidth - 8)), y: r.bottom + 4 });
    el.querySelector('button')?.focus({ preventScroll: true });
  }, [anchor]);
  useEffect(() => {
    const outside = (e) => { if (!ref.current?.contains(e.target) && !anchor.contains(e.target)) shut(false); };
    const away = (e) => { if (!ref.current?.contains(e.target)) shut(false); }; // 메뉴 안 스크롤(목록이 길 때·화살표 이동)로는 닫지 않는다(검수 6차)
    document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', away); document.addEventListener('scroll', away, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', away); document.removeEventListener('scroll', away, true); };
  });
  const onKeyDown = (e) => {
    const f = [...ref.current.querySelectorAll('button')], i = f.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); shut(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); f[(i + (e.key === 'ArrowDown' ? 1 : -1) + f.length) % f.length]?.focus(); }
    else if (e.key === 'Tab') shut(false);
  };
  const pick = (fn) => () => { shut(false); fn(); };
  return createPortal(
    <div ref={ref} className="menu preset-menu" role="menu" aria-label={t('presets.list')} onKeyDown={onKeyDown} style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, opacity: pos ? 1 : 0 }}>
      <button type="button" role="menuitem" className="menu-item" onClick={pick(onSave)}><span className="menu-ico"><Icon name="plus" size={14} /></span><span className="menu-label">{t('presets.save')}</span></button>
      <div className="menu-sep" role="separator" />
      <div className="menu-heading">{t('presets.list')}</div>
      {list.length ? list.map((p) => <div key={p.name} className="preset-row">
        <button type="button" role="menuitem" className="menu-item" onClick={pick(() => onPick(p))}><span className="menu-ico"><Icon name="layout" size={14} /></span><span className="menu-label">{p.name}</span><span className="preset-when">{when(p.at)}</span></button>
        <button type="button" className="icon-btn sm" aria-label={t('presets.deleteNamed', { name: p.name })} title={t('presets.deleteGo')} onClick={pick(() => onDelete(p))}><Icon name="trash" size={13} /></button>
      </div>) : <p className="preset-empty dim small">{t('presets.empty')}</p>}
    </div>,
    document.body,
  );
}
