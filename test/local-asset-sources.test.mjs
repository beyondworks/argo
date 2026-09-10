import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { scanLocalAssetSources, readLocalAssetFile, parseLocalAssetConfig, convertLocalMcp, localAssetMetadata, LOCAL_ASSET_LIMITS } from '../src/local-asset-sources.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-assets-'));
  const home = path.join(root, 'home'); await fs.mkdir(home);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, bytes) => { const target = path.join(home, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); return target; };
  return { root, home, write, scan: options => scanLocalAssetSources({ home, env: {}, ...options }) };
}

test('formal parsers preserve multiline, escapes and comments; reject duplicate/prototype/aliases', () => {
  assert.equal(parseLocalAssetConfig('value: |\n  hello\n  world\n', 'yaml').value, 'hello\nworld\n');
  assert.equal(parseLocalAssetConfig('value = """hello\nworld"""', 'toml').value, 'hello\nworld');
  assert.equal(parseLocalAssetConfig("{ // a comment\n value: 'hello\\nworld', }", 'json5').value, 'hello\nworld');
  for (const [input, format] of [
    ['{"x":1,"x":2}', 'json'], ["{x:1,'x':2}", 'json5'], ['{x:1,\\u0078:2}', 'json5'],
    ['x: 1\nx: 2', 'yaml'], ['x = 1\nx = 2', 'toml'],
    ['{"__proto__":{}}', 'json'], ['{constructor: {prototype: {}}}', 'json5'],
    ['x: &x [1]\ny: *x', 'yaml'], ['x: !!js/function function(){}', 'yaml'],
  ]) assert.throws(() => parseLocalAssetConfig(input, format), /invalid-format/);
});

test('MCP known supported values preserve meaning; inactive/options/references never activate', () => {
  assert.deepEqual(convertLocalMcp({ command: 'node', args: ['--version'], env: { VALUE: 'literal' } }, 'hermes'), { definition: { command: 'node', args: ['--version'], env: { VALUE: 'literal' } }, reason: null, hasSecret: true });
  assert.deepEqual(convertLocalMcp({ url: 'https://example.invalid/mcp', http_headers: { 'X-Key': 'literal' } }, 'codex').definition, { type: 'http', url: 'https://example.invalid/mcp', headers: { 'X-Key': 'literal' } });
  for (const [def, source, reason] of [
    [{ command: 'node', enabled: false }, 'hermes', 'disabled'],
    [{ command: 'node', tools: { include: [] } }, 'hermes', 'unsupported-option'],
    [{ command: 'node', toolFilter: { exclude: [] } }, 'openclaw', 'unsupported-option'],
    [{ command: 'node', future: true }, 'claude', 'unsupported-option'],
    [{ command: 'node', env: { KEY: '${ENV}' } }, 'hermes', 'unresolved-reference'],
    [{ command: '/private/server' }, 'claude', 'unresolved-reference'],
    [{ command: 'node', url: 'https://example.invalid' }, 'claude', 'invalid-transport'],
    [{ url: 'file:///tmp/server' }, 'claude', 'invalid-transport'],
  ]) { const result = convertLocalMcp(def, source); assert.equal(result.reason, reason); assert.equal(result.definition, undefined); }
});

test('all five sources, Hermes named profiles, OpenClaw entries, read-only original bytes and metadata', async t => {
  const f = await fixture(t), canary = randomUUID();
  await f.write('.claude.json', JSON.stringify({ mcpServers: { tools: { command: 'node', args: ['--version'], env: { VALUE: canary } } } }));
  await f.write('.codex/config.toml', '[mcp_servers.lookup]\nurl = "https://example.invalid/mcp"\n');
  for (const source of ['claude', 'codex', 'agents']) {
    await f.write(`.${source}/skills/demo/SKILL.md`, '# Demo\nSee scripts/go.sh');
    const script = await f.write(`.${source}/skills/demo/scripts/go.sh`, '#!/bin/sh\nexit 97\n'); await fs.chmod(script, 0o755);
  }
  await f.write('.hermes/SOUL.md', 'Default identity');
  await f.write('.hermes/profiles/research/SOUL.md', 'Named identity');
  await f.write('.hermes/profiles/research/memories/USER.md', 'Private memory');
  await f.write('.hermes/config.yaml', 'mcp_servers:\n  helper:\n    command: node\n    args: [--version]\n');
  await f.write('.openclaw/openclaw.json', "{agents:{entries:{research:{}}},mcp:{servers:{helper:{command:'node'}}}}");
  await f.write('.openclaw/workspace/IDENTITY.md', 'Research identity');
  await f.write('.openclaw/workspace/SOUL.md', 'Research soul');
  await f.write('.openclaw/workspace/AGENTS.md', 'Project reference');
  await f.write('.openclaw/workspace/memory/nested/today.md', 'Remember');
  const before = await fs.stat(path.join(f.home, '.claude.json'));
  const result = await f.scan();
  assert.deepEqual(new Set(result.items.map(item => item.source)), new Set(['claude', 'codex', 'agents', 'hermes', 'openclaw']));
  assert.equal(result.items.filter(i => i.source === 'hermes' && i.kind === 'profile').length, 2);
  assert.equal(result.items.find(i => i.kind === 'rule').reason, 'reference-only');
  assert.equal(result.items.find(i => i.source === 'openclaw' && i.kind === 'profile').files.length, 2);
  const skill = result.items.find(i => i.source === 'claude' && i.kind === 'skill');
  assert.equal(skill.compatibility, 'available');
  assert.equal(skill.files.find(file => file.rel === 'scripts/go.sh').mode, (await fs.stat(path.join(f.home, '.claude/skills/demo/scripts/go.sh'))).mode & 0o777);
  assert.match((await readLocalAssetFile(skill, skill.files.find(file => file.rel === 'SKILL.md'))).toString(), /Demo/);
  const metadata = JSON.stringify(result.items.map(localAssetMetadata));
  assert.ok(!metadata.includes(canary)); assert.ok(!metadata.includes(f.home)); assert.ok(!metadata.includes('--version'));
  const after = await fs.stat(path.join(f.home, '.claude.json'));
  assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.mode, before.mode);
  assert.equal((await f.scan()).items[0].fingerprint, result.items[0].fingerprint);
});

test('unsafe/excluded package cannot be advertised as complete; internal link copies regular bytes', async t => {
  const f = await fixture(t);
  await f.write('.agents/skills/good/SKILL.md', '# Good');
  const target = await f.write('.agents/skills/good/references/a.md', 'Reference');
  await fs.symlink(target, path.join(f.home, '.agents/skills/good/linked.md'));
  await f.write('.agents/skills/excluded/SKILL.md', '# Excluded');
  await f.write('.agents/skills/excluded/.env.local', 'excluded');
  await f.write('.agents/skills/escape/SKILL.md', '# Escape');
  const external = await f.write('outside.md', 'outside');
  await fs.symlink(external, path.join(f.home, '.agents/skills/escape/escape.md'));
  await f.write('.agents/skills/cycle/SKILL.md', '# Cycle');
  await fs.symlink('.', path.join(f.home, '.agents/skills/cycle/cycle'));
  const result = await f.scan();
  assert.equal(result.items.find(i => i.name === 'excluded').reason, 'excluded-files');
  assert.equal(result.items.find(i => i.name === 'escape').reason, 'external-root');
  assert.equal(result.items.find(i => i.name === 'cycle').reason, 'unsafe-path');
  const good = result.items.find(i => i.name === 'good');
  assert.equal(good.reason, null);
  assert.equal((await readLocalAssetFile(good, good.files.find(file => file.rel === 'linked.md'))).toString(), 'Reference');
});

test('preview read detects changed body, target, mode and bounded file growth', async t => {
  const f = await fixture(t);
  const file = await f.write('.agents/skills/good/SKILL.md', '# Good');
  const { items } = await f.scan(); const item = items[0];
  await fs.writeFile(file, '# Bad!');
  await assert.rejects(readLocalAssetFile(item, item.files[0]), /source-changed/);
  await fs.writeFile(file, '# Good'); await fs.chmod(file, 0o444);
  try { await assert.rejects(readLocalAssetFile(item, item.files[0]), /source-changed/); }
  finally { await fs.chmod(file, 0o600); }
});

test('external workspace is metadata-only before exact approval; home and protected trees denied', async t => {
  const f = await fixture(t), workspace = path.join(f.root, 'external-work');
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'SOUL.md'), 'External identity');
  await f.write('.openclaw/openclaw.json', JSON.stringify({ agents: { list: [{ id: 'research', workspace }] } }));
  let result = await f.scan(); assert.equal(result.items.length, 0); assert.equal(result.roots.length, 1);
  result = await f.scan({ approvedRoots: [result.roots[0].path] }); assert.equal(result.items.filter(i => i.kind === 'profile').length, 1);
  await f.write('.openclaw/openclaw.json', JSON.stringify({ agents: { entries: { research: { workspace: f.home } } } }));
  result = await f.scan({ approvedRoots: [f.home] }); assert.equal(result.items.length, 0); assert.ok(result.issues.some(i => i.reason === 'protected-root'));
});

test('config and text size bounds and malformed config leave source intact', async t => {
  const f = await fixture(t);
  await f.write('.hermes/SOUL.md', Buffer.alloc(LOCAL_ASSET_LIMITS.text + 1, 65));
  const from = await f.write('.claude.json', Buffer.alloc(LOCAL_ASSET_LIMITS.config + 1, 32));
  const before = await fs.stat(from); const result = await f.scan();
  assert.ok(result.issues.some(i => i.reason === 'config-limit'));
  assert.ok(result.issues.some(i => i.reason === 'text-limit'));
  assert.equal((await fs.stat(from)).mtimeMs, before.mtimeMs);
  assert.ok(!(await fs.readdir(f.home)).some(name => name.includes('corrupt')));
});

test('approved symlink roots and external package files preserve exact boundaries', async t => {
  const f = await fixture(t), external = path.join(f.root, 'external');
  await fs.mkdir(external); await fs.writeFile(path.join(external, 'reference.md'), 'Approved reference');
  await f.write('.agents/skills/demo/SKILL.md', '# Demo');
  await fs.symlink(path.join(external, 'reference.md'), path.join(f.home, '.agents/skills/demo/reference.md'));
  let result = await f.scan();
  assert.equal(result.items[0].reason, 'external-root');
  assert.equal(result.roots.length, 1);
  result = await f.scan({ approvedRoots: [result.roots[0].path] });
  assert.equal(result.items[0].reason, null);
  const file = result.items[0].files.find(file => file.rel === 'reference.md');
  assert.equal((await readLocalAssetFile(result.items[0], file)).toString(), 'Approved reference');
  await fs.unlink(path.join(f.home, '.agents/skills/demo/reference.md'));
  await fs.symlink(path.join(f.home, '.agents/skills/demo/SKILL.md'), path.join(f.home, '.agents/skills/demo/reference.md'));
  await assert.rejects(readLocalAssetFile(result.items[0], file), /source-changed/);
});

test('malformed option arrays do not crash scanning, Codex disabled skills stay inactive, secrets stay out of ordinary files', async t => {
  const f = await fixture(t);
  const folder = path.join(f.home, '.codex/skills/demo');
  await f.write('.codex/skills/demo/SKILL.md', '# Demo');
  await f.write('.codex/config.toml', `[[skills.config]]\npath = ${JSON.stringify(folder)}\nenabled = false\n`);
  await f.write('.hermes/SOUL.md', `api_key: ${randomUUID()}`);
  let result = await f.scan();
  assert.equal(result.items.find(item => item.kind === 'skill').reason, 'disabled');
  assert.equal(result.items.find(item => item.kind === 'profile').reason, 'secret-material');
  await f.write('.codex/config.toml', '[skills.config]\nbad = true');
  await f.write('.openclaw/openclaw.json', '{skills: {load: {extraDirs: "wrong"}}}');
  result = await f.scan();
  assert.ok(result.issues.some(issue => issue.source === 'codex' && issue.reason === 'invalid-format'));
  assert.ok(result.issues.some(issue => issue.source === 'openclaw' && issue.reason === 'invalid-format'));
});

test('text/config exact bound accepted and depth/file limits stop traversal', async t => {
  const f = await fixture(t);
  await f.write('.hermes/SOUL.md', Buffer.alloc(LOCAL_ASSET_LIMITS.text, 65));
  await f.write('.claude.json', '{"mcpServers":{}}' + ' '.repeat(LOCAL_ASSET_LIMITS.config - 17));
  let result = await f.scan();
  assert.equal(result.items.find(item => item.kind === 'profile').reason, null);
  assert.ok(!result.issues.some(issue => issue.reason === 'config-limit'));
  await f.write(`.agents/skills/${'deep/'.repeat(LOCAL_ASSET_LIMITS.depth + 1)}SKILL.md`, '# Deep');
  result = await f.scan(); assert.ok(result.issues.some(issue => issue.reason === 'scan-limit'));
});

test('OpenClaw implicit URL transport is SSE; credential-bearing args/URLs require secret consent', () => {
  assert.equal(convertLocalMcp({ url: 'https://example.invalid/mcp' }, 'openclaw').definition.type, 'sse');
  assert.equal(convertLocalMcp({ url: 'https://example.invalid/mcp?key=opaque' }, 'openclaw').hasSecret, true);
  assert.equal(convertLocalMcp({ command: 'node', args: ['--version', '--api-key', randomUUID()] }, 'claude').hasSecret, true);
});

test('OS aliases cannot approve protected Argo data; long token labels are redacted', async t => {
  const f = await fixture(t), protectedRoot = path.join(f.root, 'company-data'), alias = path.join(f.root, 'alias');
  await fs.mkdir(protectedRoot); await fs.symlink(protectedRoot, alias);
  const tokenName = '0123456789abcdef'.repeat(4);
  await f.write(`.agents/skills/${tokenName}/SKILL.md`, '# Demo');
  await f.write('.openclaw/openclaw.json', JSON.stringify({ agents: { entries: { main: { workspace: protectedRoot } } } }));
  const result = await f.scan({ env: { ARGO_ROOT: alias }, approvedRoots: [await fs.realpath(protectedRoot)] });
  assert.ok(result.issues.some(issue => issue.reason === 'protected-root'));
  assert.ok(!JSON.stringify(result.items.map(localAssetMetadata)).includes(tokenName));
});

test('OpenClaw multiple profiles use distinct implicit workspaces with shared tools association', async t => {
  const f = await fixture(t);
  await f.write('.openclaw/openclaw.json', '{agents:{entries:{alpha:{},beta:{}}}}');
  await f.write('.openclaw/workspace-alpha/SOUL.md', 'Alpha');
  await f.write('.openclaw/workspace-beta/SOUL.md', 'Beta');
  const result = await f.scan(); const profiles = result.items.filter(item => item.kind === 'profile');
  assert.equal(profiles.length, 2);
  assert.notEqual(profiles[0].group, profiles[1].group);
  assert.equal(profiles[0].sharedGroup, profiles[1].sharedGroup);
});

test('innocent symlink names cannot bypass credential, cache or env exclusions', async t => {
  const f = await fixture(t);
  await f.write('.agents/skills/demo/SKILL.md', '# Demo');
  const secret = await f.write('.agents/skills/demo/.env.local', randomUUID());
  await fs.symlink(secret, path.join(f.home, '.agents/skills/demo/innocent.txt'));
  const nested = await f.write('.agents/skills/demo/credentials/token.txt', randomUUID());
  await fs.symlink(nested, path.join(f.home, '.agents/skills/demo/another.txt'));
  const result = await f.scan(), item = result.items[0];
  assert.equal(item.reason, 'excluded-files');
  assert.equal(item.files.length, 1);
  assert.equal(item.files[0].rel, 'SKILL.md');
  const protectedFile = { from: secret, canonical: await fs.realpath(secret), root: await fs.realpath(path.dirname(secret)), rel: 'innocent.txt', size: 36, hash: 'unused', mode: 0o600 };
  await assert.rejects(readLocalAssetFile({ files: [protectedFile] }, protectedFile), /excluded-files/);
});


test('MCP file-relative arguments cannot silently change working-directory meaning', () => {
  for (const arg of ['./server.js', '../server.py', '~/server.sh', 'server.mjs', 'server.js']) {
    const result = convertLocalMcp({ command: 'node', args: [arg] }, 'claude');
    assert.equal(result.reason, 'unresolved-reference'); assert.equal(result.definition, undefined);
  }
});

test('an excluded credential ancestor cannot be hidden by approving a nested symlink root', async t => {
  const f = await fixture(t);
  const body = await f.write('.agents/credentials/nested/SKILL.md', '# Credential subtree');
  await fs.mkdir(path.join(f.home, '.agents/skills'), { recursive: true });
  await fs.symlink(path.dirname(body), path.join(f.home, '.agents/skills/demo'));
  const result = await f.scan({ approvedRoots: [await fs.realpath(path.dirname(body))] });
  assert.equal(result.items.length, 0);
  assert.equal(result.roots.length, 0);
  assert.ok(result.issues.some(issue => issue.reason === 'protected-root'));
});

test('package byte budget preserves exact boundary and defers an over-limit package', async t => {
  const f = await fixture(t);
  for (const [name, extra] of [['exact', 0], ['over', 1]]) {
    await f.write(`.agents/skills/${name}/SKILL.md`, '# Skill');
    const file = await f.write(`.agents/skills/${name}/asset.bin`, '');
    await fs.truncate(file, LOCAL_ASSET_LIMITS.package - 7 + extra);
  }
  const result = await f.scan();
  assert.equal(result.items.find(item => item.name === 'exact').reason, null);
  assert.equal(result.items.find(item => item.name === 'exact').files.reduce((sum, file) => sum + file.size, 0), LOCAL_ASSET_LIMITS.package);
  assert.equal(result.items.find(item => item.name === 'over').reason, 'package-limit');
});

test('total source byte budget accepts 100 MiB exactly and rejects the next byte before copying it', async t => {
  const f = await fixture(t);
  let adjustable;
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await f.write(`.agents/skills/${name}/SKILL.md`, '#');
    const payload = await f.write(`.agents/skills/${name}/asset.bin`, '');
    await fs.truncate(payload, LOCAL_ASSET_LIMITS.package - 1 - (name === 'e' ? 2 : 0));
    if (name === 'e') adjustable = payload;
  }
  await f.write('.agents/skills/zlast/SKILL.md', '#');
  const bytes = result => result.items.flatMap(item => item.files).reduce((sum, file) => sum + file.size, 0);
  let result = await f.scan();
  assert.equal(bytes(result), LOCAL_ASSET_LIMITS.bytes - 1);
  assert.ok(result.items.every(item => item.compatibility === 'available'));
  await fs.truncate(adjustable, LOCAL_ASSET_LIMITS.package - 2);
  result = await f.scan();
  assert.equal(bytes(result), LOCAL_ASSET_LIMITS.bytes);
  assert.ok(result.items.every(item => item.compatibility === 'available'));
  await fs.truncate(adjustable, LOCAL_ASSET_LIMITS.package - 1);
  result = await f.scan();
  assert.equal(bytes(result), LOCAL_ASSET_LIMITS.bytes);
  assert.equal(result.items.find(item => item.name === 'zlast').reason, 'scan-limit');
  assert.equal(result.items.find(item => item.name === 'zlast').files.length, 0);
});

test('scan entry budget accepts 10,000 entries exactly and reports a limit at 10,001', async t => {
  const f = await fixture(t), directory = path.join(f.home, '.agents/skills');
  await fs.mkdir(directory, { recursive: true });
  // 예산은 **소스별**(2026-09-10) — agents 소스의 skills 목록 항목만 센다. 홈의 프로필 탐색 목록은 openclaw 소스의 예산이다.
  for (let start = 0; start < LOCAL_ASSET_LIMITS.files - 1; start += 100) {
    const end = Math.min(start + 100, LOCAL_ASSET_LIMITS.files - 1);
    await Promise.all(Array.from({ length: end - start }, (_, index) => fs.writeFile(path.join(directory, `file-${start + index}`), '')));
  }
  let result = await f.scan();
  assert.deepEqual(result.issues, []);
  await fs.writeFile(path.join(directory, 'boundary'), '');
  result = await f.scan();
  assert.deepEqual(result.issues, []);
  await fs.writeFile(path.join(directory, 'over-boundary'), '');
  result = await f.scan();
  assert.ok(result.issues.some(issue => issue.reason === 'scan-limit'));
});

// ── 2026-09-10 실사용 제보 "Hermes·OpenClaw 가져오기 실패" — 실제 홈 스캔으로 잡은 결함 4종 ──

test('a dangling symlink skips only itself (broken-link) — siblings and the rest of the walk still scan', async t => {
  const f = await fixture(t);
  await f.write('.claude/skills/good/SKILL.md', '# Good');
  await fs.symlink(path.join(f.root, 'missing-target'), path.join(f.home, '.claude/skills/a-broken')); // 정렬상 good보다 먼저 만난다
  await f.write('.claude/skills/pkg/SKILL.md', '# Pkg');
  await fs.symlink(path.join(f.root, 'missing-file.md'), path.join(f.home, '.claude/skills/pkg/ref.md'));
  const { items, issues } = await f.scan();
  assert.ok(items.some(i => i.source === 'claude' && i.name === 'good' && i.reason === null), '깨진 링크 뒤의 형제 스킬이 사라졌다 — 순회가 중단됐다');
  assert.equal(items.find(i => i.source === 'claude' && i.name === 'pkg')?.reason, 'broken-link', '패키지 안 깨진 링크는 그 스킬만 broken-link');
  assert.ok(issues.some(i => i.source === 'claude' && i.reason === 'broken-link'));
  assert.ok(!issues.some(i => i.reason === 'source-unreadable'), '깨진 링크가 "원본을 읽을 수 없습니다"로 뭉개졌다');
});

test('cross-tool symlinks into another known skills tree are trusted without approval; links elsewhere still need it', async t => {
  const f = await fixture(t);
  await f.write('.agents/skills/shared/SKILL.md', '# Shared');
  await fs.mkdir(path.join(f.home, '.claude/skills'), { recursive: true });
  await fs.symlink(path.join(f.home, '.agents/skills/shared'), path.join(f.home, '.claude/skills/shared'));
  let result = await f.scan();
  assert.equal(result.roots.length, 0, '다른 도구의 skills/ 트리를 가리키는 링크가 승인 폴더로 잡혔다');
  assert.equal(result.items.find(i => i.source === 'claude' && i.name === 'shared')?.reason, null);
  assert.ok(!result.issues.some(i => i.reason === 'external-root'));
  const external = path.join(f.root, 'elsewhere'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'SKILL.md'), '# Ext');
  await fs.symlink(external, path.join(f.home, '.claude/skills/ext'));
  result = await f.scan();
  assert.equal(result.roots.length, 1, 'skills/ 트리 밖 링크는 여전히 승인 대상');
  assert.ok(result.issues.some(i => i.source === 'claude' && i.reason === 'external-root'));
  // 같은 SKILL.md를 두 도구가 공유하면 항목은 하나(먼저 찾은 소스 아래) — 목록이 도구 수만큼 곱해지지 않는다
  assert.equal(result.items.filter(i => i.kind === 'skill' && i.name === 'shared').length, 1);
});

test('scan limits are per source — a bulky tool cannot starve the next one', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++) await f.write(`.claude/skills/s${i}/SKILL.md`, '# S');
  await f.write('.hermes/skills/h/SKILL.md', '# H');
  const { items, issues } = await f.scan({ limits: { ...LOCAL_ASSET_LIMITS, files: 50 } });
  assert.ok(issues.some(i => i.source === 'claude' && i.reason === 'scan-limit'), 'claude는 한도에 걸려야 한다(픽스처 전제)');
  assert.equal(items.find(i => i.source === 'hermes' && i.name === 'h')?.reason, null, '앞 도구의 한도가 뒤 도구를 굶겼다');
});

test('codex [[skills.config]] path may point at SKILL.md (as Codex writes it) — folder is used, disabled flag applies', async t => {
  const f = await fixture(t);
  await f.write('.codex/skills/demo/SKILL.md', '# Demo');
  await f.write('.codex/config.toml', '[[skills.config]]\npath = "~/.codex/skills/demo/SKILL.md"\nenabled = false\n');
  const { items, issues } = await f.scan();
  const demo = items.find(i => i.source === 'codex' && i.kind === 'skill' && i.name === 'demo');
  assert.equal(demo?.reason, 'disabled');
  assert.ok(!issues.some(i => i.source === 'codex' && i.reason === 'unsafe-path'), 'SKILL.md 파일 경로가 unsafe-path로 떨어졌다');
});

test('openclaw without openclaw.json still imports the default workspace (profile, memory, rules)', async t => {
  const f = await fixture(t);
  await f.write('.openclaw/workspace/IDENTITY.md', 'Main identity');
  await f.write('.openclaw/workspace/SOUL.md', 'Main soul');
  await f.write('.openclaw/workspace/USER.md', 'Main user memory');
  await f.write('.openclaw/workspace/AGENTS.md', 'Rules');
  const { items, issues } = await f.scan();
  assert.equal(items.filter(i => i.source === 'openclaw' && i.kind === 'profile').length, 1);
  assert.ok(items.some(i => i.source === 'openclaw' && i.kind === 'memory'));
  assert.ok(items.some(i => i.source === 'openclaw' && i.kind === 'rule'));
  assert.ok(!issues.some(i => i.source === 'openclaw'), `설정 없는 OpenClaw에 issue가 났다: ${JSON.stringify(issues)}`);
  // 설정 파일이 있는데 깨진 경우는 종전대로 invalid-format — 단 설정과 무관한 skills·mcporter 검사는 계속 돈다(검수 MEDIUM-1: 회귀 금지)
  await f.write('.openclaw/openclaw.json', '{ broken');
  await f.write('.openclaw/skills/mine/SKILL.md', '# Mine');
  await f.write('.openclaw/config/mcporter.json', '{}');
  const again = await f.scan();
  assert.ok(again.issues.some(i => i.source === 'openclaw' && i.reason === 'invalid-format'));
  assert.ok(again.issues.some(i => i.source === 'openclaw' && i.reason === 'unsupported-option'), 'mcporter 검사가 설정 파손에 가려졌다');
  assert.equal(again.items.filter(i => i.source === 'openclaw' && i.kind === 'profile').length, 0, '깨진 설정으로 workspace를 읽으면 안 된다');
  assert.ok(again.items.some(i => i.source === 'openclaw' && i.kind === 'skill' && i.name === 'mine'), '깨진 설정이 스킬까지 감췄다');
});

// ── 분리 검수(2026-09-10) BLOCKED 조건 — 신뢰 확대의 정확한 경계 ──

test('a known skills tree that is itself a symlink is NOT trusted — its target still needs approval (review HIGH-1)', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside-tree');
  await fs.mkdir(path.join(outside, 'stolen'), { recursive: true }); await fs.writeFile(path.join(outside, 'stolen/SKILL.md'), '# Stolen');
  await fs.mkdir(path.join(f.home, '.claude')); await fs.symlink(outside, path.join(f.home, '.claude/skills'));
  const { items, roots, issues } = await f.scan();
  assert.equal(items.filter(i => i.source === 'claude').length, 0, '링크된 트리의 파일을 무승인으로 읽었다');
  assert.equal(roots.length, 1); assert.ok(issues.some(i => i.source === 'claude' && i.reason === 'external-root'));
  // 홈 자체를 가리키는 최악형 — 홈 전체가 신뢰 트리가 되면 안 된다
  const g = await fixture(t);
  await fs.mkdir(path.join(g.home, '.openclaw')); await fs.symlink(g.home, path.join(g.home, '.openclaw/skills'));
  await g.write('Documents/diary/SKILL.md', '# Diary');
  await g.write('.openclaw/openclaw.json', JSON.stringify({ skills: { load: { extraDirs: ['~/Documents'] } } }));
  const r2 = await g.scan();
  assert.equal(r2.items.filter(i => i.name === 'diary').length, 0, '홈 밖/승인 밖 폴더가 무승인으로 읽혔다');
});

test('codex disabled flag reaches a skill that was folded under another source via a cross-tool link (review MEDIUM-2)', async t => {
  const f = await fixture(t);
  await f.write('.codex/skills/demo/SKILL.md', '# Demo');
  await f.write('.codex/config.toml', '[[skills.config]]\npath = "~/.codex/skills/demo/SKILL.md"\nenabled = false\n');
  await fs.mkdir(path.join(f.home, '.claude/skills'), { recursive: true });
  await fs.symlink(path.join(f.home, '.codex/skills/demo'), path.join(f.home, '.claude/skills/demo'));
  const { items } = await f.scan();
  const demo = items.filter(i => i.kind === 'skill' && i.name === 'demo');
  assert.equal(demo.length, 1, '공유 스킬이 두 번 나왔다');
  assert.equal(demo[0].reason, 'disabled', `사용자가 끈 스킬이 활성으로 올라왔다(source=${demo[0].source})`);
});

test('different skills that merely share a name are not folded together when SKILL.md could not be read (review MEDIUM-3)', async t => {
  const f = await fixture(t);
  for (const source of ['claude', 'hermes']) {
    await f.write(`.${source}/skills/build/SKILL.md`, `# ${source} build`);
    await fs.symlink(path.join(f.root, `missing-${source}`), path.join(f.home, `.${source}/skills/build/a-broken.md`)); // 정렬상 SKILL.md보다 먼저 읽혀 패키지 읽기가 실패한다
  }
  const { items } = await f.scan();
  const builds = items.filter(i => i.kind === 'skill' && i.name === 'build');
  assert.equal(builds.length, 2, '이름만 같은 다른 스킬이 접혀 하나가 조용히 사라졌다');
  assert.ok(builds.every(i => i.reason === 'broken-link'));
});

test('bidirectional cross-tool links do not loop or burn the budget (review MEDIUM-4)', async t => {
  const f = await fixture(t);
  await f.write('.claude/skills/one/SKILL.md', '# One'); await f.write('.codex/skills/two/SKILL.md', '# Two');
  await fs.symlink(path.join(f.home, '.codex/skills'), path.join(f.home, '.claude/skills/to-codex'));
  await fs.symlink(path.join(f.home, '.claude/skills'), path.join(f.home, '.codex/skills/to-claude'));
  const started = Date.now();
  const { items, issues } = await f.scan();
  assert.ok(Date.now() - started < 2000, '순환 링크에서 순회가 예산을 태울 때까지 돌았다');
  assert.ok(!issues.some(i => i.reason === 'scan-limit'), JSON.stringify(issues));
  assert.ok(items.some(i => i.name === 'one') && items.some(i => i.name === 'two'));
  assert.equal(items.filter(i => i.kind === 'skill').length, 2, '같은 트리를 여러 번 순회해 중복이 났다');
});

test('~/.claude.json has its own budget — an exhausted agents tree does not hide its MCP servers (review LOW-1)', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++) await f.write(`.agents/skills/s${i}/SKILL.md`, '# S');
  await f.write('.claude.json', JSON.stringify({ mcpServers: { tools: { command: 'node', args: ['--version'] } } }));
  const { items, issues } = await f.scan({ limits: { ...LOCAL_ASSET_LIMITS, files: 50 } });
  assert.ok(issues.some(i => i.source === 'agents' && i.reason === 'scan-limit'));
  assert.ok(!issues.some(i => i.source === 'claude' && i.reason === 'scan-limit'), 'agents 예산이 .claude.json에 상속됐다');
  assert.ok(items.some(i => i.source === 'claude' && i.kind === 'mcp' && i.name === 'tools'));
});
