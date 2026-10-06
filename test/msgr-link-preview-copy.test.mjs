// 링크 미리보기 규칙 사본 고정(2026-10-02) — 정본 src/link-preview.mjs와 엣지 함수 사본 supabase/functions/_shared/link-preview.js는 바이트까지 같아야 한다.
// 사본을 두는 이유: 엣지 함수 배포 묶음은 supabase/functions 안만, 본체 앱 서버 묶음(scripts/stage-cli.mjs)은 src/만 싣는다.
// 처음에는 게이트웨이가 supabase/functions 쪽을 직접 불러 설치본 서버 트리에서 모듈을 못 찾았다(test/stage-cli-tree.test.mjs가 잡음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('엣지 함수 사본은 정본과 같다 — 다르면 사람 글과 에이전트 글의 미리보기 규칙(SSRF 검사 포함)이 갈라진다', () => {
  assert.equal(read('supabase/functions/_shared/link-preview.js'), read('src/link-preview.mjs'), '고칠 때: cp src/link-preview.mjs supabase/functions/_shared/link-preview.js');
});

test('본체(src)와 앱은 정본을, 엣지 함수는 사본을 부른다 — src 밖을 부르면 설치본 서버 트리에서 깨진다', () => {
  assert.match(read('src/gateway/link-preview-node.mjs'), /from '\.\.\/link-preview\.mjs'/);
  assert.match(read('apps/messenger/src/media-actions.mjs'), /from '\.\.\/\.\.\/\.\.\/src\/link-preview\.mjs'/);
  assert.match(read('apps/messenger/src/media.jsx'), /from '\.\.\/\.\.\/\.\.\/src\/link-preview\.mjs'/);
  assert.match(read('supabase/functions/msgr-link-preview/core.js'), /from '\.\.\/_shared\/link-preview\.js'/);
});
