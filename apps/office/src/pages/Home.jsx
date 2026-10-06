import { useMemo, useRef, useState } from 'react';
import { ModuleAddButton } from '../ui/ModuleGrid.jsx';
import ModuleSurface, { resolveSurfaceModule } from '../ui/ModuleSurface.jsx';
import { LIBRARY_MODULES } from '../core/module-registry.js';
import { createModuleItem, addModuleItem } from '../core/module-placement-model.js';
import { navigate } from '../core/router.jsx';
import { t, useLang } from '../core/i18n.js';
import { useStore, saveLayout } from '../core/store.js';
import { mergeLayout } from '../core/layout.js';
import { baseOf } from '../core/commands.js';
import { DEFAULTS } from './modules.jsx';
import { SPACES, ME, canManage, getMode } from '../core/session.js';
import { reloadLayout } from '../core/pull.js';
import { showToast } from '../ui/Overlay.jsx';
import { PresetButton } from './PresetButton.jsx';
import { record } from '../core/history.js';

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
  // 격자 밖 배치 바꾸기(맞춤·추가·되살리기) — 저장에 성공하면 되돌리기에 쌓는다. 격자 안 동작(옮기기·크기·숨기기)은 격자가 쌓는다(7차)
  const change = (next) => { const ok = save(next); if (ok) record(layoutKey(space), items); return ok; };
  const resolveModule = (item) => resolveSurfaceModule(item, space);
  // 모듈 맞춤(유건 10/1 밤 6차) — 높이만, 스크롤바가 생기지 않게·옆 모듈과 아래 끝이 맞게. 재고 계산하는 코드는 누를 때 받는다. 이미 맞으면 저장하지 않는다
  const wrap = useRef(null);
  const fit = () => import('../ui/module-fit.js').then((m) => m.run(wrap.current, items, resolveModule, change), () => {});
  const seen = new Map(); // 숨긴 사본은 이름이 같다 — 두 번째부터 번호를 붙여 구분(검수 10/1 5차)
  const hidden = items.filter((item) => item.hidden).map((item) => { const { title, icon } = resolveModule(item), n = (seen.get(title) ?? 0) + 1; seen.set(title, n);
    return { id: item.id, title: n > 1 ? `${title} ${n}` : title, icon, run: () => change([...items.filter((entry) => entry.id !== item.id), { ...item, hidden: false }]) }; });
  // 여러 번 놓는 모듈(캘린더·할 일)은 '모듈 추가'에서 바로 하나 더(유건 10/1 5차 추가사항 3) — 새 사본은 맨 아래에 붙는다
  for (const m of LIBRARY_MODULES) if (m.anchor && m.spaces.includes(kindOf(space))) hidden.push({ id: `new:${m.id}`, title: t('home.addCopy', { name: t(m.title) }), icon: m.icon, run: () => change(addModuleItem(items, createModuleItem(m.id))) });
  hidden.push({ id: 'library', title: t('library.browse'), icon: 'plus', run: () => navigate(`${baseOf(space)}/business/library?target=home`) });
  const grid = <ModuleSurface id={layoutKey(space)} items={items} canEdit={canEdit} onChange={save} space={space} showRestore={false} />;
  const today = new Intl.DateTimeFormat(document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  return <div className="page-wrap wide" ref={wrap}>
    <div className="page-title-row">
      <div><p className="eyebrow">{today}</p><h1 className="page-h1">{sp.kind === 'me' ? `${t('home.title')} · ${ME.name}` : sp.name}</h1></div>
      {canManage(space) ? <div className="row-actions"><button type="button" className="btn ghost" disabled={!canEdit} onClick={fit}>{t('home.fit')}</button><PresetButton space={space} items={items} disabled={!canEdit} /><ModuleAddButton items={hidden} disabled={!canEdit} /></div> : <p className="dim small">{t('home.readOnly')}</p>}
    </div>
    {blocked && canManage(space) && <div className="conflict" role="status"><p className="small">{t(saved?.conflict ? 'home.layoutConflict' : 'home.layoutLoading')}</p><button type="button" className="btn sm" disabled={reloading} onClick={reload}>{t('page.conflictReload')}</button></div>}
    {grid}
  </div>;
}
