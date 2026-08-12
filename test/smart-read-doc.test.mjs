import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readDoc } from '../src/hub.mjs';
import { paths } from '../src/workspace.mjs';

test('readDoc 스마트 파일 탐색 알고리즘', async () => {
  const wsId = 'test-smart-doc-ws';
  const p = paths(wsId);
  
  // 픽스처 생성
  const projectSubDir = join(p.projects, '20260812_subfolder');
  await mkdir(projectSubDir, { recursive: true });
  await writeFile(join(projectSubDir, 'target_file.md'), '# Target File Content');
  await writeFile(join(projectSubDir, 'data.txt'), 'Text Data Content');

  try {
    // 1. 완벽한 상대 경로
    const res1 = await readDoc(wsId, 'projects/20260812_subfolder/target_file.md');
    assert.equal(res1, '# Target File Content');

    // 2. projects/ 접두사 생략된 경로
    const res2 = await readDoc(wsId, '20260812_subfolder/target_file.md');
    assert.equal(res2, '# Target File Content');

    // 3. 파일명만 넘긴 경우 (재귀 탐색)
    const res3 = await readDoc(wsId, 'target_file.md');
    assert.equal(res3, '# Target File Content');

    // 4. 확장자 생략 파일명만 넘긴 경우
    const res4 = await readDoc(wsId, 'target_file');
    assert.equal(res4, '# Target File Content');

    // 5. 절대 경로 형태 (/home/.../vault/projects/20260812_subfolder/target_file.md)
    const absPath = join(p.vault, 'projects/20260812_subfolder/target_file.md');
    const res5 = await readDoc(wsId, absPath);
    assert.equal(res5, '# Target File Content');

    // 6. 비-md 파일 읽기
    const res6 = await readDoc(wsId, '20260812_subfolder/data.txt');
    assert.equal(res6, 'Text Data Content');

  } finally {
    // Cleanup
    await rm(join(p.root), { recursive: true, force: true }).catch(() => {});
  }
});
