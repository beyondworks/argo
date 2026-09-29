import { useEffect, useId, useState } from 'react';
import { Node, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import ModuleSurface from './ModuleSurface.jsx';
import { normalizeModuleItems } from '../core/module-items.js';

function PageModuleView({ node, editor, extension, updateAttributes }) {
  const { space, sourceOwner } = extension.options;
  const id = useId();
  const [editable, setEditable] = useState(editor.isEditable);
  useEffect(() => {
    const update = () => setEditable(editor.isEditable);
    editor.on('update', update);
    update();
    return () => editor.off('update', update);
  }, [editor]);
  return <NodeViewWrapper className="page-module-node" contentEditable={false}>
    <ModuleSurface id={`page-module:${id}`} space={space} sourceOwner={sourceOwner} items={node.attrs.items} canEdit={editable}
      onChange={(items) => { if (!editor.isEditable || editor.isDestroyed) return false; updateAttributes({ items }); return true; }} />
  </NodeViewWrapper>;
}

export const PageModuleNode = Node.create({
  name: 'moduleGrid', group: 'block', atom: true, selectable: true,
  addOptions: () => ({ space: null, sourceOwner: null }),
  addAttributes: () => ({ items: {
    default: [],
    parseHTML: (element) => {
      try { return normalizeModuleItems(JSON.parse(element.getAttribute('data-module-items') ?? '[]')); }
      catch { return []; }
    },
    renderHTML: ({ items }) => ({ 'data-module-items': JSON.stringify(items) }),
  } }),
  parseHTML: () => [{ tag: 'div[data-module-grid]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { ...HTMLAttributes, 'data-module-grid': '' }],
  addNodeView() { return ReactNodeViewRenderer(PageModuleView); },
});
