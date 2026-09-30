import { useMemo, useState } from 'react';
import { ModuleAddButton } from '../ui/ModuleGrid.jsx';
import ModuleSurface, { resolveSurfaceModule } from '../ui/ModuleSurface.jsx';
import { LIBRARY_MODULES } from '../core/module-registry.js';
import { navigate } from '../core/router.jsx';
import { t, useLang } from '../core/i18n.js';
import { useStore, saveLayout } from '../core/store.js';
import { mergeLayout } from '../core/layout.js';
import { baseOf } from '../core/commands.js';
import { DEFAULTS } from './modules.jsx';
import { SPACES, ME, canManage, getMode } from '../core/session.js';
import { reloadLayout } from '../core/pull.js';
import { showToast } from '../ui/Overlay.jsx';

export const layoutKey = (space) => `home:${space}`;
export const kindOf = (space) => (space === 'me' ? 'me' : 'org');
export function useHomeLayout(space) {
  const saved = useStore((s) => s.layouts[layoutKey(space)]);
  return useMemo(() => mergeLayout(saved, LIBRARY_MODULES, kindOf(space), DEFAULTS[kindOf(space)]), [saved, space]);
}

export function Home({ space }) {
  useLang();
  const items = useHomeLayout(space);
  const saved = useStore((state) => state.layouts[layoutKey(space)]);
  const [reloading, setReloading] = useState(false);
  const sp = SPACES.find((s) => s.key === space);
  const blocked = getMode() !== 'sample' && (!Number.isInteger(saved?.version) || saved?.conflict);
  const canEdit = canManage(space) && !blocked && !reloading;
  const save = (next) => {
    const saved = saveLayout(layoutKey(space), next);
    if (!saved) showToast(t('home.layoutBlocked'));
    return saved;
  };
  const reload = async () => {
    const owner = ME.id;
    setReloading(true);
    try { if (await reloadLayout(layoutKey(space)) === false && ME.id === owner) showToast(t('home.reloadFailed')); } catch { if (ME.id === owner) showToast(t('home.reloadFailed')); }
    finally { setReloading(false); }
  };
  const resolveModule = (item) => resolveSurfaceModule(item, space);
  const hidden = items.filter((item) => item.hidden).map((item) => ({ id: item.id, title: resolveModule(item).title, icon: resolveModule(item).icon, run: () => save([...items.filter((entry) => entry.id !== item.id), { ...item, hidden: false }]) }));
  hidden.push({ id: 'library', title: t('library.browse'), icon: 'plus', run: () => navigate(`${baseOf(space)}/business/library?target=home`) });
  const grid = <ModuleSurface id={layoutKey(space)} items={items} canEdit={canEdit} onChange={save} space={space} showRestore={false} />;
  const today = new Intl.DateTimeFormat(document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  return <div className="page-wrap wide">
    <div className="page-title-row">
      <div><p className="eyebrow">{today}</p><h1 className="page-h1">{sp.kind === 'me' ? `${t('home.title')} · ${ME.name}` : sp.name}</h1></div>
      {canManage(space) ? <div className="row-actions"><button type="button" className="btn ghost" disabled={!canEdit} onClick={() => save([])}>{t('home.reset')}</button><ModuleAddButton items={hidden} disabled={!canEdit} /></div> : <p className="dim small">{t('home.readOnly')}</p>}
    </div>
    {blocked && canManage(space) && <div className="conflict" role="status"><p className="small">{t(saved?.conflict ? 'home.layoutConflict' : 'home.layoutLoading')}</p><button type="button" className="btn sm" disabled={reloading} onClick={reload}>{t('page.conflictReload')}</button></div>}
    {grid}
  </div>;
}
