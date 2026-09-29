import { getState, saveLayout, createPage, savePage } from './store.js';
import { ME, SPACES, canManage } from './session.js';
import { loadPageContent } from './pull.js';
import { mergeLayout } from './layout.js';
import { LIBRARY_MODULES } from './module-registry.js';
import { addModuleItem, appendPageModule, canEditModulePage, createModuleItem } from './module-placement-model.js';
import { DEFAULTS } from '../pages/modules.jsx';
import { baseOf } from './commands.js';

export async function placeModule({ space, moduleId, cfg, target }) {
  const uid = ME.id;
  const kind = space === 'me' ? 'me' : 'org';
  const module = LIBRARY_MODULES.find((entry) => entry.id === moduleId && entry.spaces.includes(kind));
  if (!module || !SPACES.some((entry) => entry.key === space)) throw new Error('library.permission');
  const item = createModuleItem(moduleId, cfg);
  if (target.kind === 'home') {
    if (!canManage(space)) throw new Error('library.permission');
    const key = `home:${space}`;
    const items = mergeLayout(getState().layouts[key], LIBRARY_MODULES, kind, DEFAULTS[kind]);
    if (saveLayout(key, addModuleItem(items, item)) === false) throw new Error('home.layoutBlocked');
    return baseOf(space);
  }
  if (target.kind === 'new') {
    if (!canManage(space)) throw new Error('library.permission');
    const title = target.title?.trim();
    if (!title) throw new Error('library.titleRequired');
    const content = appendPageModule({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] }] }, item);
    const id = createPage(space, null, { title, content });
    return `${baseOf(space)}/p/${id}`;
  }
  if (target.kind !== 'page') throw new Error('library.invalid');
  let page = getState().pages.find((entry) => entry.id === target.pageId);
  if (!canEditModulePage(page, space)) throw new Error('library.permission');
  if (page.content === undefined) await loadPageContent(page.id);
  if (ME.id !== uid) throw new Error('library.permission');
  page = getState().pages.find((entry) => entry.id === target.pageId);
  if (!canEditModulePage(page, space)) throw new Error('library.permission');
  savePage(page.id, { content: appendPageModule(page.content, item), loadedAt: Date.now() });
  return `${baseOf(space)}/p/${page.id}`;
}
