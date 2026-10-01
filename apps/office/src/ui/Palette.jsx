// ⌘K — 이동·검색·명령을 한 입력창에서. 키보드로 하루 수십 번 여는 창이라 애니메이션 없음(emil 규칙).
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';
import { t } from '../core/i18n.js';
import { globalCommands, baseOf } from '../core/commands.js';
import { navigate } from '../core/router.jsx';
import { useStore } from '../core/store.js';
import { imeGuardWith } from '../core/ime.js';

export function Palette({ open, onClose, space }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef(null);
  const pages = useStore((s) => s.pages);
  const mails = useStore((s) => s.mails);
  useEffect(() => { if (open) { setQ(''); setIdx(0); requestAnimationFrame(() => input.current?.focus()); } }, [open]);
  const [more, setMore] = useState([]); // 일정·할 일·보기 명령 — 창을 열 때 따로 받는다(첫 화면 150KB 상한)
  useEffect(() => { if (open) import('../views/commands.js').then((m) => setMore(m.viewCommands(space))).catch(() => {}); }, [open, space]);

  const rows = useMemo(() => {
    if (!open) return [];
    const needle = q.trim().toLowerCase();
    const hit = (s) => !needle || s.toLowerCase().includes(needle);
    const cmds = [...globalCommands(space), ...more].filter((c) => hit(c.label)).slice(0, needle ? 8 : 6).map((c) => ({ ...c, group: 'commands' }));
    const pg = pages.filter((p) => !p.template && (p.space === space || space === 'me') && hit(p.title || t('page.untitled'))).slice(0, 6)
      .map((p) => ({ id: p.id, label: p.title || t('page.untitled'), icon: p.restricted ? 'lock' : 'doc', group: 'pages', run: () => navigate(`${baseOf(p.space)}/p/${p.id}`) }));
    const ml = space === 'me' && needle ? mails.filter((m) => hit(m.subject) || hit(m.from)).slice(0, 4)
      .map((m) => ({ id: m.id, label: m.subject, hint: m.from, icon: 'mail', group: 'mail', run: () => navigate(`/me/mail/${m.id}`) })) : [];
    return [...pg, ...ml, ...cmds];
  }, [open, q, space, pages, mails, more]);

  if (!open) return null;
  const run = (r) => { onClose(); r?.run(); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(rows[idx]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  let last = null;
  return createPortal(
    <div className="scrim scrim-top" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('nav.search')}>
        <label className="palette-input"><Icon name="search" />
          <input ref={input} value={q} placeholder={t('palette.ph')} onChange={(e) => { setQ(e.target.value); setIdx(0); }} {...imeGuardWith(onKey)}
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={rows[idx] ? `pal-${idx}` : undefined} />
        </label>
        <div className="palette-list" id="palette-list" role="listbox">
          {rows.length === 0 && <div className="palette-empty">{t('palette.none')}</div>}
          {rows.map((r, i) => {
            const head = r.group !== last ? <div className="palette-group" key={`g-${r.group}`}>{t(`palette.${r.group}`)}</div> : null;
            last = r.group;
            return [head, <button key={`${r.group}-${r.id}`} id={`pal-${i}`} type="button" role="option" aria-selected={i === idx} className={`palette-row${i === idx ? ' on' : ''}`}
              onPointerMove={() => setIdx(i)} onClick={() => run(r)}>
              <Icon name={r.icon} size={14} /><span className="palette-label">{r.label}</span>{r.hint && <span className="palette-hint">{r.hint}</span>}{r.shortcut && <kbd>{r.shortcut}</kbd>}
            </button>];
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
