import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, chmod, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const temp = await mkdtemp(join(tmpdir(), 'argo-local-import-'));
process.env.ARGO_ROOT = join(temp, 'companies');
const api = await import('../src/local-asset-import.mjs');
const { paths } = await import('../src/workspace.mjs');
const { readAgentCard, parseScopeList } = await import('../src/persona.mjs');
const context = { principal: 'local', device: 'test-machine' };
test.after(() => rm(temp, { recursive: true, force: true }));

async function fixture() {
  const wsId = `test-${randomUUID()}`, home = join(temp, randomUUID());
  await mkdir(paths(wsId).root, { recursive: true });
  await writeFile(paths(wsId).company, JSON.stringify({ id: wsId, name: 'Local company' }));
  async function put(path, content, mode) {
    const file = join(home, path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content);
    if (mode) await chmod(file, mode);
  }
  await put('.hermes/SOUL.md', '---\nrunner: malicious-runner\n---\n\nYou are a careful editor.');
  await put('.hermes/memories/MEMORY.md', '# Memory\n\nRemember the blue project.');
  await put('.hermes/memories/USER.md', '# User\n\nPrefer short answers.');
  await put('.hermes/skills/editor/SKILL.md', '# Editor\nRun scripts/check.sh only on request.');
  await put('.hermes/skills/editor/scripts/check.sh', '#!/bin/sh\nprintf done\n', 0o755);
  await put('.hermes/config.yaml', 'mcp_servers:\n  demo:\n    command: node\n    args: [--version]\n  filtered:\n    command: node\n    tools: [safe]\n');
  const options = { sourceOptions: { home, env: {} } };
  return { wsId, home, put, options };
}
function request(preview, consents = { tools: true, memory: true, secrets: false }) {
  return { scanId: preview.scanId, selectedIds: preview.items.map(i => i.id), consents };
}
async function tree(root) {
  const files = {};
  async function visit(at, rel) {
    for (const dirent of await readdir(at, { withFileTypes: true })) {
      const next = join(at, dirent.name), name = `${rel}${dirent.name}`;
      if (dirent.isDirectory()) await visit(next, `${name}/`);
      else files[name] = await readFile(next, 'utf8');
    }
  }
  await visit(root, '');
  return files;
}

test('preview writes only private metadata; selected tools/memory usable and source bytes/modes unchanged', async () => {
  const f = await fixture(), before = await tree(f.home);
  const preview = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  assert.equal(preview.items.length, 6);
  assert.ok(preview.items.every(i => i.selected === false));
  assert.deepEqual(await readdir(paths(f.wsId).root), ['company.json']);
  const publicJson = JSON.stringify(preview);
  for (const forbidden of [f.home, 'malicious-runner', 'server.js', 'blue project']) assert.ok(!publicJson.includes(forbidden));
  const result = await api.executeLocalAssets(f.wsId, context, request(preview), f.options);
  assert.equal(result.phase, 'partial');
  const profile = result.items.find(i => i.kind === 'profile');
  const card = await readFile(join(paths(f.wsId).root, profile.target), 'utf8');
  const fm = (await readAgentCard(f.wsId, profile.target.split('/').pop().replace(/\.md$/, ''))).meta;
  assert.equal(fm.runner, undefined);
  assert.deepEqual(parseScopeList(fm.skills), ['editor']);
  assert.deepEqual(parseScopeList(fm.mcp), ['demo']);
  assert.match(card, /vault\/imported\/hermes-/);
  const mcp = JSON.parse(await readFile(paths(f.wsId).mcp, 'utf8'));
  assert.deepEqual(Object.keys(mcp.servers), ['demo']);
  if (process.platform !== 'win32') assert.equal((await stat(paths(f.wsId).mcp)).mode & 0o777, 0o600);
  const script = join(paths(f.wsId).skills, 'editor/scripts/check.sh');
  assert.equal(await readFile(script, 'utf8'), before['.hermes/skills/editor/scripts/check.sh']);
  if (process.platform !== 'win32') assert.ok((await stat(script)).mode & 0o111);
  assert.deepEqual(await tree(f.home), before);
  const notes = await readdir(paths(f.wsId).notes);
  assert.equal(notes.length, 2);
  for (const name of notes) assert.match(await readFile(join(paths(f.wsId).notes, name), 'utf8'), /vault\/imported\//);
  const restored = await api.localAssetStatus(f.wsId, context);
  assert.deepEqual(restored, result);
  const state = JSON.stringify(await tree(join(process.env.ARGO_ROOT, '.local-assets')));
  for (const forbidden of ['malicious-runner', 'blue project', 'server.js']) assert.ok(!state.includes(forbidden));
});

test('missing scope consent skips shared assets while profile gets explicit empty scopes', async () => {
  const f = await fixture(), preview = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  const result = await api.executeLocalAssets(f.wsId, context, request(preview, {}), f.options);
  const profile = result.items.find(i => i.kind === 'profile');
  assert.equal(profile.status, 'imported');
  const fm = (await readAgentCard(f.wsId, profile.target.split('/').pop().replace(/\.md$/, ''))).meta;
  assert.deepEqual(parseScopeList(fm.skills), []);
  assert.deepEqual(parseScopeList(fm.mcp), []);
  assert.ok(!result.items.some(i => i.kind === 'memory' && i.status === 'imported'));
  await assert.rejects(readFile(paths(f.wsId).mcp), { code: 'ENOENT' });
});

test('same scan idempotent; edited/deleted targets remain untouched and fresh renamed copy is explicit', async () => {
  const f = await fixture(), p = await api.previewLocalAssets(f.wsId, context, {}, f.options), req = request(p);
  const first = await api.executeLocalAssets(f.wsId, context, req, f.options);
  const second = await api.executeLocalAssets(f.wsId, context, req, f.options);
  assert.deepEqual(first, second);
  assert.equal((await readdir(paths(f.wsId).agents)).length, 1);
  await writeFile(join(paths(f.wsId).skills, 'editor/SKILL.md'), 'User edited this');
  const changed = await api.executeLocalAssets(f.wsId, context, req, f.options);
  assert.equal(changed.items.find(i => i.kind === 'skill').reason, 'target-changed');
  await rm(join(paths(f.wsId).skills, 'editor'), { recursive: true });
  const deleted = await api.executeLocalAssets(f.wsId, context, req, f.options);
  assert.equal(deleted.items.find(i => i.kind === 'skill').reason, 'target-deleted');
  await f.put('.hermes/skills/editor/SKILL.md', '# Revised editor');
  const fresh = await api.previewLocalAssets(f.wsId, context, {}, f.options), skill = fresh.items.find(i => i.kind === 'skill');
  const copied = await api.executeLocalAssets(f.wsId, context, { ...request(fresh), selectedIds: [skill.id], renames: { [skill.id]: 'new-editor' } }, f.options);
  assert.equal(copied.items.find(i => i.id === skill.id).status, 'imported');
});

test('source mutation, principal/device replay and ownership changes fail closed', async () => {
  const f = await fixture(), preview = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  await assert.rejects(api.executeLocalAssets(f.wsId, { ...context, device: 'other' }, request(preview), f.options), /scan-expired/);
  await assert.rejects(api.localAssetStatus(f.wsId, { principal: 'other-user', device: context.device }), /forbidden/);
  await f.put('.hermes/skills/editor/SKILL.md', 'changed after preview');
  const result = await api.executeLocalAssets(f.wsId, context, request(preview), f.options);
  assert.equal(result.items.find(i => i.kind === 'skill').reason, 'source-changed');
  await writeFile(paths(f.wsId).company, JSON.stringify({ ownerId: 'new-owner' }));
  await assert.rejects(api.executeLocalAssets(f.wsId, context, request(preview), f.options), /forbidden/);
});

test('secret MCP literal appears only in opted-in 0600 MCP file, never DTO/journal', async () => {
  const f = await fixture(), canary = randomUUID();
  await f.put('.hermes/config.yaml', `mcp_servers:\n  secure:\n    command: node\n    env:\n      API_TOKEN: ${canary}\n`);
  let preview = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  let result = await api.executeLocalAssets(f.wsId, context, request(preview), f.options);
  assert.equal(result.items.find(i => i.kind === 'mcp').reason, 'secrets-consent');
  preview = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  result = await api.executeLocalAssets(f.wsId, context, request(preview, { tools: true, memory: false, secrets: true }), f.options);
  assert.equal(result.items.find(i => i.kind === 'mcp').status, 'imported');
  assert.ok(!JSON.stringify(result).includes(canary));
  assert.ok(!JSON.stringify(await tree(join(process.env.ARGO_ROOT, '.local-assets'))).includes(canary));
  const files = await tree(paths(f.wsId).root);
  assert.deepEqual(Object.keys(files).filter(k => files[k].includes(canary)), ['mcp.json']);
});

test('target parent symlink cannot publish into another directory', async () => {
  const f = await fixture(), p = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  const outside = join(temp, randomUUID()); await mkdir(outside);
  await symlink(outside, paths(f.wsId).skills);
  const skill = p.items.find(i => i.kind === 'skill');
  const result = await api.executeLocalAssets(f.wsId, context, { ...request(p), selectedIds: [skill.id] }, f.options);
  assert.equal(result.items.find(i => i.id === skill.id).reason, 'target-changed');
  assert.deepEqual(await readdir(outside), []);
});

test('failed dependency defers profile, subset retry preserves successful results and original scopes', async () => {
  const f = await fixture(), p = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  const skill = p.items.find(i => i.kind === 'skill'), profile = p.items.find(i => i.kind === 'profile');
  const req = { ...request(p), renames: { [skill.id]: 'renamed-editor' } };
  const first = await api.executeLocalAssets(f.wsId, context, req, { ...f.options, checkpoint: async (stage, item) => {
    if (stage === 'staged' && item.id === skill.id) throw new Error('controlled write failure');
  } });
  assert.equal(first.items.find(i => i.id === skill.id).status, 'failed');
  assert.equal(first.items.find(i => i.id === skill.id).name, 'renamed-editor');
  assert.equal(first.items.find(i => i.id === profile.id).reason, 'dependency-failed');
  await assert.rejects(readdir(paths(f.wsId).agents), { code: 'ENOENT' });
  const retry = await api.executeLocalAssets(f.wsId, context, { ...req, selectedIds: [skill.id, profile.id] }, f.options);
  assert.equal(retry.items.find(i => i.id === profile.id).status, 'imported');
  assert.equal(retry.items.filter(i => i.kind === 'memory' && i.status === 'imported').length, 2);
  assert.equal(retry.items.find(i => i.kind === 'mcp' && i.name === 'demo').status, 'imported');
  const fm = (await readAgentCard(f.wsId, profile.name)).meta;
  assert.deepEqual(parseScopeList(fm.skills), ['renamed-editor']);
  assert.deepEqual(parseScopeList(fm.mcp), ['demo']);
});

test('existing scan does not authorize widened selections or secret consent', async () => {
  const f = await fixture(), p = await api.previewLocalAssets(f.wsId, context, {}, f.options), profile = p.items.find(i => i.kind === 'profile');
  const req = { ...request(p, {}), selectedIds: [profile.id] };
  await api.executeLocalAssets(f.wsId, context, req, f.options);
  await assert.rejects(api.executeLocalAssets(f.wsId, context, request(p), f.options), /selection-changed/);
  await assert.rejects(api.executeLocalAssets(f.wsId, context, { ...req, consents: { secrets: true } }, f.options), /selection-changed/);
});

async function child(f, req, stage) {
  const moduleUrl = new URL('../src/local-asset-import.mjs', import.meta.url).href;
  const code = `const {executeLocalAssets}=await import(${JSON.stringify(moduleUrl)}); await executeLocalAssets(${JSON.stringify(f.wsId)},${JSON.stringify(context)},${JSON.stringify(req)},{sourceOptions:${JSON.stringify(f.options.sourceOptions)},checkpoint:async stage=>{if(stage===${JSON.stringify(stage)})process.exit(72)}});`;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject); proc.on('exit', code => resolve({ code, stderr }));
  });
}
for (const kind of ['skill', 'profile', 'mcp', 'memory']) {
  for (const stage of ['reserved', 'staged', 'published']) {
    test(`real process exit at ${kind}/${stage} resumes reserved target without duplication`, async () => {
      const f = await fixture(), p = await api.previewLocalAssets(f.wsId, context, {}, f.options);
      const item = p.items.find(i => i.kind === kind && i.compatibility === 'available');
      const req = { ...request(p), selectedIds: [item.id] };
      const crashed = await child(f, req, stage);
      assert.equal(crashed.code, 72, crashed.stderr);
      const interrupted = await api.localAssetStatus(f.wsId, context);
      assert.equal(interrupted.phase, 'importing');
      assert.ok(['planned', 'staged', 'failed'].includes(interrupted.items.find(i => i.id === item.id).status));
      assert.equal(interrupted.items.find(i => i.id === item.id).name, item.name);
      const result = await api.executeLocalAssets(f.wsId, context, req, f.options);
      assert.equal(result.items.find(i => i.id === item.id).status, 'imported');
      const again = await api.executeLocalAssets(f.wsId, context, req, f.options);
      assert.deepEqual(result, again);
      if (kind === 'profile') assert.equal((await readdir(paths(f.wsId).agents)).length, 1);
      if (kind === 'skill') assert.deepEqual(await readdir(paths(f.wsId).skills), ['editor']);
      if (kind === 'mcp') assert.deepEqual(Object.keys(JSON.parse(await readFile(paths(f.wsId).mcp)).servers), ['demo']);
      if (kind === 'memory') assert.equal((await readdir(paths(f.wsId).notes)).length, 1);
    });
  }
}

test('concurrent processes importing same scan converge on a single crew', async () => {
  const f = await fixture(), p = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  const req = { ...request(p), selectedIds: [p.items.find(i => i.kind === 'profile').id] };
  const results = await Promise.all([child(f, req, 'never'), child(f, req, 'never'), child(f, req, 'never')]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal((await readdir(paths(f.wsId).agents)).length, 1);
});

test('old lock timestamp never evicts a live importer', async () => {
  const f = await fixture(), p = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  const req = { ...request(p), selectedIds: [p.items.find(i => i.kind === 'profile').id] };
  let contender, finished = false;
  await api.executeLocalAssets(f.wsId, context, req, { ...f.options, checkpoint: async stage => {
    if (stage !== 'reserved') return;
    await utimes(join(process.env.ARGO_ROOT, '.local-assets', `company-${f.wsId}`, 'lock'), new Date(0), new Date(0));
    contender = child(f, req, 'never').then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(finished, false);
  } });
  assert.equal((await contender).code, 0);
  assert.equal((await readdir(paths(f.wsId).agents)).length, 1);
});

test('deleted memory index is not silently recreated', async () => {
  const f = await fixture(), p = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  const memory = p.items.find(i => i.kind === 'memory'), req = { ...request(p), selectedIds: [memory.id] };
  await api.executeLocalAssets(f.wsId, context, req, f.options);
  const [index] = await readdir(paths(f.wsId).notes);
  await rm(join(paths(f.wsId).notes, index));
  const retried = await api.executeLocalAssets(f.wsId, context, req, f.options);
  assert.equal(retried.items.find(i => i.id === memory.id).reason, 'target-deleted');
  assert.deepEqual(await readdir(paths(f.wsId).notes), []);
});

test('OpenClaw selected shared tools reach each imported profile and rules stay inactive references', async () => {
  const f = await fixture();
  await f.put('.openclaw/openclaw.json', JSON.stringify({ agents: { entries: { first: {}, second: {} } }, mcp: { servers: { shared: { command: 'node', args: ['--version'] } } } }));
  await f.put('.openclaw/workspace-first/SOUL.md', 'First employee.');
  await f.put('.openclaw/workspace-first/AGENTS.md', 'Project-specific rules.');
  await f.put('.openclaw/workspace-second/SOUL.md', 'Second employee.');
  const p = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  const selected = p.items.filter(i => i.source === 'openclaw');
  const result = await api.executeLocalAssets(f.wsId, context, { ...request(p), selectedIds: selected.map(i => i.id) }, f.options);
  for (const profile of result.items.filter(i => i.source === 'openclaw' && i.kind === 'profile')) {
    assert.equal(profile.status, 'imported');
    const card = await readAgentCard(f.wsId, profile.name);
    assert.deepEqual(parseScopeList(card.meta.mcp), ['shared']);
    assert.ok(!card.md.includes('Project-specific rules.'));
  }
  const rule = result.items.find(i => i.kind === 'rule');
  assert.equal(rule.status, 'needs-setup');
  assert.equal(rule.reason, 'reference-only');
  assert.ok(Object.values(await tree(paths(f.wsId).root)).some(text => text.includes('Project-specific rules.')));
});


test('OpenClaw nested memory imports portable relative paths with original content intact', async () => {
  const f = await fixture();
  await f.put('.openclaw/openclaw.json', '{agents:{entries:{main:{}}}}');
  await f.put('.openclaw/workspace/memory/nested/today.md', 'Portable nested memory.');
  const before = await tree(f.home);
  const p = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  const memory = p.items.find(i => i.source === 'openclaw' && i.kind === 'memory');
  assert.ok(memory);
  const result = await api.executeLocalAssets(f.wsId, context, { ...request(p), selectedIds: [memory.id] }, f.options);
  const imported = result.items.find(i => i.id === memory.id);
  assert.equal(imported.status, 'imported');
  const files = await tree(join(paths(f.wsId).root, imported.target));
  assert.equal(files['memory/nested/today.md'], 'Portable nested memory.');
  assert.deepEqual(await tree(f.home), before);
});

// 2026-09-10 사용성 제보 — 승인한 폴더가 새로고침 뒤 풀리던 것: 서버가 승인된 루트 id를 응답·상태에 돌려준다
test('preview and status echo approved root ids so the screen can restore the checks', async () => {
  const f = await fixture();
  const external = join(temp, `ext-${randomUUID()}`); await mkdir(external, { recursive: true }); await writeFile(join(external, 'SKILL.md'), '# Ext');
  await mkdir(join(f.home, '.claude/skills'), { recursive: true }); await symlink(external, join(f.home, '.claude/skills/ext'));
  const base = await api.previewLocalAssets(f.wsId, context, {}, f.options);
  assert.equal(base.roots.length, 1); assert.deepEqual(base.approvedRootIds, []);
  const approved = await api.previewLocalAssets(f.wsId, context, { approvedRootIds: [base.roots[0].id] }, f.options);
  assert.deepEqual(approved.approvedRootIds, [base.roots[0].id]);
  assert.ok(approved.items.some(i => i.source === 'claude' && i.kind === 'skill' && i.reason === null), '승인 뒤 외부 스킬이 가져오기 가능해야 한다'); // 이름은 링크명이 아니라 실폴더명
  const status = await api.localAssetStatus(f.wsId, context);
  assert.deepEqual(status.approvedRootIds, [base.roots[0].id]);
  assert.ok(!JSON.stringify(approved).includes(external), '응답에 실경로가 새면 안 된다');
});
