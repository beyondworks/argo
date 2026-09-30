import { reorderModules } from './layout.js';

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
  return { drag: { ...state, items }, commit: null };
}
