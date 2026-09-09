import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-skill-package-'));
const { paths, createCompany } = await import('../src/workspace.mjs');
const { listInstalledSkills, removeSkill, planSkillInjection } = await import('../src/market.mjs');
const { loadSkills } = await import('../src/chat.mjs');

async function company(id) {
  await createCompany(id, 'Skill packages', 'captain');
  return paths(id).skills;
}
async function packageSkill(dir, id, body) {
  await mkdir(join(dir, id, 'references'), { recursive: true });
  await writeFile(join(dir, id, 'SKILL.md'), body);
  await writeFile(join(dir, id, 'references', 'guide.md'), 'SUPPORT_NOT_INJECTED');
}

test('flat skills preserve metadata, exact full/ref prompts and deletion', async () => {
  const ws = 'package-flat';
  const dir = await company(ws);
  const body = '# Flat\nexisting instruction\n';
  await writeFile(join(dir, 'flat.md'), body);
  assert.deepEqual(await listInstalledSkills(ws), [{ id: 'flat', title: 'Flat', size: body.length }]);
  assert.equal(await loadSkills(ws), '\n### 스킬: flat\n# Flat\nexisting instruction\n');
  assert.equal(await loadSkills(ws, 0, 'en'), '\n### Skill: flat\n(Body omitted — injection budget exceeded. Read skills/flat.md for the full text and apply it when relevant.)\n');
  await removeSkill(ws, 'flat');
  assert.deepEqual(await listInstalledSkills(ws), []);
});

test('package inventory and full/ref injection share metadata, entry path and relative base', async () => {
  const ws = 'package-inject';
  const dir = await company(ws);
  const body = '# Package\nRead references/guide.md and run scripts/check.js.\n';
  await packageSkill(dir, 'manual', body);
  const listed = await listInstalledSkills(ws);
  assert.deepEqual(listed, [{ id: 'manual', title: 'Package', size: body.length, path: 'skills/manual/SKILL.md', format: 'package' }]);
  for (const lang of ['ko', 'en']) {
    const full = await loadSkills(ws, 6000, lang);
    const ref = await loadSkills(ws, 0, lang);
    assert.ok(full.includes(body.trim()));
    assert.ok(full.includes('skills/manual/'));
    assert.ok(ref.includes('skills/manual/SKILL.md'));
    assert.ok(ref.includes('skills/manual/'));
    assert.doesNotMatch(ref, /run scripts\/check/);
    assert.doesNotMatch(full + ref + JSON.stringify(listed), /SUPPORT_NOT_INJECTED/);
    assert.ok(!JSON.stringify(listed).includes(body));
  }
  assert.equal(await loadSkills(ws, 6000, 'en', []), '');
  assert.equal(await loadSkills(ws, 6000, 'en', ['other']), '');
  assert.match(await loadSkills(ws, 6000, 'en', ['manual']), /### Skill: manual/);
});

test('mixed packages preserve budget, sorted planning, ref cap and corruption tolerance', async () => {
  const ws = 'package-budget';
  const dir = await company(ws);
  for (let i = 0; i < 22; i++) await packageSkill(dir, `a-${String(i).padStart(2, '0')}`, '# Huge\n' + 'X'.repeat(6000));
  await writeFile(join(dir, 'z-flat.md'), '# Small\nkept');
  await mkdir(join(dir, 'broken', 'SKILL.md'), { recursive: true });
  await mkdir(join(dir, 'bad.md'));
  await symlink(join(dir, 'missing'), join(dir, 'broken-link'));
  const listed = await listInstalledSkills(ws);
  assert.equal(listed.length, 23);
  assert.deepEqual(planSkillInjection(listed).full, ['z-flat']);
  assert.equal(planSkillInjection(listed).ref.length, 20);
  const out = await loadSkills(ws);
  assert.match(out, /# Small\nkept/);
  assert.match(out, /skills\/a-19\/SKILL.md/);
  assert.doesNotMatch(out, /a-20|a-21|broken|X{100}/);
  assert.match(out, /그 외 설치 스킬 2개/);
});

test('duplicate ID prefers flat and refuses ambiguous removal without touching either', async () => {
  const ws = 'package-duplicate';
  const dir = await company(ws);
  await packageSkill(dir, 'same', '# PackageHidden');
  await writeFile(join(dir, 'same.md'), '# FlatWins');
  assert.deepEqual((await listInstalledSkills(ws)).map(s => s.title), ['FlatWins']);
  assert.doesNotMatch(await loadSkills(ws), /PackageHidden/);
  await assert.rejects(removeSkill(ws, 'same'), /ambiguous/i);
  assert.equal(await readFile(join(dir, 'same.md'), 'utf8'), '# FlatWins');
  assert.equal(await readFile(join(dir, 'same', 'SKILL.md'), 'utf8'), '# PackageHidden');
});

test('remove only requested package, preserve siblings and never follow symlinks or traversal', async () => {
  const ws = 'package-delete';
  const dir = await company(ws);
  await packageSkill(dir, 'remove-me', '# Remove');
  await packageSkill(dir, 'keep-me', '# Keep');
  const external = await mkdtemp(join(tmpdir(), 'argo-skill-external-'));
  await writeFile(join(external, 'SKILL.md'), '# External');
  await symlink(external, join(dir, 'remove-me', 'external'));
  await removeSkill(ws, 'remove-me');
  await assert.rejects(lstat(join(dir, 'remove-me')), { code: 'ENOENT' });
  assert.equal(await readFile(join(external, 'SKILL.md'), 'utf8'), '# External');
  assert.equal(await readFile(join(dir, 'keep-me', 'SKILL.md'), 'utf8'), '# Keep');
  for (const id of ['../keep-me', '..\\keep-me', '.', '..', '', 'keep-me/']) await assert.rejects(removeSkill(ws, id));
  await symlink(external, join(dir, 'linked'));
  await assert.rejects(removeSkill(ws, 'linked'));
  await mkdir(join(dir, 'not-a-skill'));
  await writeFile(join(dir, 'not-a-skill', 'data.txt'), 'keep');
  await assert.rejects(removeSkill(ws, 'not-a-skill'));
  await mkdir(join(dir, 'linked-entry'));
  await symlink(join(external, 'SKILL.md'), join(dir, 'linked-entry', 'SKILL.md'));
  assert.deepEqual((await listInstalledSkills(ws)).map(s => s.id), ['keep-me']);
  await assert.rejects(removeSkill(ws, 'linked-entry'));
  await removeSkill(ws, 'missing');
  assert.equal(await readFile(join(external, 'SKILL.md'), 'utf8'), '# External');
});

test('package size uses only SKILL.md at the exact 6000-character boundary', async () => {
  const ws = 'package-boundary';
  const dir = await company(ws);
  await packageSkill(dir, 'exact', 'x'.repeat(6000));
  await writeFile(join(dir, 'later.md'), 'y');
  const listed = await listInstalledSkills(ws);
  assert.deepEqual(planSkillInjection(listed), { full: ['exact'], ref: ['later'], omitted: [] });
  const out = await loadSkills(ws);
  assert.ok(out.includes('x'.repeat(6000)));
  assert.match(out, /skills\/later.md 을 Read/);
});

test('removal refuses a symlinked skills root', async () => {
  const ws = 'package-root-link';
  const dir = paths(ws).skills;
  const external = await mkdtemp(join(tmpdir(), 'argo-skills-root-'));
  await mkdir(paths(ws).root, { recursive: true });
  await packageSkill(external, 'keep', '# Keep');
  await writeFile(join(external, 'flat.md'), '# Flat');
  await symlink(external, dir);
  await assert.rejects(removeSkill(ws, 'keep'), { uiKey: 'market.skillInvalidDirectory' });
  await assert.rejects(removeSkill(ws, 'flat'), { uiKey: 'market.skillInvalidDirectory' });
  assert.equal(await readFile(join(external, 'keep', 'SKILL.md'), 'utf8'), '# Keep');
  assert.equal(await readFile(join(external, 'flat.md'), 'utf8'), '# Flat');
});
