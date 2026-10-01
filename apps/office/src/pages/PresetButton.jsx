// 홈 제목 줄의 '저장본' 버튼(유건 10/1 6차 확정 1) — 메뉴·창·규칙은 누를 때 받는다(Presets.jsx, 첫 화면 JS 150KB 상한)
import { lazy, Suspense, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { t } from '../core/i18n.js';

const Presets = lazy(() => import('./Presets.jsx'));
export function PresetButton({ disabled, ...rest }) {
  const [open, setOpen] = useState(null);
  return <><button type="button" className="btn" disabled={disabled} aria-haspopup="menu" onClick={(e) => setOpen({ at: e.currentTarget })}><Icon name="layout" size={14} />{t('home.presets')}</button>
    {open && <Suspense fallback={null}><Presets {...rest} open={open} /></Suspense>}</>;
}
