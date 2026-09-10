// Machine-local receipts contain identifiers and keyed digests, never source bodies or MCP settings.
import { mkdir, readFile, writeFile, link, unlink, rm, lstat, realpath, readdir, rename, chmod } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import { WS_ROOT, paths, loadCompany } from './workspace.mjs';
import { writeJsonAtomic, writeFileAtomic } from './jsonstore.mjs';
import { updateMcp } from './market.mjs';
import { isReservedSlug } from './slug.mjs';
import { scanLocalAssetSources, readLocalAssetFile } from './local-asset-sources.mjs';

const TTL = 24 * 60 * 60 * 1000;
const STATE = join(WS_ROOT, '.local-assets');
const fail = reason => Object.assign(new Error(`localImport.error.${reason}`), { uiKey: `localImport.error.${reason}`, reason });
const SAFE_FAILURES = new Set(['target-changed', 'target-deleted', 'invalid-name', 'source-changed', 'source-unreadable', 'source-boundary', 'conflict', 'dependency-failed', 'write-failed']);
const digest = (key, value) => createHmac('sha256', key).update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function json(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw fail('state-invalid'); }
}
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) throw fail('target-changed');
  await chmod(dir, 0o700);
}
async function identity(context) {
  if (typeof context?.principal !== 'string' || !context.principal || typeof context.device !== 'string' || !context.device) throw fail('forbidden');
  await privateDir(STATE);
  const keyFile = join(STATE, 'key');
  if (!await exists(keyFile)) {
    const candidate = join(STATE, `key-${randomUUID()}`);
    try {
      await writeFileAtomic(candidate, randomBytes(32), { mode: 0o600 });
      try { await link(candidate, keyFile); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    } finally { await unlink(candidate).catch(() => {}); }
  }
  if ((await lstat(keyFile)).isSymbolicLink()) throw fail('state-invalid');
  const key = await readFile(keyFile);
  const id = digest(key, [context.principal, context.device]);
  const dir = join(STATE, id);
  await privateDir(dir);
  return { key, dir, id };
}
async function company(wsId, context) {
  const root = paths(wsId).root;
  if ((await lstat(root)).isSymbolicLink() || resolve(await realpath(root)) !== join(await realpath(WS_ROOT), wsId)) throw fail('target-changed');
  if ((await lstat(paths(wsId).company)).isSymbolicLink()) throw fail('target-changed');
  const value = await loadCompany(wsId);
  // HTTP gate authenticates the context; recheck ownership on every core operation as well.
  const owner = value.ownerId || null;
  if (context.principal === 'local' ? !!owner : owner !== context.principal) throw fail('forbidden');
  return value;
}

// A live process is never displaced by elapsed time. Fully-written hard-link claims avoid an
// empty-owner crash window. Reaping is serialized; an interrupted reaper fails closed (bounded wait).
async function locked(dir, fn) {
  await privateDir(dir);
  const claim = join(dir, `claim-${randomUUID()}`), lock = join(dir, 'lock'), reaper = join(dir, 'reaper');
  await writeFile(claim, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  const started = Date.now();
  try {
    for (;;) {
      try { await link(claim, lock); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      let acquired = false;
      try { await mkdir(reaper, { mode: 0o700 }); acquired = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (acquired) {
        try {
          const owner = await json(lock, null);
          if (owner?.pid) {
            try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') await unlink(lock).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
          }
        } finally { await rm(reaper, { recursive: true }); }
      }
      if (Date.now() - started > 10_000) throw fail('busy');
      await sleep(25);
    }
    try { return await fn(); } finally { await unlink(lock); }
  } finally { await unlink(claim).catch(() => {}); }
}
const safeName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value) && !isReservedSlug(value);
function metadata(item, id, key) {
  return { id, source: item.source, groupId: digest(key, item.group).slice(0, 24), groupLabel: item.groupLabel,
    label: item.label, kind: item.kind, name: safeName(item.name) ? item.name : `asset-${digest(key, item.key).slice(0, 12)}`,
    compatibility: item.compatibility, reason: item.reason || null, hasSecret: !!item.hasSecret,
    bytes: item.files.reduce((n, f) => n + f.size, 0), files: item.files.length, ...(item.excludedCount ? { excludedCount: item.excludedCount } : {}), selected: false, conflict: false };
}
function targetFor(meta, name = meta.name) {
  if (meta.kind === 'skill') return `skills/${name}`;
  if (meta.kind === 'mcp') return `mcp:${name}`;
  if (meta.kind === 'profile') return `agents/${name}.md`;
  return `vault/imported/${meta.source}-${meta.groupId}/${name}`;
}
async function targetExists(wsId, target) {
  const rel = target.startsWith('mcp:') ? 'mcp.json' : target;
  await safeTargetParent(wsId, rel, false);
  if ((await lstat(join(paths(wsId).root, rel)).catch(e => { if (e.code === 'ENOENT') return null; throw e; }))?.isSymbolicLink()) throw fail('target-changed');
  if (target.startsWith('mcp:')) return Object.hasOwn((await json(paths(wsId).mcp, { servers: {} })).servers, target.slice(4));
  if (await exists(join(paths(wsId).root, target))) return true;
  return target.startsWith('skills/') && await exists(join(paths(wsId).root, `${target}.md`));
}
const output = state => ({ phase: state.phase, ...(state.scanId ? { scanId: state.scanId } : {}), items: state.items || [], ...(state.company ? { company: state.company } : {}), ...(state.roots ? { roots: state.roots } : {}), ...(state.issues ? { issues: state.issues } : {}), ...(state.approvedRootIds ? { approvedRootIds: state.approvedRootIds } : {}) });

export async function discoverLocalAssets(context, { sourceOptions = {} } = {}) {
  const ident = await identity(context);
  const prior = await json(join(ident.dir, 'discovery.json'), {});
  const scan = await scanLocalAssetSources(sourceOptions);
  const phase = prior.phase || 'offered';
  await writeJsonAtomic(join(ident.dir, 'discovery.json'), { phase });
  return { available: true, count: scan.items.length, issues: scan.issues, phase };
}
export async function deferLocalAssets(context) {
  const ident = await identity(context);
  await writeJsonAtomic(join(ident.dir, 'discovery.json'), { phase: 'deferred' });
  return { phase: 'deferred' };
}
export async function previewLocalAssets(wsId, context, { approvedRootIds = [] } = {}, { sourceOptions = {} } = {}) {
  const co = await company(wsId, context), ident = await identity(context);
  return locked(join(STATE, `company-${wsId}`), async () => {
    await company(wsId, context);
    const base = await scanLocalAssetSources(sourceOptions);
    if (!Array.isArray(approvedRootIds) || approvedRootIds.some(id => !base.roots.some(r => r.id === id))) throw fail('invalid-roots');
    const approvedRoots = base.roots.filter(r => approvedRootIds.includes(r.id)).map(r => r.path);
    const scan = approvedRoots.length ? await scanLocalAssetSources({ ...sourceOptions, approvedRoots }) : base;
    const scanId = randomUUID();
    const records = [];
    for (const item of scan.items) {
      const id = randomUUID(), meta = metadata(item, id, ident.key);
      meta.conflict = await targetExists(wsId, targetFor(meta));
      records.push({ id, identity: digest(ident.key, item.key), receiptKey: digest(ident.key, [item.key, item.fingerprint]), fingerprint: digest(ident.key, item.fingerprint), ...(item.sharedGroup ? { sharedGroupId: digest(ident.key, item.sharedGroup).slice(0, 24) } : {}), meta });
    }
    const state = { phase: 'reviewing', scanId, expires: Date.now() + TTL, binding: ident.id, wsId,
      company: { id: wsId, name: co.name }, items: records.map(r => r.meta), roots: scan.roots.map(({ id, label }) => ({ id, label })), issues: scan.issues, approvedRootIds: scan.roots.filter(r => approvedRoots.includes(r.path)).map(r => r.id) };
    await writeJsonAtomic(join(ident.dir, `${wsId}-scan.json`), { ...state, records, approvedRoots });
    await writeJsonAtomic(join(ident.dir, `${wsId}-status.json`), state);
    return output(state);
  });
}
export async function localAssetStatus(wsId, context) {
  await company(wsId, context);
  const ident = await identity(context);
  return output(await json(join(ident.dir, `${wsId}-status.json`), { phase: 'idle', items: [] }));
}

async function safeTargetParent(wsId, target, create = true) {
  const root = resolve(paths(wsId).root), dest = resolve(root, target);
  if (!dest.startsWith(root + sep)) throw fail('target-changed');
  const segments = dirname(dest).slice(root.length + 1).split(sep).filter(Boolean);
  let current = root;
  for (const part of segments) {
    current = join(current, part);
    if (create) await mkdir(current).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const stat = await lstat(current).catch(e => { if (!create && e.code === 'ENOENT') return null; throw e; });
    if (!stat) break;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('target-changed');
  }
  return dest;
}
async function treeDigest(file, key) {
  const entries = [];
  async function walk(at, rel) {
    const stat = await lstat(at);
    if (stat.isSymbolicLink()) throw fail('target-changed');
    if (stat.isFile()) entries.push([rel, stat.mode & 0o777, digest(key, await readFile(at))]);
    else if (stat.isDirectory()) { for (const name of (await readdir(at)).sort()) await walk(join(at, name), `${rel}/${name}`); }
    else throw fail('target-changed');
  }
  await walk(file, '');
  return digest(key, entries);
}
async function currentDigest(wsId, reservation, key) {
  const targetPath = reservation.target.startsWith('mcp:') ? 'mcp.json' : reservation.target;
  await safeTargetParent(wsId, targetPath, false);
  if ((await lstat(join(paths(wsId).root, targetPath)).catch(e => { if (e.code === 'ENOENT') return null; throw e; }))?.isSymbolicLink()) throw fail('target-changed');
  if (reservation.target.startsWith('mcp:')) {
    const servers = (await json(paths(wsId).mcp, { servers: {} })).servers;
    const name = reservation.target.slice(4);
    return Object.hasOwn(servers, name) ? digest(key, servers[name]) : null;
  }
  const target = join(paths(wsId).root, reservation.target);
  return await exists(target) ? treeDigest(target, key) : null;
}
async function writeStage(stage, item, record, selected, reservations, options, lang) {
  if (item.kind === 'profile') {
    const scopes = kind => selected.filter(r => [record.meta.groupId, record.sharedGroupId].includes(r.meta.groupId) && r.meta.kind === kind && reservations[r.receiptKey]?.phase === 'committed').map(r => reservations[r.receiptKey].name).join(',') || 'none';
    // Imported frontmatter stays in the body, behind our closed frontmatter and heading.
    const text = item.profileText || (await Promise.all(item.files.map(f => readLocalAssetFile(item, f, options)))).map(b => b.toString('utf8')).join('\n\n');
    const memory = selected.some(r => r.meta.groupId === record.meta.groupId && ['memory', 'rule'].includes(r.meta.kind) && reservations[r.receiptKey]?.phase === 'committed');
    const body = `---\nname: ${record.meta.label.replace(/[\r\n]/g, ' ')}\nslug: ${record.name}\nrole: ${lang === 'en' ? 'Imported profile' : '가져온 직원'}\nskills: ${scopes('skill')}\nmcp: ${scopes('mcp')}\n---\n\n# ${lang === 'en' ? 'Imported profile' : '가져온 직원'}\n\n${text}\n${memory ? `\n${lang === 'en' ? 'Source references' : '원본 참고자료'}: vault/imported/${item.source}-${record.meta.groupId}/\n` : ''}`;
    await writeFileAtomic(stage, body, { mode: 0o600 });
    return;
  }
  await privateDir(stage);
  for (const file of item.files) {
    if (!file.rel || file.rel.includes('\\') || file.rel.split('/').some(p => !p || p === '.' || p === '..')) throw fail('source-changed');
    const dest = resolve(stage, file.rel);
    if (!dest.startsWith(resolve(stage) + sep)) throw fail('source-changed');
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await writeFileAtomic(dest, await readLocalAssetFile(item, file, options), { mode: file.mode & 0o111 ? 0o700 : 0o600 });
  }
}

export async function executeLocalAssets(wsId, context, request, { sourceOptions = {}, checkpoint = async () => {} } = {}) {
  await company(wsId, context);
  const ident = await identity(context);
  return locked(join(STATE, `company-${wsId}`), async () => {
    const co = await company(wsId, context);
    const scan = await json(join(ident.dir, `${wsId}-scan.json`), null);
    if (!scan || scan.binding !== ident.id || scan.scanId !== request?.scanId || scan.wsId !== wsId || scan.expires < Date.now()) throw fail('scan-expired');
    const { selectedIds, consents = {}, renames = {} } = request;
    if (!consents || !renames || typeof consents !== 'object' || typeof renames !== 'object' || Array.isArray(consents) || Array.isArray(renames)) throw fail('invalid-selection');
    if (!Array.isArray(selectedIds) || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !scan.records.some(r => r.id === id))) throw fail('invalid-selection');
    const selectedRecords = scan.records.filter(r => selectedIds.includes(r.id));
    const chosen = { ids: selectedIds, consents: Object.fromEntries(['tools', 'memory', 'secrets'].map(k => [k, consents[k] === true])),
      names: Object.fromEntries(selectedRecords.map(r => [r.id, renames[r.id] ?? r.meta.name])) };
    if (Object.values(chosen.names).some(name => !safeName(name))) throw fail('invalid-name');
    if (scan.selection && (chosen.ids.some(id => !scan.selection.ids.includes(id) || chosen.names[id] !== scan.selection.names[id]) || Object.keys(chosen.consents).some(k => chosen.consents[k] && !scan.selection.consents[k]))) throw fail('selection-changed');
    scan.selection ||= chosen;
    await writeJsonAtomic(join(ident.dir, `${wsId}-scan.json`), scan);
    const options = { ...sourceOptions, approvedRoots: scan.approvedRoots };
    const sources = await scanLocalAssetSources(options);
    const byIdentity = new Map(sources.items.map(i => [digest(ident.key, i.key), i]));
    const journalFile = join(ident.dir, `${wsId}-receipts.json`);
    const reservations = await json(journalFile, {});
    const selected = scan.records.filter(r => selectedIds.includes(r.id));
    const originalSelected = scan.records.filter(r => scan.selection.ids.includes(r.id));
    const ordered = [...selected.filter(r => r.meta.kind !== 'profile'), ...selected.filter(r => r.meta.kind === 'profile')];
    const statusFile = join(ident.dir, `${wsId}-status.json`);
    const previous = await json(statusFile, null);
    const state = { ...scan, phase: 'importing', items: scan.items.map(i => {
      if (selectedIds.includes(i.id)) return { ...i, name: chosen.names[i.id], status: 'planned', reason: null };
      return previous?.scanId === scan.scanId && previous.items.find(r => r.id === i.id && r.status) || { ...i, status: 'skipped', reason: 'not-selected' };
    }) };
    const save = () => writeJsonAtomic(statusFile, output(state));
    await save();
    for (const record of ordered) {
      const result = state.items.find(i => i.id === record.id), item = byIdentity.get(record.identity);
      try {
        if (!item || digest(ident.key, item.fingerprint) !== record.fingerprint) throw fail('source-changed');
        if (item.kind !== 'rule' && item.compatibility !== 'available') { result.status = 'needs-setup'; result.reason = item.reason || 'unsupported'; continue; }
        if (['skill', 'mcp'].includes(item.kind) && consents.tools !== true) { result.status = 'skipped'; result.reason = 'tools-consent'; continue; }
        if (['memory', 'rule'].includes(item.kind) && consents.memory !== true) { result.status = 'skipped'; result.reason = 'memory-consent'; continue; }
        if (item.hasSecret && (item.kind !== 'mcp' || consents.secrets !== true)) { result.status = 'needs-setup'; result.reason = 'secrets-consent'; continue; }
        if (item.kind === 'profile' && reservations[record.receiptKey]?.phase !== 'committed') {
          const pending = originalSelected.some(r => {
            if (![record.meta.groupId, record.sharedGroupId].includes(r.meta.groupId) || r.meta.kind === 'profile') return false;
            if (r.meta.compatibility !== 'available' && r.meta.kind !== 'rule') return false;
            if (r.meta.hasSecret && (r.meta.kind !== 'mcp' || !scan.selection.consents.secrets)) return false;
            if (!scan.selection.consents[['skill', 'mcp'].includes(r.meta.kind) ? 'tools' : 'memory']) return false;
            return reservations[r.receiptKey]?.phase !== 'committed' || state.items.some(i => i.id === r.id && i.status === 'failed');
          });
          if (pending) throw fail('dependency-failed');
        }
        record.name = renames[record.id] ?? record.meta.name;
        if (!safeName(record.name)) throw fail('invalid-name');
        result.name = record.name;
        let receipt = reservations[record.receiptKey];
        if (receipt && receipt.fingerprint !== record.fingerprint) throw fail('source-changed');
        if (!receipt) {
          const target = targetFor(record.meta, record.name);
          if (await targetExists(wsId, target) || Object.values(reservations).some(r => r.target === target)) { result.status = 'skipped'; result.reason = 'conflict'; continue; }
          receipt = reservations[record.receiptKey] = { target, name: record.name, fingerprint: record.fingerprint, phase: 'planned', operation: randomUUID() };
          await writeJsonAtomic(journalFile, reservations);
          await checkpoint('reserved', { id: record.id });
        }
        record.name = receipt.name;
        result.name = receipt.name;
        const current = await currentDigest(wsId, receipt, ident.key);
        if (receipt.phase === 'committed' || receipt.phase === 'staged' && current) {
          if (!current) throw fail('target-deleted');
          if (current !== receipt.digest) throw fail('target-changed');
          receipt.phase = 'committed';
        } else {
          if (current) throw fail('conflict');
          // Revalidate even config/profile files immediately before publication.
          await company(wsId, context);
          for (const file of item.files) await readLocalAssetFile(item, file, options);
          if (item.kind === 'mcp') {
            receipt.digest = digest(ident.key, item.definition);
            receipt.phase = 'staged';
            await writeJsonAtomic(journalFile, reservations);
            await checkpoint('staged', { id: record.id });
            await company(wsId, context);
            await updateMcp(wsId, cfg => {
              if (Object.hasOwn(cfg.servers, receipt.name)) throw fail('conflict');
              cfg.servers[receipt.name] = item.definition;
            });
          } else {
            const staging = join(paths(wsId).root, '.local-assets');
            await safeTargetParent(wsId, '.local-assets/check');
            await privateDir(staging);
            const stage = join(staging, receipt.operation);
            await rm(stage, { recursive: true, force: true });
            await writeStage(stage, item, record, originalSelected, reservations, options, co.lang);
            receipt.digest = await treeDigest(stage, ident.key);
            receipt.phase = 'staged';
            await writeJsonAtomic(journalFile, reservations);
            await checkpoint('staged', { id: record.id });
            await company(wsId, context);
            const target = await safeTargetParent(wsId, receipt.target);
            if (await targetExists(wsId, receipt.target)) throw fail('conflict');
            if (item.kind === 'profile') { await link(stage, target); await unlink(stage); }
            else await rename(stage, target);
          }
          await checkpoint('published', { id: record.id });
          receipt.phase = 'committed';
        }
        await writeJsonAtomic(journalFile, reservations);
        // Index is a deterministic, no-overwrite companion. Recovery can finish it after publication.
        if (['memory', 'rule'].includes(item.kind)) {
          const index = await safeTargetParent(wsId, `vault/notes/import-${receipt.operation}.md`);
          const text = co.lang === 'en' ? `# Imported reference\n\nSource files: ${receipt.target}/\n${item.kind === 'rule' ? '\nInactive reference; not company instructions.\n' : ''}` : `# 가져온 참고자료\n\n원본 파일: ${receipt.target}/\n${item.kind === 'rule' ? '\n비활성 참고자료이며 회사 지침으로 적용되지 않습니다.\n' : ''}`;
          const indexStat = await lstat(index).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
          if (indexStat) {
            if (!indexStat.isFile() || digest(ident.key, await readFile(index)) !== (receipt.indexDigest || digest(ident.key, Buffer.from(text)))) throw fail('target-changed');
          } else {
            if (receipt.indexDone) throw fail('target-deleted');
            const temporary = join(paths(wsId).root, '.local-assets', `index-${receipt.operation}`);
            await safeTargetParent(wsId, `.local-assets/index-${receipt.operation}`);
            await privateDir(dirname(temporary));
            await writeFileAtomic(temporary, text, { mode: 0o600 });
            await link(temporary, index);
            await unlink(temporary);
          }
          receipt.indexDigest ||= digest(ident.key, Buffer.from(text));
          receipt.indexDone = true;
          await writeJsonAtomic(journalFile, reservations);
        }
        result.status = item.kind === 'rule' ? 'needs-setup' : 'imported';
        result.reason = item.kind === 'rule' ? 'reference-only' : null;
        result.target = receipt.target;
        await checkpoint('reported', { id: record.id });
      } catch (e) {
        if (e?.crash) throw e;
        result.status = 'failed'; result.reason = SAFE_FAILURES.has(e.reason) ? e.reason : 'write-failed';
      } finally { await save(); }
    }
    state.phase = state.items.some(i => scan.selection.ids.includes(i.id) && i.status !== 'imported') ? 'partial' : 'completed';
    await save();
    await writeJsonAtomic(join(ident.dir, 'discovery.json'), { phase: state.phase });
    return output(state);
  });
}
