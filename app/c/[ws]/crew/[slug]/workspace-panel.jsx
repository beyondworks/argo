'use client';

// Codex식 우측 도구 작업영역 — 한 패널 안에서 파일 열기, 장기 실행 셸, 내장 브라우저를 탭으로 연다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon, Markdown, Spinner, api } from '../../../../ui';
import { useLang } from '../../../../i18n';
import {
  FILE_TREE_DEFAULT_WIDTH,
  PANEL_DEFAULT_WIDTH,
  clampWidth,
  fileTreeWidthBounds,
  panelWidthBounds,
  widthFromLeftDrag,
} from '../../../../../src/side-panel-layout.mjs';

const TOOL_STORAGE_KEY = 'argo:crew-side-panel-tools:v1';
const FILE_TREE_STORAGE_KEY = 'argo:crew-file-tree-width:v1';
const TOOL_ORDER = ['files', 'terminal', 'browser'];
const TOOL_META = {
  files: { icon: 'folder', label: 'crew.tools.files' },
  terminal: { icon: 'terminal', label: 'crew.tools.terminal' },
  browser: { icon: 'browser', label: 'crew.tools.browser' },
};

const query = (ws, params) => {
  const qs = new URLSearchParams(params);
  return `/api/companies/${encodeURIComponent(ws)}/workspace?${qs}`;
};

async function saveWorkspaceMarkdown(ws, file, editor) {
  const response = await fetch(`/api/companies/${encodeURIComponent(ws)}/workspace`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      root: file.rootId,
      path: file.path,
      content: editor.draft,
      version: editor.version,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `workspace-save-${response.status}`);
    error.code = data.error || 'workspace-save-error';
    error.status = response.status;
    throw error;
  }
  return data;
}

/** 오른쪽 영역의 왼쪽 경계용 공통 포인터 리사이저. 포인터 캡처라 패널 밖으로 나가도 드래그가 이어진다. */
function useLeftEdgeResize(value, onChange, getBounds) {
  const drag = useRef(null);

  const finish = useCallback((event) => {
    if (!drag.current || (event?.pointerId != null && drag.current.pointerId !== event.pointerId)) return;
    drag.current = null;
    document.documentElement.classList.remove('is-resizing-horizontal');
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useEffect(() => () => {
    drag.current = null;
    document.documentElement.classList.remove('is-resizing-horizontal');
  }, []);

  return {
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: value };
      document.documentElement.classList.add('is-resizing-horizontal');
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      onChange(widthFromLeftDrag(current.startWidth, current.startX, event.clientX, getBounds()));
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
  };
}

export default function WorkspacePanel({ ws, open = true, onClose, fileRequest = null, onWidthChange }) {
  const { t } = useLang();
  const [tabs, setTabs] = useState(['files']);
  const [active, setActive] = useState('files');
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const [panelBounds, setPanelBounds] = useState(() => panelWidthBounds(1920));
  const [hydrated, setHydrated] = useState(false);
  const [filesDirty, setFilesDirty] = useState(false);
  const updatePanelWidth = useCallback((next) => {
    setPanelWidth((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      onWidthChange?.(value);
      return value;
    });
  }, [onWidthChange]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(TOOL_STORAGE_KEY) || '{}');
      const nextTabs = Array.isArray(saved.tabs)
        ? saved.tabs.filter((tool, i, all) => TOOL_ORDER.includes(tool) && all.indexOf(tool) === i)
        : [];
      if (nextTabs.length) {
        setTabs(nextTabs);
        setActive(nextTabs.includes(saved.active) ? saved.active : nextTabs[0]);
      }
      const bounds = panelWidthBounds(window.innerWidth);
      setPanelBounds(bounds);
      updatePanelWidth(clampWidth(saved.panelWidth ?? PANEL_DEFAULT_WIDTH, bounds.min, bounds.max));
    } catch { /* 손상된 로컬 상태는 파일 탭 기본값으로 복구 */ }
    setHydrated(true);
  }, [updatePanelWidth]);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(TOOL_STORAGE_KEY, JSON.stringify({ tabs, active, panelWidth })); } catch { /* 부가 상태 */ }
  }, [hydrated, tabs, active, panelWidth]);

  const getPanelBounds = useCallback(
    () => panelWidthBounds(typeof window === 'undefined' ? 1920 : window.innerWidth),
    [],
  );
  const panelResize = useLeftEdgeResize(panelWidth, updatePanelWidth, getPanelBounds);
  useEffect(() => {
    if (!fileRequest?.path) return;
    setTabs((current) => current.includes('files') ? current : ['files', ...current]);
    setActive('files');
  }, [fileRequest]);
  useEffect(() => {
    const fit = () => {
      const bounds = getPanelBounds();
      setPanelBounds(bounds);
      updatePanelWidth((width) => clampWidth(width, bounds.min, bounds.max));
    };
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [getPanelBounds, updatePanelWidth]);

  const resizePanelByKey = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const bounds = getPanelBounds();
    const delta = event.key === 'ArrowLeft' ? 24 : -24;
    updatePanelWidth((width) => clampWidth(width + delta, bounds.min, bounds.max));
  };

  const openTool = (tool) => {
    setTabs((current) => current.includes(tool) ? current : [...current, tool]);
    setActive(tool);
    setLauncherOpen(false);
  };
  const closeTool = (tool) => {
    if (tool === 'files' && filesDirty && !window.confirm(t('crew.tools.files.discardConfirm'))) return;
    const index = tabs.indexOf(tool);
    const next = tabs.filter((item) => item !== tool);
    setTabs(next);
    if (active === tool) setActive(next[Math.min(index, next.length - 1)] || '');
  };

  return (
    <aside id="crew-side-panel" className="crew-tool-panel" aria-label={t('crew.tools.title')} hidden={!open}
      style={{ '--crew-tool-panel-width': `${panelWidth}px` }}>
      <div className="crew-tool-panel-resizer" role="separator" tabIndex={0}
        aria-label={t('crew.tools.resizePanel')} aria-orientation="vertical"
        aria-valuemin={panelBounds.min} aria-valuemax={panelBounds.max} aria-valuenow={panelWidth}
        onKeyDown={resizePanelByKey} {...panelResize} />
      <div className="crew-tool-tabs">
        <div className="crew-tool-tablist" role="tablist" aria-label={t('crew.tools.title')}>
          {tabs.map((tool) => {
            const meta = TOOL_META[tool];
            return (
              <span key={tool} className={`crew-tool-tab${active === tool ? ' active' : ''}`}>
                <button id={`crew-tool-tab-${tool}`} type="button" role="tab" aria-selected={active === tool}
                  aria-controls={`crew-tool-view-${tool}`} onClick={() => setActive(tool)}>
                  <Icon name={meta.icon} size={13} />{t(meta.label)}
                </button>
                <button type="button" className="crew-tool-tab-close"
                  aria-label={t('crew.tools.closeTab', { name: t(meta.label) })}
                  onClick={() => closeTool(tool)}>×</button>
              </span>
            );
          })}
        </div>
        <div className="crew-tool-actions">
          <span className="crew-tool-launcher-wrap">
            <button type="button" className="btn btn-icon sm" aria-label={t('crew.tools.open')}
              title={t('crew.tools.open')} aria-expanded={launcherOpen}
              onClick={() => setLauncherOpen((open) => !open)}>
              <Icon name="plus" size={14} />
            </button>
            {launcherOpen && (
              <div className="crew-tool-launcher" role="menu">
                <span className="microlabel">{t('crew.tools.open')}</span>
                {TOOL_ORDER.map((tool) => (
                  <button key={tool} type="button" role="menuitem" onClick={() => openTool(tool)}>
                    <Icon name={TOOL_META[tool].icon} size={15} />
                    <span><strong>{t(TOOL_META[tool].label)}</strong><small>{t(`crew.tools.${tool}.desc`)}</small></span>
                  </button>
                ))}
              </div>
            )}
          </span>
          <button type="button" className="btn btn-icon sm" onClick={onClose}
            aria-label={t('crew.panel.close')} title={t('crew.panel.close')}>
            <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>×</span>
          </button>
        </div>
      </div>

      <div className="crew-tool-body">
        {!active && <ToolLauncher onOpen={openTool} />}
        {tabs.includes('files') && (
          <section id="crew-tool-view-files" role="tabpanel" aria-labelledby="crew-tool-tab-files"
            className="crew-tool-view" hidden={active !== 'files'}>
            <FileTool ws={ws} onDirtyChange={setFilesDirty} fileRequest={fileRequest} />
          </section>
        )}
        {tabs.includes('terminal') && (
          <section id="crew-tool-view-terminal" role="tabpanel" aria-labelledby="crew-tool-tab-terminal"
            className="crew-tool-view" hidden={active !== 'terminal'}>
            <TerminalTool ws={ws} />
          </section>
        )}
        {tabs.includes('browser') && (
          <section id="crew-tool-view-browser" role="tabpanel" aria-labelledby="crew-tool-tab-browser"
            className="crew-tool-view" hidden={active !== 'browser'}>
            <BrowserTool />
          </section>
        )}
      </div>
    </aside>
  );
}

function ToolLauncher({ onOpen }) {
  const { t } = useLang();
  return (
    <div className="crew-tool-empty">
      <Icon name="panel" size={24} />
      <strong>{t('crew.tools.empty')}</strong>
      <div>
        {TOOL_ORDER.map((tool) => (
          <button key={tool} type="button" className="btn" onClick={() => onOpen(tool)}>
            <Icon name={TOOL_META[tool].icon} size={15} />{t(TOOL_META[tool].label)}
          </button>
        ))}
      </div>
    </div>
  );
}

function FileTool({ ws, onDirtyChange, fileRequest }) {
  const { t } = useLang();
  const [roots, setRoots] = useState([]);
  const [rootId, setRootId] = useState('company');
  const [entriesByDir, setEntriesByDir] = useState({});
  const [expanded, setExpanded] = useState(new Set(['']));
  const [loadingDirs, setLoadingDirs] = useState(new Set());
  const [openFiles, setOpenFiles] = useState([]);
  const [activeFileKey, setActiveFileKey] = useState('');
  const [documents, setDocuments] = useState({});
  const [editors, setEditors] = useState({});
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState(null);
  const [error, setError] = useState('');
  const [treeWidth, setTreeWidth] = useState(FILE_TREE_DEFAULT_WIDTH);
  const [treeBounds, setTreeBounds] = useState(() => fileTreeWidthBounds(PANEL_DEFAULT_WIDTH));
  const [treeHydrated, setTreeHydrated] = useState(false);
  const filesToolRef = useRef(null);
  const documentsRef = useRef({});

  const getTreeBounds = useCallback(
    () => fileTreeWidthBounds(filesToolRef.current?.getBoundingClientRect().width || PANEL_DEFAULT_WIDTH),
    [],
  );
  const treeResize = useLeftEdgeResize(treeWidth, setTreeWidth, getTreeBounds);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(`${FILE_TREE_STORAGE_KEY}:${ws}`));
      const bounds = getTreeBounds();
      setTreeBounds(bounds);
      setTreeWidth(clampWidth(saved || FILE_TREE_DEFAULT_WIDTH, bounds.min, bounds.max));
    } catch { /* 기본 폭 유지 */ }
    setTreeHydrated(true);
  }, [getTreeBounds, ws]);

  useEffect(() => {
    if (!treeHydrated) return;
    try { localStorage.setItem(`${FILE_TREE_STORAGE_KEY}:${ws}`, String(treeWidth)); } catch { /* 부가 상태 */ }
  }, [treeHydrated, treeWidth, ws]);

  useEffect(() => {
    const element = filesToolRef.current;
    if (!element) return undefined;
    const fit = () => {
      const bounds = getTreeBounds();
      setTreeBounds(bounds);
      setTreeWidth((width) => clampWidth(width, bounds.min, bounds.max));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', fit);
      return () => window.removeEventListener('resize', fit);
    }
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [getTreeBounds]);

  const resizeTreeByKey = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const bounds = getTreeBounds();
    const delta = event.key === 'ArrowLeft' ? 20 : -20;
    setTreeWidth((width) => clampWidth(width + delta, bounds.min, bounds.max));
  };

  const activeRoot = roots.find((root) => root.id === rootId);
  const activeFile = openFiles.find((file) => file.key === activeFileKey) || null;
  const activeDocument = activeFile ? documents[activeFile.key] : null;
  const activeEditor = activeFile ? editors[activeFile.key] : null;
  const activeIsMarkdown = activeDocument?.status === 'ready'
    && activeDocument.data?.kind === 'text'
    && activeDocument.data.renderer === 'markdown';
  const hasUnsavedChanges = Object.values(editors).some((editor) => editor.dirty);

  useEffect(() => { documentsRef.current = documents; }, [documents]);
  useEffect(() => { onDirtyChange?.(hasUnsavedChanges); }, [hasUnsavedChanges, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedChanges]);

  const loadDocument = useCallback(async (file, { force = false } = {}) => {
    const current = documentsRef.current[file.key];
    if (!force && (current?.status === 'loading' || current?.status === 'ready')) return;
    const loading = { status: 'loading', data: current?.data || null, error: '' };
    documentsRef.current = { ...documentsRef.current, [file.key]: loading };
    setDocuments((all) => ({ ...all, [file.key]: loading }));
    try {
      const data = await api(query(ws, { action: 'open', root: file.rootId, path: file.path }));
      const ready = { status: 'ready', data, error: '', revision: Date.now() };
      documentsRef.current = { ...documentsRef.current, [file.key]: ready };
      setDocuments((all) => ({ ...all, [file.key]: ready }));
    } catch (cause) {
      const failed = { status: 'error', data: null, error: cause.message };
      documentsRef.current = { ...documentsRef.current, [file.key]: failed };
      setDocuments((all) => ({ ...all, [file.key]: failed }));
    }
  }, [ws]);

  const openFile = useCallback((path) => {
    const file = {
      key: `${rootId}:${path}`,
      rootId,
      rootLabel: activeRoot?.label || rootId,
      rootLocation: activeRoot?.location || '',
      path,
      name: path.split('/').pop(),
    };
    setOpenFiles((current) => current.some((item) => item.key === file.key) ? current : [...current, file]);
    setActiveFileKey(file.key);
    loadDocument(file);
  }, [activeRoot, loadDocument, rootId]);

  const beginMarkdownEdit = () => {
    if (!activeFile || !activeIsMarkdown) return;
    setEditors((current) => {
      const editor = current[activeFile.key];
      if (editor) {
        return { ...current, [activeFile.key]: { ...editor, editing: true, error: '', saved: false } };
      }
      return {
        ...current,
        [activeFile.key]: {
          editing: true,
          draft: activeDocument.data.content,
          baseContent: activeDocument.data.content,
          version: activeDocument.data.version,
          dirty: false,
          saving: false,
          saved: false,
          error: '',
        },
      };
    });
  };

  const updateMarkdownDraft = (content) => {
    if (!activeFile || !activeEditor) return;
    setEditors((current) => {
      const editor = current[activeFile.key];
      if (!editor) return current;
      return {
        ...current,
        [activeFile.key]: {
          ...editor,
          draft: content,
          dirty: content !== editor.baseContent,
          saved: false,
          error: '',
        },
      };
    });
  };

  const showMarkdownPreview = () => {
    if (!activeFile || !activeEditor) return;
    setEditors((current) => ({
      ...current,
      [activeFile.key]: { ...current[activeFile.key], editing: false },
    }));
  };

  const cancelMarkdownEdit = () => {
    if (!activeFile || !activeEditor) return;
    setEditors((current) => {
      const editor = current[activeFile.key];
      return {
        ...current,
        [activeFile.key]: {
          ...editor,
          editing: false,
          draft: editor.baseContent,
          dirty: false,
          saving: false,
          saved: false,
          error: '',
        },
      };
    });
  };

  const saveMarkdown = async () => {
    if (!activeFile || !activeEditor?.dirty || activeEditor.saving) return;
    const file = activeFile;
    const editor = activeEditor;
    setEditors((current) => ({
      ...current,
      [file.key]: { ...current[file.key], saving: true, saved: false, error: '' },
    }));
    try {
      const data = await saveWorkspaceMarkdown(ws, file, editor);
      const ready = { status: 'ready', data, error: '', revision: Date.now() };
      documentsRef.current = { ...documentsRef.current, [file.key]: ready };
      setDocuments((current) => ({ ...current, [file.key]: ready }));
      setEditors((current) => ({
        ...current,
        [file.key]: {
          ...current[file.key],
          editing: false,
          draft: data.content,
          baseContent: data.content,
          version: data.version,
          dirty: false,
          saving: false,
          saved: true,
          error: '',
        },
      }));
    } catch (cause) {
      setEditors((current) => ({
        ...current,
        [file.key]: {
          ...current[file.key],
          saving: false,
          saved: false,
          error: cause.code || cause.message || 'workspace-save-error',
        },
      }));
    }
  };

  const closeFile = (key) => {
    if (editors[key]?.saving) return;
    if (editors[key]?.dirty && !window.confirm(t('crew.tools.files.discardConfirm'))) return;
    const index = openFiles.findIndex((file) => file.key === key);
    const next = openFiles.filter((file) => file.key !== key);
    setOpenFiles(next);
    setDocuments((current) => {
      const copy = { ...current };
      delete copy[key];
      documentsRef.current = copy;
      return copy;
    });
    setEditors((current) => {
      const copy = { ...current };
      delete copy[key];
      return copy;
    });
    if (activeFileKey === key) setActiveFileKey(next[Math.min(index, next.length - 1)]?.key || '');
  };

  const reloadActiveFile = () => {
    if (!activeFile) return;
    if (activeEditor?.dirty && !window.confirm(t('crew.tools.files.discardConfirm'))) return;
    setEditors((current) => {
      const copy = { ...current };
      delete copy[activeFile.key];
      return copy;
    });
    loadDocument(activeFile, { force: true });
  };

  const loadRoots = useCallback(async () => {
    try {
      const data = await api(query(ws, { action: 'roots' }));
      setRoots(data.roots || []);
      setRootId((current) => data.roots?.some((root) => root.id === current) ? current : (data.roots?.[0]?.id || 'company'));
    } catch (e) { setError(e.message); }
  }, [ws]);

  const loadDir = useCallback(async (path, { force = false } = {}) => {
    if (!force && entriesByDir[path]) return;
    setLoadingDirs((current) => new Set(current).add(path));
    try {
      const data = await api(query(ws, { action: 'list', root: rootId, path }));
      setEntriesByDir((current) => ({ ...current, [path]: data.entries || [] }));
      setError('');
    } catch (e) { setError(e.message); }
    finally {
      setLoadingDirs((current) => {
        const next = new Set(current); next.delete(path); return next;
      });
    }
  }, [entriesByDir, rootId, ws]);

  useEffect(() => { loadRoots(); }, [loadRoots]);
  useEffect(() => {
    setEntriesByDir({});
    setExpanded(new Set(['']));
    setFilter('');
    setSearch(null);
    if (rootId) {
      api(query(ws, { action: 'list', root: rootId, path: '' }))
        .then((data) => setEntriesByDir({ '': data.entries || [] }))
        .catch((e) => setError(e.message));
    }
  }, [rootId, ws]);

  // 채팅의 문서 링크가 패널을 열 때 파일 트리도 해당 문서까지 자동으로 이동한다.
  // 루트 목록과 조상 디렉터리가 준비된 뒤에만 파일을 열어 race를 피한다.
  useEffect(() => {
    if (!fileRequest?.path || !roots.some((root) => root.id === (fileRequest.root || 'company'))) return;
    const requestedRoot = fileRequest.root || 'company';
    if (rootId !== requestedRoot) { setRootId(requestedRoot); return; }
    const path = String(fileRequest.path).replace(/^\/+|\/+$/g, '');
    if (!path || path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return;
    let alive = true;
    const parts = path.split('/');
    const ancestors = ['', ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))];
    setFilter('');
    setSearch(null);
    setExpanded(new Set(ancestors));
    Promise.all(ancestors.map((dir) => loadDir(dir))).then(() => {
      if (alive) openFile(path);
    }).catch(() => {});
    return () => { alive = false; };
  }, [fileRequest, loadDir, openFile, rootId, roots]);

  useEffect(() => {
    setOpenFiles([]);
    setActiveFileKey('');
    setDocuments({});
    setEditors({});
    documentsRef.current = {};
  }, [ws]);

  useEffect(() => {
    if (!filter.trim()) { setSearch(null); return undefined; }
    let alive = true;
    const timer = setTimeout(() => {
      api(query(ws, { action: 'search', root: rootId, q: filter.trim() }))
        .then((data) => { if (alive) setSearch(data); })
        .catch((e) => { if (alive) setError(e.message); });
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [filter, rootId, ws]);

  const toggleDir = (path) => {
    const willOpen = !expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
    if (willOpen) loadDir(path);
  };

  const openSearchDirectory = async (path) => {
    const parts = path.split('/');
    const ancestors = ['', ...parts.map((_, index) => parts.slice(0, index + 1).join('/'))];
    setFilter('');
    setExpanded(new Set(ancestors));
    await Promise.all(ancestors.slice(0, -1).map((dir) => loadDir(dir)));
    await loadDir(path);
  };

  const tree = useMemo(() => {
    const renderDir = (path, depth) => (entriesByDir[path] || []).map((entry) => (
      <div key={entry.path}>
        <button type="button"
          className={`crew-file-row${activeFile?.rootId === rootId && activeFile.path === entry.path ? ' selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => entry.type === 'directory' ? toggleDir(entry.path) : openFile(entry.path)}
          title={entry.path}>
          {entry.type === 'directory' ? (
            <>
              <Icon name="chevron" size={11} className={expanded.has(entry.path) ? 'expanded' : ''} />
              <Icon name="folder" size={13} />
            </>
          ) : <><span className="crew-file-spacer" /><Icon name="doc" size={12} /></>}
          <span>{entry.name}</span>
          {entry.symlink && <small>↗</small>}
        </button>
        {entry.type === 'directory' && expanded.has(entry.path) && (
          loadingDirs.has(entry.path)
            ? <div className="crew-file-loading" style={{ paddingLeft: 28 + depth * 14 }}><Spinner size={11} /></div>
            : renderDir(entry.path, depth + 1)
        )}
      </div>
    ));
    return renderDir('', 0);
  // toggleDir is intentionally state-bound; recalculating the small visible tree keeps event closures current.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, entriesByDir, expanded, loadingDirs, openFile, rootId]);

  const rawUrl = activeFile
    ? query(ws, { action: 'raw', root: activeFile.rootId, path: activeFile.path })
    : '';
  const renderUrl = activeFile
    ? query(ws, { action: 'render', root: activeFile.rootId, path: activeFile.path })
    : '';
  const breadcrumbParts = activeFile ? (() => {
    const location = activeFile.rootLocation.replaceAll('\\', '/').split('/').filter(Boolean);
    const rootTrail = location.length ? location.slice(-2) : [activeFile.rootLabel];
    return [...rootTrail, ...activeFile.path.split('/').filter(Boolean)];
  })() : [];
  const markdownText = activeEditor?.draft ?? activeDocument?.data?.content ?? '';
  const editorError = activeEditor?.error === 'file-changed'
    ? t('crew.tools.files.changed')
    : activeEditor?.error === 'too-large'
      ? t('crew.tools.files.tooLarge')
      : activeEditor?.error
        ? t('crew.tools.files.saveFailed')
        : '';
  return (
    <div ref={filesToolRef} className="crew-files-tool" style={{ '--crew-file-tree-width': `${treeWidth}px` }}>
      <div className="crew-files-sidebar">
        <div className="crew-files-toolbar">
          <select value={rootId} onChange={(e) => setRootId(e.target.value)} aria-label={t('crew.tools.files.root')}>
            {roots.map((root) => <option key={root.id} value={root.id}>{root.label}</option>)}
          </select>
          <button type="button" className="btn btn-icon sm" aria-label={t('crew.tools.refresh')}
            onClick={() => { loadRoots(); loadDir('', { force: true }); }}>
            <Icon name="reload" size={13} />
          </button>
        </div>
        {activeRoot && <div className="crew-files-location mono" title={activeRoot.location}>{activeRoot.location}</div>}
        <label className="crew-file-filter">
          <Icon name="search" size={12} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder={t('crew.tools.files.filter')} />
          {filter && <button type="button" onClick={() => setFilter('')} aria-label={t('common.clear')}>×</button>}
        </label>
        <div className="crew-file-tree">
          {filter.trim() ? (
            search === null ? <div className="crew-tool-loading"><Spinner size={12} />{t('crew.tools.files.searching')}</div>
              : search.entries?.length ? search.entries.map((entry) => (
                <button key={entry.path} type="button" className="crew-file-search-row"
                  onClick={() => entry.type === 'directory' ? openSearchDirectory(entry.path) : openFile(entry.path)}>
                  <Icon name={entry.type === 'directory' ? 'folder' : 'doc'} size={12} />
                  <span><strong>{entry.name}</strong><small>{entry.path}</small></span>
                </button>
              )) : <div className="crew-tool-message">{t('crew.tools.files.noMatch')}</div>
          ) : tree}
        </div>
        {roots.length === 1 && (
          <Link className="crew-files-connect" href={`/c/${ws}/settings#workroots`}>
            <Icon name="plus" size={12} />{t('crew.tools.files.connect')}
          </Link>
        )}
      </div>
      <div className="crew-file-splitter" role="separator" tabIndex={0}
        aria-label={t('crew.tools.files.resize')} aria-orientation="vertical"
        aria-valuemin={treeBounds.min} aria-valuemax={treeBounds.max} aria-valuenow={treeWidth}
        onKeyDown={resizeTreeByKey} {...treeResize} />
      <div className="crew-file-document">
        {!activeFile && <div className="crew-tool-empty compact"><Icon name="doc" size={22} /><span>{t('crew.tools.files.pick')}</span></div>}
        {activeFile && (
          <>
            <div className="crew-file-open-tabs" role="tablist" aria-label={t('crew.tools.files.openFiles')}>
              {openFiles.map((file) => (
                <span key={file.key} className={`crew-file-open-tab${file.key === activeFileKey ? ' active' : ''}`}>
                  <button type="button" role="tab" aria-selected={file.key === activeFileKey}
                    title={`${file.rootLabel}/${file.path}`} onClick={() => setActiveFileKey(file.key)}>
                    <Icon name="doc" size={11} /><span>{file.name}</span>
                    {editors[file.key]?.dirty && (
                      <i className="crew-file-dirty" aria-label={t('crew.tools.files.unsaved')} />
                    )}
                  </button>
                  <button type="button" className="crew-file-open-close"
                    aria-label={t('crew.tools.files.closeFile', { name: file.name })}
                    disabled={editors[file.key]?.saving}
                    onClick={() => closeFile(file.key)}>×</button>
                </span>
              ))}
            </div>
            <div className="crew-file-document-head">
              <nav className="crew-file-breadcrumb" aria-label={t('crew.tools.files.location')}>
                {breadcrumbParts.map((part, index) => (
                  <span key={`${part}:${index}`} title={part}>
                    {index > 0 && <i aria-hidden="true">›</i>}<strong>{part}</strong>
                  </span>
                ))}
              </nav>
              {activeIsMarkdown && (
                <div className="crew-file-editor-actions">
                  {activeEditor?.editing ? (
                    <button type="button" className="btn sm" onClick={showMarkdownPreview}>
                      {t('crew.tools.files.preview')}
                    </button>
                  ) : (
                    <button type="button" className="btn sm" onClick={beginMarkdownEdit}>
                      <Icon name="edit" size={12} />{t('common.edit')}
                    </button>
                  )}
                  {activeEditor && (
                    <>
                      {activeEditor.dirty && (
                        <button type="button" className="btn sm" onClick={cancelMarkdownEdit}
                          disabled={activeEditor.saving}>
                          {t('common.cancel')}
                        </button>
                      )}
                      <button type="button" className="btn btn-primary sm" onClick={saveMarkdown}
                        disabled={!activeEditor.dirty || activeEditor.saving}
                        aria-keyshortcuts="Control+S Meta+S">
                        {activeEditor.saving
                          ? <><Spinner size={11} />{t('crew.tools.files.saving')}</>
                          : t('common.save')}
                      </button>
                    </>
                  )}
                  <span id="crew-file-editor-state" className={`crew-file-editor-state${editorError ? ' error' : ''}`}
                    role={editorError ? 'alert' : 'status'}>
                    {editorError || (activeEditor?.saved
                      ? t('common.saved')
                      : activeEditor?.dirty ? t('crew.tools.files.unsaved') : '')}
                  </span>
                </div>
              )}
              <button type="button" className="btn btn-icon sm"
                aria-label={t('crew.tools.files.reload')} title={t('crew.tools.files.reload')}
                onClick={reloadActiveFile}>
                <Icon name="reload" size={13} />
              </button>
              <a className="btn btn-icon sm" href={rawUrl} download={activeFile.name}
                aria-label={t('crew.tools.files.download')} title={t('crew.tools.files.download')}>
                <Icon name="download" size={13} />
              </a>
            </div>
            <div className="crew-file-document-body" role="tabpanel">
              {activeDocument?.status === 'loading' && <div className="crew-tool-loading"><Spinner />{t('common.loading')}</div>}
              {activeDocument?.status === 'error' && <div className="crew-tool-error">{activeDocument.error}</div>}
              {activeDocument?.status === 'ready' && activeDocument.data?.kind === 'text'
                && activeDocument.data.renderer === 'markdown' && activeEditor?.editing && (
                <textarea className="crew-file-markdown-editor" value={activeEditor.draft}
                  onChange={(event) => updateMarkdownDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                      event.preventDefault();
                      saveMarkdown();
                    }
                  }}
                  disabled={activeEditor.saving} autoFocus spellCheck
                  aria-label={t('crew.tools.files.editor')}
                  aria-describedby="crew-file-editor-state" />
              )}
              {activeDocument?.status === 'ready' && activeDocument.data?.kind === 'text'
                && activeDocument.data.renderer === 'markdown' && !activeEditor?.editing && (
                <article className="crew-file-markdown"><Markdown text={markdownText} /></article>
              )}
              {activeDocument?.status === 'ready' && activeDocument.data?.kind === 'text'
                && activeDocument.data.renderer === 'html' && (
                <iframe key={`${activeFile.key}:${activeDocument.revision}`} className="crew-file-html"
                  srcDoc={activeDocument.data.content} sandbox="allow-scripts" referrerPolicy="no-referrer"
                  title={activeDocument.data.name} />
              )}
              {activeDocument?.status === 'ready' && activeDocument.data?.kind === 'text'
                && activeDocument.data.renderer === 'source' && (
                <pre className="crew-file-source"><code>{activeDocument.data.content}</code></pre>
              )}
              {activeDocument?.status === 'ready' && activeDocument.data?.kind === 'image' && (
                <img src={rawUrl} alt={activeDocument.data.name} />
              )}
              {activeDocument?.status === 'ready' && activeDocument.data?.kind === 'pdf' && (
                <iframe src={rawUrl} title={activeDocument.data.name} />
              )}
              {activeDocument?.status === 'ready' && activeDocument.data?.kind === 'office' && (
                <iframe src={renderUrl} title={activeDocument.data.name} />
              )}
              {activeDocument?.status === 'ready' && ['binary', 'large'].includes(activeDocument.data?.kind) && (
                <div className="crew-tool-empty compact">
                  <Icon name="doc" size={24} />
                  <span>{activeDocument.data.kind === 'large' ? t('crew.tools.files.tooLarge') : t('crew.tools.files.binary')}</span>
                  <a className="btn" href={rawUrl} download={activeFile.name}>{t('crew.tools.files.download')}</a>
                </div>
              )}
            </div>
          </>
        )}
        {error && <div className="crew-tool-error">{error}</div>}
      </div>
    </div>
  );
}

function TerminalTool({ ws }) {
  const { t } = useLang();
  const [roots, setRoots] = useState([]);
  const [rootId, setRootId] = useState('company');
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  const [output, setOutput] = useState('');
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [exited, setExited] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const outputRef = useRef(null);
  const startGeneration = useRef(0);

  useEffect(() => {
    api(query(ws, { action: 'roots' }))
      .then((data) => setRoots(data.roots || []))
      .catch((e) => setError(e.message));
  }, [ws]);

  const closeSession = useCallback((id = sessionRef.current?.id) => {
    if (!id) return;
    fetch(`/api/companies/${encodeURIComponent(ws)}/terminal`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'close', id }), keepalive: true,
    }).catch(() => {});
    if (sessionRef.current?.id === id) sessionRef.current = null;
  }, [ws]);

  const start = useCallback(async () => {
    const generation = startGeneration.current + 1;
    startGeneration.current = generation;
    closeSession();
    sessionRef.current = null;
    setSession(null);
    setStarting(true);
    setOutput('');
    setCursor(0);
    cursorRef.current = 0;
    setExited(false);
    setError('');
    try {
      const next = await api(`/api/companies/${encodeURIComponent(ws)}/terminal`, { action: 'start', root: rootId });
      if (generation !== startGeneration.current) {
        closeSession(next.id);
        return;
      }
      sessionRef.current = next;
      setSession(next);
    } catch (e) {
      setSession(null);
      setError(e.message === 'terminal-shell-disabled' ? t('crew.tools.terminal.disabled') : e.message);
    } finally { setStarting(false); }
  }, [closeSession, rootId, t, ws]);

  useEffect(() => {
    if (roots.length) start();
    return () => {
      startGeneration.current += 1;
      closeSession();
    };
  }, [rootId, roots.length, start, closeSession]);

  useEffect(() => {
    if (!session?.id) return undefined;
    let alive = true;
    let busy = false;
    const poll = async () => {
      if (!alive || busy) return;
      busy = true;
      try {
        const url = `/api/companies/${encodeURIComponent(ws)}/terminal?id=${encodeURIComponent(session.id)}&cursor=${cursorRef.current}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (data.truncated) setOutput('');
        if (data.output) setOutput((current) => current + data.output);
        cursorRef.current = data.cursor;
        setCursor(data.cursor);
        setExited(!!data.exited);
      } catch (e) {
        if (alive && e.message !== 'terminal-not-found') setError(e.message);
      } finally { busy = false; }
    };
    poll();
    const timer = setInterval(poll, 500);
    return () => { alive = false; clearInterval(timer); };
  }, [session, ws]);

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output, cursor]);

  const submit = async (e) => {
    e.preventDefault();
    const value = command.trim();
    if (!value || !session?.id || exited) return;
    setCommand('');
    setHistory((current) => [...current.filter((item) => item !== value), value].slice(-50));
    setHistoryIndex(-1);
    if (value === 'clear') { setOutput(''); return; }
    try {
      await api(`/api/companies/${encodeURIComponent(ws)}/terminal`, { action: 'input', id: session.id, input: command });
    } catch (err) { setError(err.message); }
  };

  const interrupt = async () => {
    if (!session?.id) return;
    try { await api(`/api/companies/${encodeURIComponent(ws)}/terminal`, { action: 'interrupt', id: session.id }); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className="crew-terminal-tool">
      <div className="crew-terminal-toolbar">
        <select value={rootId} onChange={(e) => setRootId(e.target.value)} aria-label={t('crew.tools.terminal.cwd')}>
          {roots.map((root) => <option key={root.id} value={root.id}>{root.label}</option>)}
        </select>
        <span className="mono" title={session?.cwd}>{session?.cwd || t('crew.tools.terminal.starting')}</span>
        <button type="button" className="btn sm" onClick={interrupt} disabled={!session || exited}>Ctrl+C</button>
        <button type="button" className="btn btn-icon sm" onClick={start}
          aria-label={t('crew.tools.terminal.restart')} title={t('crew.tools.terminal.restart')}>
          <Icon name="reload" size={12} />
        </button>
      </div>
      <pre ref={outputRef} className="crew-terminal-output"
        aria-label={t('crew.tools.terminal.output')}>{output || (starting ? t('crew.tools.terminal.starting') : '')}</pre>
      <form className="crew-terminal-input" onSubmit={submit}>
        <span className="mono">$</span>
        <input autoComplete="off" spellCheck={false} value={command} onChange={(e) => setCommand(e.target.value)}
          disabled={!session || exited}
          placeholder={exited ? t('crew.tools.terminal.exited') : t('crew.tools.terminal.placeholder')}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            if (!history.length) return;
            const next = e.key === 'ArrowUp'
              ? Math.min(history.length - 1, historyIndex + 1)
              : Math.max(-1, historyIndex - 1);
            setHistoryIndex(next);
            setCommand(next < 0 ? '' : history[history.length - 1 - next]);
          }} />
        <button className="btn sm" disabled={!session || exited || !command.trim()}>{t('crew.tools.terminal.run')}</button>
      </form>
      <p className="crew-terminal-note">{t('crew.tools.terminal.note')}</p>
      {error && (
        <div className="crew-tool-error">
          {error} {error === t('crew.tools.terminal.disabled') && <Link href={`/c/${ws}/settings`}>{t('crew.tools.settings')}</Link>}
        </div>
      )}
    </div>
  );
}

export function normalizeBrowserUrl(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) return `http://${value}`;
  if (/^[^\s]+\.[^\s]+(?:\/.*)?$/.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function BrowserTool() {
  const { t } = useLang();
  const [address, setAddress] = useState('');
  const [history, setHistory] = useState([]);
  const [index, setIndex] = useState(-1);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const current = history[index] || 'about:blank';

  useEffect(() => {
    let initial = '';
    try { initial = localStorage.getItem('argo:tool-browser-url') || ''; } catch { /* 부가 상태 */ }
    initial = normalizeBrowserUrl(initial || window.location.origin);
    setAddress(initial);
    setHistory([initial]);
    setIndex(0);
  }, []);

  const navigate = (input) => {
    const next = normalizeBrowserUrl(input);
    if (!next) return;
    setHistory((currentHistory) => [...currentHistory.slice(0, index + 1), next]);
    setIndex((currentIndex) => currentIndex + 1);
    setAddress(next);
    setLoading(true);
    try { localStorage.setItem('argo:tool-browser-url', next); } catch { /* 부가 상태 */ }
  };

  const move = (nextIndex) => {
    if (nextIndex < 0 || nextIndex >= history.length) return;
    setIndex(nextIndex);
    setAddress(history[nextIndex]);
    setLoading(true);
  };

  const openExternal = async () => {
    if (!/^https?:/i.test(current)) return;
    try {
      if ('__TAURI_INTERNALS__' in window) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(current);
        return;
      }
    } catch { /* 브라우저 새 창 폴백 */ }
    window.open(current, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="crew-browser-tool">
      <div className="crew-browser-toolbar">
        <button type="button" className="btn btn-icon sm" disabled={index <= 0}
          aria-label={t('crew.tools.browser.back')} onClick={() => move(index - 1)}>
          <Icon name="back" size={13} />
        </button>
        <button type="button" className="btn btn-icon sm" disabled={index < 0 || index >= history.length - 1}
          aria-label={t('crew.tools.browser.forward')} onClick={() => move(index + 1)}>
          <Icon name="arrow" size={13} />
        </button>
        <button type="button" className="btn btn-icon sm" aria-label={t('crew.tools.refresh')}
          onClick={() => { setReloadKey((key) => key + 1); setLoading(true); }}>
          <Icon name="reload" size={13} />
        </button>
        <form onSubmit={(e) => { e.preventDefault(); navigate(address); }}>
          <Icon name="browser" size={12} />
          <input value={address} onChange={(e) => setAddress(e.target.value)}
            aria-label={t('crew.tools.browser.address')} placeholder={t('crew.tools.browser.placeholder')} />
        </form>
        <button type="button" className="btn btn-icon sm" onClick={openExternal}
          aria-label={t('crew.tools.browser.external')} title={t('crew.tools.browser.external')}>
          <Icon name="external" size={13} />
        </button>
      </div>
      <div className="crew-browser-viewport">
        {loading && <div className="crew-browser-loading"><Spinner /></div>}
        <iframe key={`${current}:${reloadKey}`} src={current}
          title={t('crew.tools.browser.frame')} onLoad={() => setLoading(false)}
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts" />
      </div>
      <p className="crew-browser-note">{t('crew.tools.browser.note')}</p>
    </div>
  );
}
