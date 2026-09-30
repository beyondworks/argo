import { reorderModules } from './layout.js';

/** 포인터가 대상 모듈의 앞쪽 절반이면 'before', 뒤쪽이면 'after' — 가로로 꽉 찬 모듈은 위·아래, 나머지는 왼쪽·오른쪽 */
export function sideOf(rect, point, size) {
  return size === 'full'
    ? (point.y < rect.top + rect.height / 2 ? 'before' : 'after')
    : (point.x < rect.left + rect.width / 2 ? 'before' : 'after');
}

export function moduleDrag(state, action) {
  const unchanged = () => ({ drag: state, commit: null });
  const valid = state && state.scope === action.scope && state.source === action.source && action.canEdit;
  if (action.type === 'start') {
    if (!action.canEdit || action.active?.kind !== 'module' || action.active.group !== action.scope) return unchanged();
    return { drag: { scope: action.scope, source: action.source, original: action.items, items: action.items, active: action.active }, commit: null };
  }
  if (action.type === 'cancel' || !valid) return { drag: null, commit: null };
  const over = action.over;
  const target = over?.kind === 'module' && over.group === state.scope && state.items.some((item) => !item.hidden && item.id === over.id);
  if (action.type === 'end') {
    const changed = state.items.some((item, index) => item.id !== state.original[index]?.id);
    return { drag: null, commit: target && changed ? state.items : null };
  }
  if (action.type !== 'over' || !target || over.id === state.active.id) return unchanged();
  const items = reorderModules(state.items, state.scope, state.active, over);
  return items === state.items ? unchanged() : { drag: { ...state, items }, commit: null };
}
