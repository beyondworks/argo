import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const argoRoot = await mkdtemp(join(tmpdir(), 'argo-openai-tools-'));
process.env.ARGO_ROOT = argoRoot;
const { createOpenAICompatToolRegistry, OPENAI_COMPAT_NATIVE_TOOL_NAMES } = await import('../src/openai-compat-tools.mjs');
const { isPrivateWebAddress, parseScraplingSearchMarkdown } = await import('../src/scrapling.mjs');

test.after(async () => { await rm(argoRoot, { recursive: true, force: true }); });

async function fixture(caps = { fs: false, browser: false, shell: false, bypass: false }) {
  const wsId = `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const root = join(argoRoot, wsId);
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'notes'), { recursive: true });
  await mkdir(join(root, 'skills'), { recursive: true });
  await writeFile(join(root, 'company.json'), JSON.stringify({ id: wsId, name: 'Test', lang: 'ko' }));
  await writeFile(join(root, 'capabilities.json'), JSON.stringify(caps));
  await writeFile(join(root, 'approvals.json'), '[]');
  await writeFile(join(root, 'routines.json'), '[]');
  await writeFile(join(vault, 'notes', 'source.md'), '# 상품\nAlpha 100원\nBeta 200원\n');
  const artifacts = [];
  const registry = await createOpenAICompatToolRegistry({
    wsId, agentSlug: 'crew-a', agentName: 'Crew A', root, vaultRoot: vault,
    caps, workRoots: [], colleagues: [],
    onArtifact: (rel) => artifacts.push(rel), runChat: async () => ({ reply: '' }),
  });
  return { wsId, root, vault, artifacts, registry };
}

test('Qwen 네이티브 도구 목록 — Codex급 파일·검색·편집·셸·웹과 Argo 크루 도구를 노출', () => {
  for (const name of ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'apply_patch', 'run_command', 'web_search', 'web_fetch', 'delegate', 'send_to_crew']) {
    assert.ok(OPENAI_COMPAT_NATIVE_TOOL_NAMES.includes(name), name);
  }
});

test('Qwen 파일 도구 — 읽기·목록·검색·쓰기·편집과 산출물 추적이 실제 파일에 적용', async () => {
  const f = await fixture();
  try {
    const read = await f.registry.execute('read_file', { path: 'vault/notes/source.md' });
    assert.match(read, /Alpha 100원/);
    assert.match(read, new RegExp(`sha256:${createHash('sha256').update('# 상품\nAlpha 100원\nBeta 200원\n').digest('hex')}`));
    assert.equal(await f.registry.hasReadEvidence(join(f.vault, 'notes', 'source.md')), true);
    assert.deepEqual(f.registry.readEvidence().map((item) => item.sha256), [createHash('sha256').update('# 상품\nAlpha 100원\nBeta 200원\n').digest('hex')]);
    assert.match(await f.registry.execute('list_files', { path: 'vault' }), /notes\/source\.md/);
    assert.match(await f.registry.execute('search_files', { path: 'vault', query: 'Beta' }), /source\.md:3/);
    assert.match(await f.registry.execute('write_file', { path: 'vault/projects/result.md', content: '# 결과\n초안\n' }), /저장함/);
    assert.match(await f.registry.execute('edit_file', { path: 'vault/projects/result.md', old_text: '초안', new_text: '완성' }), /수정함/);
    assert.match(await f.registry.execute('apply_patch', { path: 'vault/projects/result.md', edits: [
      { old_text: '# 결과', new_text: '# 최종 결과' }, { old_text: '완성', new_text: '검증됨' },
    ] }), /패치 적용함/);
    assert.equal(await readFile(join(f.vault, 'projects', 'result.md'), 'utf8'), '# 최종 결과\n검증됨\n');
    assert.deepEqual(f.artifacts, ['projects/result.md', 'projects/result.md', 'projects/result.md']);
  } finally { await f.registry.close(); }
});

test('Qwen 파일 증거 — 범위 밖 offset은 원문 미전달이므로 성공 증거가 아님', async () => {
  const f = await fixture();
  try {
    assert.match(await f.registry.execute('read_file', { path: 'vault/notes/source.md', offset: 999999 }), /파일 범위를 벗어났다/);
    assert.equal(await f.registry.hasReadEvidence(join(f.vault, 'notes', 'source.md')), false);
    assert.deepEqual(f.registry.readEvidence(), []);
  } finally { await f.registry.close(); }
});

test('Qwen 파일 증거 — 부분 읽기는 부족하고 여러 구간이 전체를 덮으면 완성', async () => {
  const f = await fixture();
  const target = join(f.vault, 'notes', 'source.md');
  try {
    assert.match(await f.registry.execute('read_file', { path: 'vault/notes/source.md', offset: 1, limit: 2 }), /lines 1-2 of 4/);
    assert.equal(await f.registry.hasReadEvidence(target), false);
    assert.deepEqual(f.registry.readEvidence(), []);
    assert.match(await f.registry.execute('read_file', { path: 'vault/notes/source.md', offset: 3, limit: 2 }), /lines 3-4 of 4/);
    assert.equal(await f.registry.hasReadEvidence(target), true);
    assert.equal(f.registry.readEvidence().length, 1);
  } finally { await f.registry.close(); }
});

test('Qwen 파일 증거 — 도구 출력에서 잘릴 긴 행은 전체 읽기 증거가 아님', async () => {
  const f = await fixture();
  const target = join(f.vault, 'notes', 'long.txt');
  await writeFile(target, 'x'.repeat(120_001));
  try {
    assert.match(await f.registry.execute('read_file', { path: 'vault/notes/long.txt' }), /도구 출력 상한을 넘었다/);
    assert.equal(await f.registry.hasReadEvidence(target), false);
    assert.deepEqual(f.registry.readEvidence(), []);
  } finally { await f.registry.close(); }
});

test('Qwen 파일 증거 — 65001행 파일도 10000행 단위 범위 읽기로 완독', async () => {
  const f = await fixture();
  const target = join(f.vault, 'notes', 'many-lines.txt');
  await writeFile(target, `${'x\n'.repeat(65_000)}x`);
  try {
    for (let offset = 1; offset <= 65_001; offset += 10_000) {
      assert.doesNotMatch(await f.registry.execute('read_file', {
        path: 'vault/notes/many-lines.txt', offset, limit: 10_000,
      }), /도구 출력 상한을 넘었다/);
    }
    assert.equal(await f.registry.hasReadEvidence(target), true);
  } finally { await f.registry.close(); }
});

test('Qwen 파일 증거 — 읽은 뒤 파일 내용이 바뀌면 이전 증거를 무효화', async () => {
  const f = await fixture();
  const target = join(f.vault, 'notes', 'source.md');
  try {
    await f.registry.execute('read_file', { path: 'vault/notes/source.md', limit: 10_000 });
    assert.equal(await f.registry.hasReadEvidence(target), true);
    await writeFile(target, '# 변경됨\n');
    assert.equal(await f.registry.hasReadEvidence(target), false);
  } finally { await f.registry.close(); }
});

test('Qwen 도구 권한 — 회사 금고·꺼진 셸·꺼진 웹은 기존 permission-gate가 차단', async () => {
  const f = await fixture();
  try {
    assert.match(await f.registry.execute('write_file', { path: 'capabilities.json', content: '{"shell":true}' }), /도구 거부/);
    assert.match(await f.registry.execute('run_command', { command: 'pwd' }), /도구 거부/);
    assert.match(await f.registry.execute('web_search', { query: 'test' }), /도구 거부/);
  } finally { await f.registry.close(); }
});

test('Qwen 파일 도구 — 허용 폴더 안 심볼릭 링크로 외부 파일을 읽거나 쓰지 못함', async () => {
  const f = await fixture();
  const outsideFile = join(argoRoot, `outside-${Date.now()}.md`);
  const outsideDir = join(argoRoot, `outside-dir-${Date.now()}`);
  await writeFile(outsideFile, '외부 비밀');
  await mkdir(outsideDir);
  await symlink(outsideFile, join(f.vault, 'notes', 'escape.md'));
  await symlink(outsideDir, join(f.vault, 'escape-dir'));
  try {
    assert.match(await f.registry.execute('read_file', { path: 'vault/notes/escape.md' }), /도구 거부/);
    assert.equal(await f.registry.hasReadEvidence(join(f.vault, 'notes', 'escape.md')), false);
    assert.deepEqual(f.registry.readEvidence(), []);
    assert.match(await f.registry.execute('list_files', { path: 'vault/escape-dir' }), /도구 거부/);
    assert.match(await f.registry.execute('write_file', { path: 'vault/escape-dir/new.md', content: '탈출' }), /도구 거부/);
    await assert.rejects(readFile(join(outsideDir, 'new.md')));
  } finally {
    await f.registry.close();
    await rm(outsideFile, { force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('Qwen 셸 도구 — shell 능력이 켜진 회사에서 명령 실행, 서버·모델 자격 env는 제거', async () => {
  const f = await fixture({ fs: false, browser: false, shell: true, bypass: false });
  const old = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-server-value';
  try {
    const command = `"${process.execPath}" -e "process.stdout.write(process.env.SUPABASE_SERVICE_ROLE_KEY || 'clean')"`;
    assert.equal(await f.registry.execute('run_command', { command }), 'clean');
  } finally {
    if (old === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = old;
    await f.registry.close();
  }
});

test('Qwen 셸 도구 — 턴 중단 시 실행 중인 프로세스 그룹을 즉시 종료', async () => {
  const f = await fixture({ fs: false, browser: false, shell: true, bypass: false });
  const controller = new AbortController();
  const started = Date.now();
  try {
    const pending = f.registry.execute('run_command', {
      command: `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`, timeout_seconds: 30,
    }, { signal: controller.signal });
    setTimeout(() => controller.abort(new DOMException('테스트 중단', 'AbortError')), 30);
    assert.match(await pending, /도구 오류|명령 실패/);
    assert.ok(Date.now() - started < 3000, '중단된 명령이 제한 시간까지 남아 있으면 안 됨');
  } finally {
    await f.registry.close();
  }
});

test('Qwen 셸 도구 — 허용 폴더 안 cwd 심볼릭 링크로 외부에서 실행하지 못함', async () => {
  const f = await fixture({ fs: false, browser: false, shell: true, bypass: false });
  const outsideDir = join(argoRoot, `shell-outside-${Date.now()}`);
  await mkdir(outsideDir);
  await symlink(outsideDir, join(f.vault, 'shell-escape'));
  try {
    assert.match(await f.registry.execute('run_command', { command: 'pwd', cwd: 'vault/shell-escape' }), /도구 거부/);
  } finally {
    await f.registry.close();
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('Scrapling 웹 안전·검색 파서 — 사설 주소 차단 분류와 DuckDuckGo URL 복원', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0::ffff:a00:1']) assert.equal(isPrivateWebAddress(ip), true, ip);
  assert.equal(isPrivateWebAddress('93.184.216.34'), false);
  const md = '[Example](//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x)\n[duplicate](//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=y)';
  assert.deepEqual(parseScraplingSearchMarkdown(md), [{ title: 'Example', url: 'https://example.com/a' }]);
});
