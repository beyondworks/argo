import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

export function moduleKeyboardCoordinates(event, args) {
  const { active, collisionRect, droppableContainers, droppableRects } = args.context;
  const data = active?.data.current;
  if (data?.kind !== 'module') return sortableKeyboardCoordinates(event, args);
  if (data.keyboardTarget) data.keyboardTarget.current = null;
  const direction = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.code];
  if (!direction || !collisionRect) return undefined;
  event.preventDefault();
  const slot = droppableRects.get(active.id) ?? collisionRect;
  const origin = center(slot), overlay = center(collisionRect);
  const [dx, dy] = direction;
  const candidates = droppableContainers.getEnabled().flatMap((entry) => {
    const target = entry.data.current, rect = droppableRects.get(entry.id);
    if (!rect || entry.id === active.id || target?.kind !== 'module' || target.group !== data.group) return [];
    if (dx && (rect.top >= slot.top + slot.height || rect.top + rect.height <= slot.top)) return [];
    const point = center(rect), along = (point.x - origin.x) * dx + (point.y - origin.y) * dy;
    if (along <= 1) return [];
    const across = Math.abs((point.x - origin.x) * dy + (point.y - origin.y) * dx);
    return [{ point, along, across, data: target }];
  });
  candidates.sort((a, b) => a.along - b.along || a.across - b.across);
  const candidate = candidates[0], target = candidate?.point;
  // DragMove may still carry the previous collision after the grid reflows.
  if (candidate && data.keyboardTarget) data.keyboardTarget.current = { kind: 'module', group: candidate.data.group, id: candidate.data.id };
  return target ? { x: args.currentCoordinates.x + target.x - overlay.x, y: args.currentCoordinates.y + target.y - overlay.y } : undefined;
}
