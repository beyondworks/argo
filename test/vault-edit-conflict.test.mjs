// F6(2026-10-05 분리 검증): 기억 문서 편집 저장이 통째 덮어쓰기였다 — 편집하는 동안 크루·다른 기기(동기화)가 바꾼 내용이
// 조용히 사라졌다. 잠그는 행동: 열 때 받은 버전을 보내고, 서버의 지금 내용이 다르면 409(vault_conflict) — 덮지 않는다.
// 사용자가 "내 것으로 덮기"를 고르면(force) 그때만 덮는다. 쓰기는 임시 파일 + rename(원자적).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-vaultcf-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // AUTH off(apimsg 관례)
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
const { createCompany, paths } = await import('../src/workspace.mjs');
const WS = 'co-vaultcf';
await createCompany(WS, '기억 충돌 회사', 'captain');
await mkdir(paths(WS).notes, { recursive: true });
const rel = 'notes/plan.md';
const file = join(paths(WS).vault, rel);
await writeFile(file, '# 계획\n\n처음 내용\n');
const route = await import('../app/api/companies/[ws]/vault/route.js');
const ctx = { params: Promise.resolve({ ws: WS }) };
const get = async () => (await route.GET(new Request(`http://localhost/api/companies/${WS}/vault?rel=${encodeURIComponent(rel)}`), ctx)).json();
const put = (body) => route.PUT(new Request(`http://localhost/api/companies/${WS}/vault`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctx);

test('열 때 버전과 지금 내용이 다르면 409 — 다른 곳의 변경을 덮지 않는다', async () => {
  const opened = await get();
  assert.ok(opened.version, 'GET이 열 때의 버전을 준다');
  await writeFile(file, '# 계획\n\n크루가 고친 내용\n'); // 편집하는 동안 크루·동기화가 바꿨다
  const res = await put({ rel, content: '# 계획\n\n내가 고친 내용', baseVersion: opened.version });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.errorCode, 'vault_conflict');
  assert.match(await readFile(file, 'utf8'), /크루가 고친 내용/, '다른 곳의 변경이 그대로 남는다');
  assert.ok(body.version && body.version !== opened.version, '지금 버전을 알려 준다');
});

test('버전이 같으면 저장하고 새 버전을 돌려준다 — 덮기(force)는 사용자가 고른 때만', async () => {
  const cur = await get();
  const ok = await put({ rel, content: '# 계획\n\n내가 고친 내용', baseVersion: cur.version });
  assert.equal(ok.status, 200);
  const saved = await ok.json();
  assert.equal(saved.version, (await get()).version, '저장 뒤 버전 = 지금 내용의 버전');
  await writeFile(file, '# 계획\n\n또 바뀜\n');
  const forced = await put({ rel, content: '# 계획\n\n내 것으로 덮기', baseVersion: cur.version, force: true });
  assert.equal(forced.status, 200);
  assert.match(await readFile(file, 'utf8'), /내 것으로 덮기/);
  assert.deepEqual((await readdir(paths(WS).notes)).filter((n) => !n.endsWith('.md')), [], '임시 파일이 남지 않는다(원자적 쓰기)');
});

test('버전을 안 보내는 옛 화면은 종전처럼 저장된다(하위 호환)', async () => {
  const res = await put({ rel, content: '# 계획\n\n옛 화면 저장' });
  assert.equal(res.status, 200);
  assert.match(await readFile(file, 'utf8'), /옛 화면 저장/);
});

test('화면 판정 — 409 vault_conflict만 충돌 선택지, 그 밖 실패는 오류 문구', async () => {
  const { vaultSaveOutcome } = await import('../app/c/[ws]/vault/vault-doc.mjs');
  assert.equal(vaultSaveOutcome(200, { ok: true }), 'saved');
  assert.equal(vaultSaveOutcome(409, { errorCode: 'vault_conflict' }), 'conflict');
  assert.equal(vaultSaveOutcome(400, { error: 'x' }), 'error');
  assert.equal(vaultSaveOutcome(409, {}), 'error', '코드 없는 409는 충돌로 단정하지 않는다');
});

test('UX-A11: 읽기 화면은 frontmatter를 떼고 본문만 그린다(편집은 원문)', async () => {
  const { stripFrontmatter } = await import('../app/c/[ws]/vault/vault-doc.mjs');
  assert.equal(stripFrontmatter('---\ntitle: Argo 폴더 사용법\n---\n# 본문\n'), '# 본문\n');
  assert.equal(stripFrontmatter('# 본문\n\n---\n\n아래'), '# 본문\n\n---\n\n아래', '본문 중간의 구분선은 건드리지 않는다');
});
