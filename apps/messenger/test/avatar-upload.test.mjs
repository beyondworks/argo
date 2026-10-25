// 사진 올리기 → 저장 순서(검수 D1, 2026-10-25) — 저장이 실패하면 방금 올린 파일을 Storage API로 지운다(고아 파일 0). src/avatar-upload.mjs + App 배선.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uploadThenSave } from '../src/avatar-upload.mjs';

const run = async ({ save, uploadFails = false, removeFails = false }) => {
  const log = [];
  const ok = await uploadThenSave({
    upload: async () => { log.push('upload'); if (uploadFails) throw new Error('upload'); return { url: 'https://x/a.jpg', path: 'avatars/u/a.jpg' }; },
    save: async (url) => { log.push(`save:${url}`); return save(); },
    remove: async (path) => { log.push(`remove:${path}`); if (removeFails) throw new Error('rm'); },
  }).catch((e) => `throw:${e.message}`);
  return { ok, log };
};

test('저장 성공: 올린 파일을 남긴다', async () => {
  assert.deepEqual(await run({ save: () => true }), { ok: true, log: ['upload', 'save:https://x/a.jpg'] });
});

test('저장 실패(false·오류): 방금 올린 파일만 지운다', async () => {
  assert.deepEqual(await run({ save: () => false }), { ok: false, log: ['upload', 'save:https://x/a.jpg', 'remove:avatars/u/a.jpg'] });
  const thrown = await run({ save: () => { throw new Error('v2_unsupported'); } });
  assert.equal(thrown.ok, 'throw:v2_unsupported', '저장 오류는 그대로 화면으로');
  assert.deepEqual(thrown.log.at(-1), 'remove:avatars/u/a.jpg');
  assert.equal((await run({ save: () => false, removeFails: true })).ok, false, '지우기 실패는 결과를 바꾸지 않는다');
});

test('올리기 실패: 저장·지우기 없음', async () => {
  assert.deepEqual(await run({ save: () => true, uploadFails: true }), { ok: 'throw:upload', log: ['upload'] });
});

test('배선: 사진 올리기 세 곳(에이전트 시트 둘·내 프로필)은 uploadAndSave, 지우기는 Storage API', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.equal((app.match(/await uploadAndSave\(uid, /g) ?? []).length, 3);
  assert.doesNotMatch(app, /const url = await uploadAvatar\(/, '올린 뒤 바로 저장하던 옛 순서');
  assert.match(app, /remove: \(path\) => supabase\.storage\.from\('msgr-avatars'\)\.remove\(\[path\]\)/);
});
