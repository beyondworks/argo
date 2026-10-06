// F14(2026-10-05 분리 검증): '회사 보관'은 "데이터는 보관된다"고 안내하지만 앱 안에서 되돌릴 방법이 없었다.
// 잠그는 행동: ① 보관한 회사 목록(이름·보관 시각) ② 되돌리기 = .archive에서 원래 자리로, company.json mtime을 보관 시각 뒤로
// 옮겨 동기화의 tombstone 철회 규칙(sync.mjs syncTombstones 1.5: 보관 이후 수정 → 로컬·원격 철회)을 타게 한다(재보관 방지)
// ③ 같은 id 회사가 이미 있으면 덮지 않는다 ④ 경로 탈출 id 거부.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-unarchive-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // AUTH off(apimsg 관례) — 라우트 실호출
const { register } = await import('node:module');
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
const W = await import('../src/workspace.mjs');
const { createCompany, archiveCompany, paths, WS_ROOT, TOMBSTONE_DIR } = W;

test('보관한 회사가 목록에 나오고, 되돌리면 원래 자리로 돌아온다 — 재보관되지 않게 mtime이 보관 시각 뒤', async () => {
  await createCompany('co-back', '돌아올 회사', 'captain', 'owner-1');
  await archiveCompany('co-back');
  assert.equal(existsSync(paths('co-back').company), false);
  const list = await W.listArchivedCompanies();
  const it = list.find((x) => x.wsId === 'co-back');
  assert.ok(it, '보관한 회사가 목록에 있다');
  assert.equal(it.name, '돌아올 회사');
  assert.ok(it.archivedAt > 0);
  const tomb = JSON.parse(await (await import('node:fs/promises')).readFile(join(TOMBSTONE_DIR, 'co-back.json'), 'utf8'));
  const r = await W.restoreArchivedCompany(it.archiveId);
  assert.equal(r.wsId, 'co-back');
  assert.ok(existsSync(paths('co-back').company), '원래 자리로 돌아온다');
  assert.ok((await stat(paths('co-back').company)).mtimeMs >= tomb.at, '보관 이후 수정으로 보여야 동기화가 tombstone을 철회한다(재보관 방지)');
  assert.equal((await W.listArchivedCompanies()).some((x) => x.wsId === 'co-back'), false, '목록에서 빠진다');
});

test('같은 id 회사가 이미 있으면 덮지 않는다', async () => {
  await createCompany('co-dup', '첫 회사', 'captain');
  await archiveCompany('co-dup');
  await createCompany('co-dup', '새로 만든 같은 이름', 'captain');
  const it = (await W.listArchivedCompanies()).find((x) => x.wsId === 'co-dup');
  await assert.rejects(() => W.restoreArchivedCompany(it.archiveId), (e) => e.code === 'EXISTS');
  assert.ok((await readdir(join(WS_ROOT, '.archive'))).includes(it.archiveId), '보관본은 그대로 남는다');
});

test('경로 탈출·형식 밖 id는 거부한다', async () => {
  for (const bad of ['../x', '123-../../etc', 'abc', '1-', '1-.hidden', '1-A대문자']) {
    await assert.rejects(() => W.restoreArchivedCompany(bad), (e) => e.code === 'BAD_ID', bad);
  }
});

test('라우트: 목록 → 되돌리기 → 같은 이름이면 409 archive_restore_exists, 없는 항목 404', async () => {
  const route = await import('../app/api/archived-companies/route.js');
  await createCompany('co-route', '라우트 회사', 'captain');
  await archiveCompany('co-route');
  const list = await (await route.GET()).json();
  const it = list.items.find((x) => x.wsId === 'co-route');
  assert.ok(it && it.name === '라우트 회사');
  const post = (body) => route.POST(new Request('http://localhost/api/archived-companies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const ok = await post({ archiveId: it.archiveId });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).wsId, 'co-route');
  const gone = await post({ archiveId: it.archiveId });
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).errorCode, 'archive_not_found');
  const dup = (await W.listArchivedCompanies()).find((x) => x.wsId === 'co-dup');
  const clash = await post({ archiveId: dup.archiveId });
  assert.equal(clash.status, 409);
  assert.equal((await clash.json()).errorCode, 'archive_restore_exists');
});
