import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import JSON5 from 'json5';

export const LOCAL_ASSET_LIMITS = Object.freeze({ files: 10_000, depth: 20, bytes: 100 * 1024 ** 2, package: 20 * 1024 ** 2, text: 1024 ** 2, config: 2 * 1024 ** 2 });
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const fail = reason => Object.assign(new Error(reason), { reason });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const deniedKey = key => ['__proto__', 'constructor', 'prototype'].includes(key);
const safeLabel = value => /^[.\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(String(value)) && !/(?:token|secret|password|sk-|eyJ|[A-Za-z0-9_-]{24,})/i.test(String(value)) ? String(value) : 'Imported asset';
const slug = value => safeLabel(value).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'imported';
const containsSecret = text => /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+:[^\s]+@|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[\"']?[^\s\"']{8,})/i.test(text);
const excluded = name => /^\.env/i.test(name) || /^(?:\.env(?:\..*)?|\.git|\.svn|\.hg|node_modules|__pycache__|\.cache|credentials?(?:\..*)?|auth(?:\..*)?|tokens?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|db))$/i.test(name);

function validateTree(value, depth = 0) {
  if (depth > 40) throw fail('invalid-format');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && !plain(value)) throw fail('invalid-format');
    for (const [key, child] of Object.entries(value)) {
      if (deniedKey(key)) throw fail('invalid-format');
      validateTree(child, depth + 1);
    }
  } else if (typeof value === 'number' && !Number.isFinite(value)) throw fail('invalid-format');
}

// JSON5.parse validates the grammar. This lexical pass only rejects repeated object
// keys, which its reviver cannot observe after the parser has overwritten them.
function rejectDuplicateJsonKeys(text) {
  const stack = []; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/u.test(c)) { i++; continue; }
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end; continue; }
    if (text.startsWith('/*', i)) { i = text.indexOf('*/', i + 2) + 2; continue; }
    if (c === '{' || c === '[') { stack.push({ object: c === '{', key: c === '{', keys: new Set() }); i++; continue; }
    if (c === '}' || c === ']') { stack.pop(); i++; continue; }
    const frame = stack.at(-1);
    if (c === ',') { if (frame?.object) frame.key = true; i++; continue; }
    if (c === ':') { if (frame) frame.key = false; i++; continue; }
    const start = i;
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length) { if (text[i] === '\\') { i += 2; } else if (text[i++] === c) break; }
    } else { while (i < text.length && !/[\s,:\[\]{}]/u.test(text[i]) && !text.startsWith('//', i) && !text.startsWith('/*', i)) i++; }
    if (i === start) throw fail('invalid-format');
    if (frame?.object && frame.key) {
      const token = text.slice(start, i);
      const key = c === '"' || c === "'" ? JSON5.parse(token) : Object.keys(JSON5.parse(`{${token}:0}`))[0];
      if (frame.keys.has(key) || deniedKey(key)) throw fail('invalid-format');
      frame.keys.add(key); frame.key = false;
    }
  }
}

export function parseLocalAssetConfig(text, format) {
  try {
    let value;
    if (format === 'yaml') {
      const doc = parseDocument(text, { uniqueKeys: true, schema: 'core', strict: true });
      if (doc.errors.length || doc.warnings.length) throw fail('invalid-format');
      value = doc.toJS({ maxAliasCount: 0 });
    } else if (format === 'toml') value = parseToml(text);
    else {
      value = format === 'json' ? JSON.parse(text) : JSON5.parse(text);
      rejectDuplicateJsonKeys(text);
    }
    validateTree(value);
    if (!plain(value)) throw fail('invalid-format');
    return value;
  } catch { throw fail('invalid-format'); }
}

export function convertLocalMcp(definition, source) {
  if (!plain(definition)) return { reason: 'invalid-format', hasSecret: false };
  const hasSecret = Object.keys(definition.env || {}).length > 0 || Object.keys(definition.headers || definition.http_headers || {}).length > 0 || (typeof definition.url === 'string' && /[?#]/.test(definition.url)) || (Array.isArray(definition.args) && definition.args.some(arg => typeof arg === 'string' && /(?:--?(?:api[-_]?key|token|password|secret|auth|authorization|bearer)\b|(?:api[-_]?key|token|password|secret)=)/i.test(arg))) || containsSecret(JSON.stringify(definition));
  if (definition.enabled === false || definition.disabled === true) return { reason: 'disabled', hasSecret };
  const allowed = new Set(['command', 'args', 'env', 'url', 'headers', 'enabled']);
  if (source === 'claude') { allowed.add('type'); allowed.add('disabled'); }
  if (source === 'codex') { allowed.delete('headers'); allowed.add('http_headers'); }
  if (source === 'hermes' || source === 'openclaw') allowed.add('transport');
  if (Object.keys(definition).some(key => !allowed.has(key))) return { reason: 'unsupported-option', hasSecret };
  if (('enabled' in definition && typeof definition.enabled !== 'boolean') || ('disabled' in definition && typeof definition.disabled !== 'boolean')) return { reason: 'invalid-format', hasSecret };
  const { command, args, env, url } = definition;
  const headers = definition.headers ?? definition.http_headers;
  const strings = object => plain(object) && Object.values(object).every(value => typeof value === 'string');
  if ((args !== undefined && (!Array.isArray(args) || !args.every(arg => typeof arg === 'string'))) || (env !== undefined && !strings(env)) || (headers !== undefined && !strings(headers))) return { reason: 'invalid-format', hasSecret };
  if (JSON.stringify(definition).includes('${')) return { reason: 'unresolved-reference', hasSecret };
  if (Boolean(command) === Boolean(url)) return { reason: 'invalid-transport', hasSecret };
  const type = definition.type ?? definition.transport ?? (command ? 'stdio' : source === 'openclaw' ? 'sse' : 'http');
  if (command) {
    if (typeof command !== 'string' || !command.trim() || type !== 'stdio' || headers !== undefined) return { reason: 'invalid-transport', hasSecret };
    if (path.isAbsolute(command) || command.includes('\\') || command.includes('/') || command.startsWith('.') || args?.some(arg => path.isAbsolute(arg) || /^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/])/.test(arg) || /\.(?:[cm]?js|ts|py|sh|bash|rb|pl|ps1|exe|bat|cmd|php)$/i.test(arg))) return { reason: 'unresolved-reference', hasSecret };
    return { definition: { command, ...(args ? { args } : {}), ...(env ? { env } : {}) }, reason: null, hasSecret };
  }
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !['http', 'sse', 'streamable-http'].includes(type) || args !== undefined || env !== undefined) throw fail('invalid-transport'); }
  catch { return { reason: 'invalid-transport', hasSecret }; }
  return { definition: { type: type === 'streamable-http' ? 'http' : type, url, ...(headers ? { headers } : {}) }, reason: null, hasSecret };
}

async function readBounded(from, root, limit, expected) {
  let handle;
  try {
    const canonicalRoot = await fs.realpath(root);
    const canonical = await fs.realpath(from);
    if (canonicalRoot !== root || !inside(root, canonical) || (expected && canonical !== expected.canonical)) throw fail('source-changed');
    if ([path.basename(root), ...path.relative(root, canonical).split(path.sep)].some(excluded)) throw fail('excluded-files');
    handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const before = await handle.stat();
    const openedPath = await fs.stat(canonical);
    if (await fs.realpath(from) !== canonical || await fs.realpath(canonical) !== canonical || await fs.realpath(root) !== root || openedPath.dev !== before.dev || openedPath.ino !== before.ino) throw fail('source-changed');
    if (!before.isFile()) throw fail('unsafe-path');
    if (before.size > limit) throw fail('file-limit');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const after = await handle.stat();
    const current = await fs.stat(canonical);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.dev !== before.dev || current.ino !== before.ino || await fs.realpath(from) !== canonical || await fs.realpath(root) !== root) throw fail('source-changed');
    const data = bytes.subarray(0, offset); const hash = digest(data);
    if (expected && (hash !== expected.hash || before.size !== expected.size || (before.mode & 0o777) !== expected.mode)) throw fail('source-changed');
    return { data, file: { from, root, canonical, hash, size: before.size, mode: before.mode & 0o777 } };
  } catch (error) { throw fail(error.reason || 'source-unreadable'); }
  finally { await handle?.close(); }
}

export async function readLocalAssetFile(item, file) {
  if (!item.files.includes(file) || !file.root || !file.canonical) throw fail('unsafe-path');
  return (await readBounded(file.from, file.root, file.size, file)).data;
}

export function localAssetMetadata(item) {
  return { source: item.source, label: item.label, groupLabel: item.groupLabel, kind: item.kind, name: item.name, compatibility: item.compatibility, reason: item.reason, hasSecret: item.hasSecret, bytes: item.files.reduce((sum, file) => sum + file.size, 0), files: item.files.length };
}

export async function scanLocalAssetSources({ home = homedir(), env = process.env, approvedRoots = [] } = {}) {
  home = await fs.realpath(home);
  const items = [], roots = [], issues = [], seen = new Set(), candidates = new Set();
  const limits = LOCAL_ASSET_LIMITS; let count = 0, total = 0;
  const protectedRoots = await Promise.all([process.cwd(), env.ARGO_ROOT, env.CREWBASE_ROOT, path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.gnupg'), path.join(home, '.azure'), path.join(home, '.kube'), path.join(home, '.config', 'gcloud'), path.join(home, 'Library', 'Keychains')].filter(Boolean).map(async value => fs.realpath(value).catch(() => path.resolve(value))));
  const issue = (source, reason) => { if (!issues.some(i => i.source === source && i.reason === reason)) issues.push({ source, reason }); };
  const expand = value => value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(value);
  async function rootFor(input, source, trusted = false) {
    try {
      const requested = path.resolve(input), canonical = await fs.realpath(requested);
      if (!(await fs.stat(canonical)).isDirectory()) throw fail('unsafe-path');
      if ((inside(home, canonical) ? path.relative(home, canonical) : canonical).split(path.sep).some(excluded) || canonical === home || canonical === path.parse(canonical).root || protectedRoots.some(root => inside(canonical, root) || inside(root, canonical))) throw fail('protected-root');
      if (!trusted || requested !== canonical) {
        if (!candidates.has(canonical)) { candidates.add(canonical); roots.push({ id: digest(`root:${canonical}`).slice(0, 32), label: (inside(home, canonical) ? `~/${path.relative(home, canonical).split(path.sep).map(safeLabel).join('/')}` : canonical.split(path.sep).map(segment => segment ? safeLabel(segment) : '').join(path.sep)), path: canonical }); }
        if (!approvedRoots.includes(canonical)) { issue(source, 'external-root'); return null; }
      }
      return canonical;
    } catch (error) { if (error.code !== 'ENOENT') issue(source, error.reason || 'source-unreadable'); return null; }
  }
  async function entries(dir, root, depth = 0) {
    if (depth > limits.depth) throw fail('scan-limit');
    if (count >= limits.files) throw fail('scan-limit');
    const real = await fs.realpath(dir);
    if (!inside(root, real)) throw fail('unsafe-path');
    const handle = await fs.opendir(real); const out = [];
    for await (const entry of handle) { if (++count > limits.files) throw fail('scan-limit'); out.push(entry); }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function read(from, root, limit, rel = path.basename(from)) {
    if (total > limits.bytes || count > limits.files) throw fail('scan-limit');
    let result;
    try { result = await readBounded(from, root, Math.min(limit, limits.bytes - total)); }
    catch (error) { if (error.reason === 'file-limit' && limits.bytes - total < limit) throw fail('scan-limit'); throw error; }
    total += result.file.size;
    if (total > limits.bytes) throw fail('scan-limit');
    return { ...result, file: { ...result.file, rel, containsSecret: containsSecret(result.data.toString('utf8')) } };
  }
  function add(source, group, groupLabel, kind, name, files, extra = {}) {
    const identity = kind === 'skill' ? files.find(file => file.rel === 'SKILL.md')?.canonical || name : name;
    const key = `${source}:${group}:${kind}:${identity}`;
    if (seen.has(key)) return;
    seen.add(key);
    const hasSecret = Boolean(extra.hasSecret || files.some(file => file.containsSecret));
    const reason = extra.reason || (hasSecret && kind !== 'mcp' ? 'secret-material' : null);
    items.push({ key, source, group, groupLabel: safeLabel(groupLabel), kind, name: slug(path.basename(name)), label: safeLabel(path.basename(name)), files, fingerprint: digest(JSON.stringify([files.map(f => [f.canonical, f.rel, f.hash, f.mode]), extra.definition, reason])), compatibility: reason ? 'needs-setup' : 'available', ...extra, reason, hasSecret });
  }
  async function textAsset(source, group, label, root, relative, kind) {
    const from = path.join(root, relative);
    try {
      const { data, file } = await read(from, root, limits.text, relative);
      add(source, group, label, kind, kind === 'profile' ? label : relative, [file], { ...(kind === 'profile' ? { profileText: data.toString('utf8') } : {}), ...(kind === 'rule' ? { reason: 'reference-only' } : {}) });
    } catch (error) { if (await fs.lstat(from).catch(() => null)) issue(source, error.reason === 'file-limit' ? 'text-limit' : error.reason); }
  }
  async function skills(source, group, label, input, trusted = true) {
    const root = await rootFor(input, source, trusted); if (!root) return;
    async function visit(dir, depth, ancestors) {
      const real = await fs.realpath(dir);
      if (ancestors.has(real) || !inside(root, real)) throw fail('unsafe-path');
      const next = new Set([...ancestors, real]);
      const list = await entries(dir, root, depth);
      if (list.some(entry => entry.name === 'SKILL.md')) {
        const files = []; let size = 0, reason = null, excludedCount = 0;
        async function collect(folder, relative, d, parents, boundary = root) {
          const canonical = await fs.realpath(folder);
          if (parents.has(canonical) || !inside(boundary, canonical)) throw fail('unsafe-path');
          const nested = new Set([...parents, canonical]);
          for (const entry of await entries(folder, boundary, d)) {
            if (excluded(entry.name)) { excludedCount++; continue; }
            const from = path.join(folder, entry.name), rel = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.name.includes('\\') || entry.name.includes(':')) throw fail('unsafe-path');
            const target = await fs.realpath(from);
            if (path.relative(root, target).split(path.sep).filter(segment => segment !== '..').some(excluded)) { excludedCount++; continue; }
            const stat = await fs.stat(target);
            let targetRoot = boundary;
            if (!inside(boundary, target)) {
              targetRoot = await rootFor(stat.isDirectory() ? target : path.dirname(target), source, false);
              if (!targetRoot) throw fail('external-root');
            }
            if (stat.isDirectory()) await collect(from, rel, d + 1, nested, targetRoot);
            else if (stat.isFile()) {
              const result = await read(from, targetRoot, Math.min(limits.package - size, entry.name === 'SKILL.md' ? limits.text : limits.package), rel);
              size += result.file.size; files.push(result.file);
            } else throw fail('unsafe-path');
          }
        }
        try { await collect(dir, '', depth, new Set()); if (excludedCount) reason = 'excluded-files'; }
        catch (error) { reason = error.reason === 'file-limit' ? 'package-limit' : error.reason || 'source-unreadable'; }
        add(source, group, label, 'skill', path.relative(root, dir) || path.basename(dir), files, { reason, excludedCount });
        return;
      }
      for (const entry of list) {
        if (excluded(entry.name)) continue;
        const from = path.join(dir, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const target = await fs.realpath(from); if (!inside(root, target)) { if ((await fs.stat(target)).isDirectory()) await skills(source, group, label, from, false); else issue(source, 'unsafe-path'); continue; }
          if ((await fs.stat(target)).isDirectory()) await visit(from, depth + 1, next);
        }
      }
    }
    try { await visit(root, 0, new Set()); } catch (error) { issue(source, error.reason || 'source-unreadable'); }
  }
  async function config(source, group, label, root, filename, format, select) {
    try {
      const { data, file } = await read(path.join(root, filename), root, limits.config, filename);
      const parsed = parseLocalAssetConfig(data.toString('utf8'), format);
      const servers = select(parsed);
      if (servers !== undefined && !plain(servers)) throw fail('invalid-format');
      for (const [name, def] of Object.entries(servers || {})) add(source, group, label, 'mcp', name, [file], convertLocalMcp(def, source));
      return parsed;
    } catch (error) {
      if (await fs.lstat(path.join(root, filename)).catch(() => null)) issue(source, error.reason === 'file-limit' ? 'config-limit' : error.reason || 'invalid-format');
      return null;
    }
  }
  for (const source of ['claude', 'codex', 'agents']) {
    const base = path.join(home, `.${source}`);
    const root = await rootFor(base, source, true);
    if (root) {
      await skills(source, root, source, path.join(root, 'skills'));
      if (source === 'codex') {
        const parsed = await config(source, root, source, root, 'config.toml', 'toml', value => value.mcp_servers);
        const overrides = parsed?.skills?.config;
        if (overrides !== undefined && !Array.isArray(overrides)) issue(source, 'invalid-format');
        for (const entry of Array.isArray(overrides) ? overrides : []) {
          if (!plain(entry) || typeof entry.path !== 'string' || (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')) { issue(source, 'invalid-format'); continue; }
          const folder = expand(entry.path);
          await skills(source, root, source, folder, inside(root, folder));
          if (entry.enabled === false) { const canonical = await fs.realpath(folder).catch(() => null); for (const item of items) if (item.source === source && item.kind === 'skill' && item.files.some(file => file.rel === 'SKILL.md' && path.dirname(file.canonical) === canonical)) { item.reason = 'disabled'; item.compatibility = 'needs-setup'; item.fingerprint = digest(`${item.fingerprint}:disabled`); } }
        }
      }
    }
  }
  // Only this exact known config may use home as its read boundary.
  await config('claude', path.join(home, '.claude.json'), 'claude', home, '.claude.json', 'json', value => value.mcpServers);
  const hermesInput = env.HERMES_HOME ? expand(env.HERMES_HOME) : path.join(home, '.hermes');
  const hermes = await rootFor(hermesInput, 'hermes', !env.HERMES_HOME || inside(path.join(home, '.hermes'), hermesInput));
  if (hermes) {
    const profiles = [{ root: hermes, label: 'Hermes' }];
    try { for (const entry of await entries(path.join(hermes, 'profiles'), hermes)) if (entry.isDirectory() || entry.isSymbolicLink()) { const root = await rootFor(path.join(hermes, 'profiles', entry.name), 'hermes', true); if (root) profiles.push({ root, label: entry.name }); } } catch (error) { if (error.code !== 'ENOENT') issue('hermes', error.reason || 'source-unreadable'); }
    for (const { root, label } of profiles) {
      await config('hermes', root, label, root, 'config.yaml', 'yaml', value => value.mcp_servers);
      await textAsset('hermes', root, label, root, 'SOUL.md', 'profile');
      await textAsset('hermes', root, label, root, 'AGENTS.md', 'rule');
      for (const filename of ['MEMORY.md', 'USER.md']) await textAsset('hermes', root, label, root, `memories/${filename}`, 'memory');
      await skills('hermes', root, label, path.join(root, 'skills'));
    }
  }
  const openclawInputs = [env.OPENCLAW_STATE_DIR ? expand(env.OPENCLAW_STATE_DIR) : path.join(home, '.openclaw')];
  // Profiles are immediate known state siblings only; never recursively search home.
  try { const dir = await fs.opendir(home); for await (const entry of dir) { if (++count > limits.files) throw fail('scan-limit'); if (/^\.openclaw-[\w-]+$/.test(entry.name) && entry.isDirectory()) openclawInputs.push(path.join(home, entry.name)); } } catch (error) { issue('openclaw', error.reason || 'source-unreadable'); }
  const clawSeen = new Set();
  for (const input of openclawInputs) {
    const root = await rootFor(input, 'openclaw', inside(home, input) && path.dirname(input) === home);
    if (!root || clawSeen.has(root)) continue; clawSeen.add(root);
    let configRoot = root, configName = 'openclaw.json';
    if (input === openclawInputs[0] && env.OPENCLAW_CONFIG_PATH) { const configured = expand(env.OPENCLAW_CONFIG_PATH); configRoot = await rootFor(path.dirname(configured), 'openclaw', inside(root, configured)); configName = path.basename(configured); }
    if (!configRoot) continue;
    const parsed = await config('openclaw', root, 'OpenClaw', configRoot, configName, 'json5', value => value.mcp?.servers);
    await skills('openclaw', root, 'OpenClaw', path.join(root, 'skills'));
    if (await fs.lstat(path.join(root, 'config', 'mcporter.json')).catch(() => null)) issue('openclaw', 'unsupported-option');
    if (!parsed) continue;
    let agents;
    if (parsed.agents?.entries !== undefined) { if (!plain(parsed.agents.entries) || parsed.agents.list !== undefined) { issue('openclaw', 'invalid-format'); continue; } agents = Object.entries(parsed.agents.entries); }
    else if (parsed.agents?.list !== undefined) { if (!Array.isArray(parsed.agents.list) || parsed.agents.list.some(a => !plain(a) || typeof a.id !== 'string') || new Set(parsed.agents.list.map(a => a.id)).size !== parsed.agents.list.length) { issue('openclaw', 'invalid-format'); continue; } agents = parsed.agents.list.map(agent => [agent.id, agent]); }
    else agents = [['main', {}]];
    const defaults = agents.filter(([, agent]) => agent?.default === true);
    const inheritedId = parsed.agents?.ownership !== 'explicit' && defaults.length === 1 ? defaults[0][0] : agents.length === 1 ? agents[0][0] : null;
    for (const [id, agent] of agents) {
      if (!plain(agent)) { issue('openclaw', 'invalid-format'); continue; }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) { issue('openclaw', 'invalid-format'); continue; }
      const fallback = parsed.agents?.defaults?.workspace;
      if (fallback !== undefined && typeof fallback !== 'string') { issue('openclaw', 'invalid-format'); continue; }
      const workspace = agent.workspace ?? (id === inheritedId ? fallback ?? (input === openclawInputs[0] && env.OPENCLAW_WORKSPACE_DIR ? expand(env.OPENCLAW_WORKSPACE_DIR) : path.join(root, 'workspace')) : fallback ? path.join(expand(fallback), id) : path.join(root, `workspace-${id}`));
      if (typeof workspace !== 'string') { issue('openclaw', 'invalid-format'); continue; }
      const workspaceRoot = await rootFor(expand(workspace), 'openclaw', inside(root, expand(workspace))); if (!workspaceRoot) continue;
      const group = `${root}:${id}`;
      const profileFiles = [];
      for (const filename of ['IDENTITY.md', 'SOUL.md']) { try { profileFiles.push((await read(path.join(workspaceRoot, filename), workspaceRoot, limits.text, filename)).file); } catch (error) { if (await fs.lstat(path.join(workspaceRoot, filename)).catch(() => null)) issue('openclaw', error.reason || 'source-unreadable'); } }
      if (profileFiles.length) add('openclaw', group, id, 'profile', id, profileFiles, { sharedGroup: root });
      for (const filename of ['USER.md', 'MEMORY.md']) await textAsset('openclaw', group, id, workspaceRoot, filename, 'memory');
      await textAsset('openclaw', group, id, workspaceRoot, 'AGENTS.md', 'rule');
      async function memory(dir, depth = 0, parents = new Set()) {
        const real = await fs.realpath(dir); if (parents.has(real) || !inside(workspaceRoot, real)) throw fail('unsafe-path');
        for (const entry of await entries(dir, workspaceRoot, depth)) {
          if (excluded(entry.name)) continue;
          const from = path.join(dir, entry.name);
          if (entry.isDirectory()) await memory(from, depth + 1, new Set([...parents, real]));
          else if (entry.name.endsWith('.md')) await textAsset('openclaw', group, id, workspaceRoot, path.relative(workspaceRoot, from).split(path.sep).join('/'), 'memory');
        }
      }
      try { await memory(path.join(workspaceRoot, 'memory')); } catch (error) { if (error.code !== 'ENOENT') issue('openclaw', error.reason || 'source-unreadable'); }
      await skills('openclaw', group, id, path.join(workspaceRoot, 'skills'));
    }
    const extras = parsed.skills?.load?.extraDirs;
    if (extras !== undefined && (!Array.isArray(extras) || extras.some(extra => typeof extra !== 'string'))) issue('openclaw', 'invalid-format');
    else for (const extra of extras || []) await skills('openclaw', root, 'OpenClaw', expand(extra), false);
  }
  return { items, roots, issues };
}
