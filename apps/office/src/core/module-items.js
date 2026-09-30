import { LIBRARY_MODULES } from './module-registry.js';

export function normalizeModuleItems(value) {
  if (!Array.isArray(value)) return [];
  const reserved = new Set(value.map((item) => item?.id).filter((id) => typeof id === 'string' && id));
  const seen = new Set();
  return value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item, index) => {
    const validId = typeof item.id === 'string' && item.id.length > 0;
    let id = validId ? item.id : `module-${index}`;
    if (seen.has(id) || (!validId && reserved.has(id))) {
      let suffix = index;
      while (reserved.has(`${id}-copy-${suffix}`) || seen.has(`${id}-copy-${suffix}`)) suffix++;
      id = `${id}-copy-${suffix}`;
    }
    seen.add(id);
    const moduleId = item.moduleId ?? item.id;
    const definition = LIBRARY_MODULES.find((module) => module.id === moduleId);
    const sizes = definition?.sizes ?? ['s', 'm', 'l', 'full'];
    return { ...item, id, moduleId, size: sizes.includes(item.size) ? item.size : definition?.defaultSize ?? 'm', hidden: item.hidden === true };
  });
}

export const moduleAllowedInSpace = (definition, space) => !!space && space !== 'shared' && !!definition?.spaces.includes(space === 'me' ? 'me' : 'org');
