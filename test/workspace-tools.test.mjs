// 도구 패널 파일 관문 — 루트 목록, 경로 탈출/심링크 탈출, 도트 비밀파일, 문서 열기와 검색.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const testRoot = await mkdtemp(join(tmpdir(), 'argo-workspace-tools-'));
process.env.ARGO_ROOT = join(testRoot, 'workspaces');
process.env.HOME = process.env.USERPROFILE = join(testRoot, 'home');

const ws = 'tool-company';
const companyRoot = join(process.env.ARGO_ROOT, ws);
await mkdir(join(companyRoot, 'src', 'nested'), { recursive: true });
await mkdir(process.env.HOME, { recursive: true });
await writeFile(join(companyRoot, 'company.json'), JSON.stringify({ id: ws, name: '도구 회사' }));
await writeFile(join(companyRoot, '.secrets.json'), '{"token":"never-list"}');
await writeFile(join(companyRoot, '.hidden.md'), '# hidden\n');
await writeFile(join(companyRoot, 'README.md'), '# hello\n');
await writeFile(join(companyRoot, 'dashboard.html'), '<!doctype html><style>h1{color:blue}</style><h1>hello</h1>');
await writeFile(join(companyRoot, 'src', 'nested', 'app.js'), 'export const answer = 42;\n');
await writeFile(join(companyRoot, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
await writeFile(join(companyRoot, 'drawing.svg'), '<svg><script>alert(1)</script></svg>');
const outside = await mkdtemp(join(tmpdir(), 'argo-workspace-tools-outside-'));
await writeFile(join(outside, 'outside.txt'), 'blocked');
await symlink(outside, join(companyRoot, 'escape')).catch(() => {});

const {
  listWorkspaceDirectory,
  listWorkspaceToolRoots,
  normalizeToolRelative,
  openWorkspaceToolFile,
  relativeInside,
  resolveWorkspaceToolPath,
  saveWorkspaceToolMarkdown,
  searchWorkspaceToolFiles,
  workspaceFileRenderer,
} = await import('../src/workspace-tools.mjs');

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('도구 루트는 회사 워크스페이스를 기본으로 공개한다', async () => {
  const roots = await listWorkspaceToolRoots(ws);
  assert.equal(roots.length, 1);
  assert.deepEqual(
    { id: roots[0].id, kind: roots[0].kind, label: roots[0].label },
    { id: 'company', kind: 'company', label: '도구 회사' },
  );
  assert.equal(roots[0].location, resolve(companyRoot));
});

test('루트 목록은 직속 도트파일과 루트 밖 심링크를 숨긴다', async () => {
  const data = await listWorkspaceDirectory(ws, 'company', '');
  const names = data.entries.map((entry) => entry.name);
  assert.ok(names.includes('README.md'));
  assert.ok(names.includes('src'));
  assert.ok(!names.includes('.secrets.json'));
  assert.ok(!names.includes('escape'));
});

test('상대경로 정규화와 realpath 경계가 경로 탈출을 거부한다', async () => {
  assert.equal(normalizeToolRelative('src/nested/app.js'), 'src/nested/app.js');
  for (const bad of ['../outside', 'src/../outside', '/etc/passwd', 'src\\file']) {
    assert.throws(() => normalizeToolRelative(bad), (error) => error.code === 'invalid-path');
  }
  await assert.rejects(
    () => resolveWorkspaceToolPath(ws, 'company', '.secrets.json'),
    (error) => error.code === 'protected-path' && error.status === 403,
  );
  assert.equal(relativeInside(join(companyRoot, 'src'), companyRoot), true);
  assert.equal(relativeInside(outside, companyRoot), false);
});

test('파일 열기는 Markdown·HTML 렌더러와 소스·이미지 종류를 구분한다', async () => {
  const text = await openWorkspaceToolFile(ws, 'company', 'src/nested/app.js');
  assert.equal(text.kind, 'text');
  assert.equal(text.renderer, 'source');
  assert.match(text.content, /answer = 42/);
  const markdown = await openWorkspaceToolFile(ws, 'company', 'README.md');
  assert.equal(markdown.renderer, 'markdown');
  assert.match(markdown.content, /# hello/);
  assert.match(markdown.version, /^[a-f0-9]{64}$/);
  const html = await openWorkspaceToolFile(ws, 'company', 'dashboard.html');
  assert.equal(html.renderer, 'html');
  assert.match(html.content, /<style>/);
  const image = await openWorkspaceToolFile(ws, 'company', 'pixel.png');
  assert.equal(image.kind, 'image');
  assert.equal(image.renderer, 'image');
  const svg = await openWorkspaceToolFile(ws, 'company', 'drawing.svg');
  assert.equal(svg.kind, 'text', '실행 가능한 SVG는 이미지가 아니라 소스 문서로 연다');
  const result = await searchWorkspaceToolFiles(ws, 'company', 'app.js');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].path, 'src/nested/app.js');
});

test('Markdown 저장은 원자적으로 반영하고 새 version을 반환한다', async () => {
  const opened = await openWorkspaceToolFile(ws, 'company', 'README.md');
  const saved = await saveWorkspaceToolMarkdown(
    ws,
    'company',
    'README.md',
    '# edited\n\n바로 저장됨\n',
    opened.version,
  );
  assert.equal(saved.kind, 'text');
  assert.equal(saved.renderer, 'markdown');
  assert.equal(saved.content, '# edited\n\n바로 저장됨\n');
  assert.notEqual(saved.version, opened.version);
  assert.equal(await readFile(join(companyRoot, 'README.md'), 'utf8'), saved.content);
});

test('Markdown 저장은 외부 변경과 동시 저장의 덮어쓰기를 막는다', async () => {
  await writeFile(join(companyRoot, 'README.md'), '# concurrent\n');
  const opened = await openWorkspaceToolFile(ws, 'company', 'README.md');
  const results = await Promise.allSettled([
    saveWorkspaceToolMarkdown(ws, 'company', 'README.md', '# first\n', opened.version),
    saveWorkspaceToolMarkdown(ws, 'company', 'README.md', '# second\n', opened.version),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'file-changed');
  assert.equal(rejected.reason.status, 409);
  const disk = await readFile(join(companyRoot, 'README.md'), 'utf8');
  assert.ok(disk === '# first\n' || disk === '# second\n');
});

test('Markdown 저장은 비 Markdown·보호 경로·과대 본문·잘못된 version을 거부한다', async () => {
  const source = await openWorkspaceToolFile(ws, 'company', 'src/nested/app.js');
  await assert.rejects(
    () => saveWorkspaceToolMarkdown(ws, 'company', 'src/nested/app.js', 'changed', source.version),
    (error) => error.code === 'markdown-only' && error.status === 415,
  );
  await assert.rejects(
    () => saveWorkspaceToolMarkdown(ws, 'company', '.hidden.md', '# exposed\n', 'a'.repeat(64)),
    (error) => error.code === 'protected-path' && error.status === 403,
  );
  await assert.rejects(
    () => saveWorkspaceToolMarkdown(ws, 'company', 'README.md', 'x'.repeat((2 * 1024 * 1024) + 1), 'a'.repeat(64)),
    (error) => error.code === 'too-large' && error.status === 413,
  );
  await assert.rejects(
    () => saveWorkspaceToolMarkdown(ws, 'company', 'README.md', '# no version\n', 'not-a-version'),
    (error) => error.code === 'invalid-version' && error.status === 400,
  );
});

test('문서 렌더러 분류는 Markdown과 HTML만 실행 없는 문법 뷰로 연다', () => {
  assert.equal(workspaceFileRenderer('README.MD'), 'markdown');
  assert.equal(workspaceFileRenderer('report.html'), 'html');
  assert.equal(workspaceFileRenderer('legacy.HTM'), 'html');
  assert.equal(workspaceFileRenderer('src/app.jsx'), 'source');
});
