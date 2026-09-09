'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, Spinner } from '../ui';
import { useLang } from '../i18n';

const row = { display: 'flex', gap: 10, alignItems: 'flex-start' };
const field = { padding: '8px 10px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--fg)', minWidth: 0, maxWidth: '100%' };
const emptyConsent = () => ({ tools: false, memory: false, secrets: false });
function restoredNames(items = []) {
  return Object.fromEntries(items.filter((item) => ['failed', 'planned', 'staged'].includes(item.status)).map((item) => [item.id, item.name]));
}
function bulkSelectable(item) {
  return item.kind !== 'memory' && item.compatibility === 'available' && !item.conflict && (!item.status || ['failed', 'planned', 'staged'].includes(item.status));
}
const errorKey = (error) => /^localImport\.error\.[a-z-]+$/.test(error?.data?.uiKey || '') ? error.data.uiKey : 'localImport.error.internal';
function translated(t, key, fallback = 'localImport.reason.other') {
  const value = t(key);
  return value === key ? t(fallback) : value;
}

// The server performs the local gate before reading any source. No client-side host guess grants access.
export function LocalAssetOffer({ selected, onChange, disabled }) {
  const { t } = useLang();
  const [discovery, setDiscovery] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api('/api/local-assets').then((data) => { if (alive) setDiscovery(data); }).catch((e) => { if (alive) setError(errorKey(e)); });
    return () => { alive = false; };
  }, []);
  if (discovery && ['deferred', 'completed'].includes(discovery.phase)) return null;
  const available = discovery?.available === true;
  return <section className="card" style={{ padding: 16, marginBottom: 16 }}>
    <h2 className="card-title">{t('localImport.title')}</h2>
    <p style={{ color: 'var(--fg-2)', margin: '8px 0', fontSize: 13 }}>{t('localImport.offer')}</p>
    {!discovery && !error ? <span role="status"><Spinner size={12} /> {t('localImport.loading')}</span> : available ? <>
      <p style={{ fontSize: 12, color: 'var(--fg-2)' }}>{t('localImport.discovered', { n: discovery.count ?? 0 })}</p>
      <label style={row}><input type="checkbox" checked={selected} onChange={(e) => onChange(e.target.checked)} disabled={disabled} /><span>{t('localImport.optIn')}</span></label>
      <p style={{ color: 'var(--fg-3)', fontSize: 12, marginTop: 8 }}>{t('localImport.optional')}</p>
    </> : <p role="status" style={{ fontSize: 13 }}>{translated(t, error || 'localImport.error.unavailable', 'localImport.error.internal')}</p>}
  </section>;
}

export default function LocalAssetImport({ ws, continuation }) {
  const { t } = useLang();
  const [identity, setIdentity] = useState(null);
  const [checking, setChecking] = useState(true);
  const identityRequest = useRef(0);
  useEffect(() => {
    let alive = true;
    const check = () => {
      const current = ++identityRequest.current;
      setChecking(true);
      api('/api/me').then((me) => { if (alive && current === identityRequest.current) setIdentity(`${me.authOn ? 'auth' : 'local'}:${me.user?.id ?? 'none'}`); }).catch(() => { if (alive && current === identityRequest.current) setIdentity('unavailable'); })
        .finally(() => { if (alive && current === identityRequest.current) setChecking(false); });
    };
    check();
    window.addEventListener('focus', check);
    return () => { alive = false; identityRequest.current++; window.removeEventListener('focus', check); };
  }, [ws]);
  if (!identity) return <div className="card" style={{ padding: 18 }} role="status"><Spinner size={14} /> {t('localImport.loading')}</div>;
  if (identity === 'unavailable') return <p role="alert">{t('localImport.error.auth')}</p>;
  return <>
    {checking && <p role="status"><Spinner size={14} /> {t('localImport.loading')}</p>}
    <div hidden={checking}><ImportReview key={`${ws}:${identity}`} ws={ws} continuation={continuation} /></div>
  </>;
}

function ImportReview({ ws, continuation }) {
  const { t } = useLang();
  const [data, setData] = useState(null);
  const [company, setCompany] = useState(null);
  const [selected, setSelected] = useState([]);
  const [roots, setRoots] = useState([]);
  const [renames, setRenames] = useState({});
  const [consents, setConsents] = useState(emptyConsent);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const endpoint = `/api/companies/${encodeURIComponent(ws)}/local-assets`;
  useEffect(() => {
    const request = ++generation.current;
    Promise.all([api(endpoint), api(`/api/companies/${encodeURIComponent(ws)}`)])
      .then(([status, details]) => { if (request === generation.current) { setData(status); setCompany(status.company ?? details.company); setRenames(restoredNames(status.items)); } })
      .catch((e) => { if (request === generation.current) setError(errorKey(e)); })
      .finally(() => { if (request === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [endpoint, ws]);

  async function request(action, options = {}) {
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await api(endpoint, { action, ...options });
      if (current !== generation.current) return;
      setData(result); if (result.company) setCompany(result.company); setSelected([]); setConsents(emptyConsent());
      setRenames(action === 'preview' ? {} : restoredNames(result.items));
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) {
      if (current === generation.current) {
        setError(errorKey(e));
        if (['localImport.error.auth', 'localImport.error.forbidden', 'localImport.error.unavailable'].includes(errorKey(e))) {
          setData(null); setCompany(null); setSelected([]); setConsents(emptyConsent());
        }
      }
    } finally { if (current === generation.current) setBusy(false); }
  }
  async function defer() {
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      await api('/api/local-assets', { action: 'defer' });
      if (current === generation.current) window.location.assign(continuation);
    } catch (e) { if (current === generation.current) { setError(errorKey(e)); setBusy(false); } }
  }

  const items = data?.items ?? [];
  const groups = items.reduce((map, item) => {
    const key = `${item.source}:${item.groupId}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item); return map;
  }, new Map());
  const bulkIds = items.filter(bulkSelectable).map((item) => item.id);
  const allBulkSelected = bulkIds.length > 0 && bulkIds.every((id) => selected.includes(id));
  const chosen = items.filter((item) => selected.includes(item.id));
  const needsTools = chosen.some((item) => ['skill', 'mcp'].includes(item.kind));
  const needsMemory = chosen.some((item) => ['memory', 'rule'].includes(item.kind));
  const needsSecrets = chosen.some((item) => item.hasSecret);
  const hasResults = items.some((item) => item.status);
  const canImport = chosen.length > 0 && (!needsTools || consents.tools) && (!needsMemory || consents.memory) && (!needsSecrets || consents.secrets)
    && chosen.every((item) => !item.conflict || renames[item.id]?.trim());
  const denied = ['localImport.error.auth', 'localImport.error.forbidden', 'localImport.error.unavailable', 'localImport.error.origin'].includes(error);
  const toggle = (id, checked, setter) => setter((old) => checked ? [...old, id] : old.filter((value) => value !== id));

  return <section className="card" style={{ padding: 18, width: '100%', minWidth: 0, display: 'grid', gap: 14 }} aria-busy={busy}>
    <div><h2 className="card-title">{t('localImport.title')}</h2>
      <p style={{ color: 'var(--fg-2)', marginTop: 6, fontSize: 13 }}>{t('localImport.description')}</p>
    </div>
    <p style={{ overflowWrap: 'anywhere', fontWeight: 650 }}>{t('localImport.company', { name: company?.name ?? ws })}</p>
    {busy && <p role="status"><Spinner size={14} /> {t('localImport.loading')}</p>}
    {error && <p role="alert" style={{ color: 'var(--danger)' }}>{translated(t, error, 'localImport.error.internal')}</p>}
    {data && <>
      <p role="status" style={{ fontSize: 13 }}>{translated(t, `localImport.phase.${data.phase}`, 'localImport.phase.idle')}</p>
      {(data.issues ?? []).map((issue, i) => <p key={i} style={{ color: 'var(--warn)', fontSize: 13 }}>{translated(t, `localImport.source.${issue.source}`)}: {translated(t, `localImport.reason.${issue.reason}`)}</p>)}
      {(data.roots ?? []).length > 0 && <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }} disabled={busy}>
        <legend>{t('localImport.roots')}</legend>
        <p style={{ color: 'var(--fg-2)', fontSize: 12 }}>{t('localImport.rootsHelp')}</p>
        {data.roots.map((root) => <label key={root.id} style={{ ...row, marginTop: 8, overflowWrap: 'anywhere' }}><input type="checkbox" checked={roots.includes(root.id)} onChange={(e) => toggle(root.id, e.target.checked, setRoots)} /><span>{root.label}</span></label>)}
      </fieldset>}
      {!items.length && data.scanId && <p>{t('localImport.empty')}</p>}
      {bulkIds.length > 0 && <label style={row}><input type="checkbox" disabled={busy} checked={allBulkSelected} onChange={(e) => setSelected((old) => e.target.checked ? [...new Set([...old, ...bulkIds])] : old.filter((id) => !bulkIds.includes(id)))} /><span>{t('localImport.selectAll')}</span></label>}
      {Array.from(groups, ([key, grouped]) => <fieldset key={key} disabled={busy} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, minWidth: 0 }}>
        <legend style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}>{translated(t, `localImport.source.${grouped[0].source}`)} · {grouped[0].groupLabel}</legend>
        {grouped.map((item) => {
          const finished = item.status && !['failed', 'planned', 'staged'].includes(item.status);
          return <div key={item.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-soft)', overflowWrap: 'anywhere' }}>
            <label style={row}><input type="checkbox" checked={selected.includes(item.id)} disabled={!!finished || (item.conflict && renames[item.id] === undefined)} onChange={(e) => toggle(item.id, e.target.checked, setSelected)} />
              <span style={{ flex: 1, minWidth: 0 }}><strong>{item.label}</strong><span style={{ display: 'block', color: 'var(--fg-2)', fontSize: 12 }}>{translated(t, `localImport.kind.${item.kind}`)} · {t('localImport.size', { n: item.files ?? 0, kb: Math.ceil((item.bytes ?? 0) / 1024) })}</span></span>
            </label>
            <p style={{ fontSize: 12, margin: '6px 0 0 24px', color: 'var(--fg-2)' }}>{translated(t, `localImport.${item.status ? 'status' : 'compatibility'}.${item.status || item.compatibility}`)}</p>
            {item.reason && <p style={{ fontSize: 12, marginLeft: 24, color: 'var(--warn)' }}>{translated(t, `localImport.reason.${item.reason}`)}</p>}
            {['memory', 'rule'].includes(item.kind) && <p style={{ fontSize: 12, marginLeft: 24 }}>{t('localImport.memoryScope')}</p>}
            {item.hasSecret && <p style={{ fontSize: 12, marginLeft: 24, color: 'var(--warn)' }}>{t('localImport.secretFlag')}</p>}
            {item.conflict && !finished && <div style={{ display: 'grid', gap: 6, margin: '8px 0 0 24px' }}>
              <label style={{ display: 'grid', gap: 5 }}><span>{t('localImport.conflict')}</span><select style={field} value={renames[item.id] === undefined ? 'skip' : 'rename'} onChange={(e) => {
                if (e.target.value === 'skip') { setRenames((old) => { const next = { ...old }; delete next[item.id]; return next; }); setSelected((old) => old.filter((id) => id !== item.id)); }
                else { setRenames((old) => ({ ...old, [item.id]: '' })); setSelected((old) => [...new Set([...old, item.id])]); }
              }}><option value="skip">{t('localImport.skip')}</option><option value="rename">{t('localImport.rename')}</option></select></label>
              {renames[item.id] !== undefined && <label style={{ display: 'grid', gap: 5 }}><span>{t('localImport.newName')}</span><input style={field} maxLength={80} value={renames[item.id]} onChange={(e) => setRenames((old) => ({ ...old, [item.id]: e.target.value }))} /></label>}
            </div>}
          </div>;
        })}
      </fieldset>)}
      {chosen.length > 0 && <fieldset disabled={busy} style={{ display: 'grid', gap: 10, border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <legend>{t('localImport.consent')}</legend>
        {['tools', 'memory', 'secrets'].filter((kind) => ({ tools: needsTools, memory: needsMemory, secrets: needsSecrets })[kind]).map((kind) => <label key={kind} style={row}><input type="checkbox" checked={consents[kind]} onChange={(e) => setConsents((old) => ({ ...old, [kind]: e.target.checked }))} /><span>{t(`localImport.consent.${kind}`)}</span></label>)}
      </fieldset>}
      {hasResults && <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}><p style={{ fontSize: 13 }}>{t('localImport.resultsHelp')}</p><Link className="btn sm" href={`/c/${encodeURIComponent(ws)}/market`}>{t('localImport.openTools')}</Link></div>}
    </>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {!denied && <button className="btn" disabled={busy} onClick={() => request('preview', { approvedRootIds: roots })}>{t(data?.scanId ? 'localImport.rescan' : 'localImport.scan')}</button>}
      {data?.scanId && <button className="btn btn-primary" disabled={busy || !canImport} onClick={() => request('import', { scanId: data.scanId, selectedIds: selected, consents, renames })}>{t(hasResults ? 'localImport.retry' : 'localImport.import', { n: chosen.length })}</button>}
      {continuation && (hasResults || denied ? <Link className="btn" href={continuation}>{t('localImport.continue')}</Link> : <button className="btn" disabled={busy} onClick={defer}>{t('localImport.later')}</button>)}
    </div>
  </section>;
}
