// 클라우드 사본 정리(R4, scripts/cloud-purge.mjs) — 로컬 가짜 storage·rpc로만 확인한다(라이브 미접촉,
// CLAUDE.md DB 위생 절대 규칙). 대상 판정 자체(purge_after)는 DB 쪽 책임 — 여기선 그 결과를 받아
// ① 회사 폴더만 삭제 후보로 모으고 ② 운영 인프라(_device-lease.json·점 접두 폴더)는 절대 건드리지
// 않으며 ③ 기본 dry-run·--confirm 불일치는 삭제하지 않는다는 계약만 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDeletable, reportFor, runCloudPurge } from '../scripts/cloud-purge.mjs';

// fakeStorage — test/cloudexport.test.mjs와 같은 list 계약(id 있으면 파일, 없으면 폴더) + metadata.size.
function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial)); // key -> { size }
  return {
    _store: store,
    async list(prefix, { offset = 0 } = {}) {
      const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
      const names = new Map(); // name -> {isFile, size}
      for (const [k, v] of store) {
        if (!k.startsWith(p)) continue;
        const rest = k.slice(p.length);
        const seg = rest.split('/')[0];
        const isFile = !rest.includes('/');
        if (!names.has(seg) || isFile) names.set(seg, { isFile, size: isFile ? v.size : 0 });
      }
      const all = [...names].map(([name, v]) => ({ name, id: v.isFile ? 'f' : null, metadata: v.isFile ? { size: v.size } : undefined }));
      return { data: all.slice(offset, offset + 100) };
    },
    async remove(keys) {
      for (const k of keys) store.delete(k);
      return { error: null };
    },
  };
}

const UID = 'u1';

test('collectDeletable: 회사 폴더만 후보 — 점 접두 폴더·직속 leaf 파일은 제외', async () => {
  const storage = fakeStorage({
    [`${UID}/_device-lease.json`]: { size: 100 }, // 직속 leaf — 리더 선출 인프라, 제외
    [`${UID}/.tg-claims/token1.json`]: { size: 50 }, // 점 접두 폴더 — 인프라, 제외
    [`${UID}/.tombstones/x`]: { size: 10 },
    [`${UID}/ws1/company.json`]: { size: 200 }, // 회사 자료 — 후보
    [`${UID}/ws1/memory/a.md`]: { size: 300 },
    [`${UID}/ws2/company.json`]: { size: 400 },
  });
  const { folders, files } = await collectDeletable(storage, UID);
  assert.deepEqual(folders.sort(), ['ws1', 'ws2']);
  const keys = files.map((f) => f.key).sort();
  assert.deepEqual(keys, [`${UID}/ws1/company.json`, `${UID}/ws1/memory/a.md`, `${UID}/ws2/company.json`]);
  assert.doesNotMatch(keys.join(','), /_device-lease|\.tg-claims|\.tombstones/, '운영 인프라가 삭제 후보에 섞이면 안 된다');
});

test('reportFor: 바이트·파일·폴더 수를 정확히 센다', async () => {
  const storage = fakeStorage({
    [`${UID}/ws1/a.txt`]: { size: 100 },
    [`${UID}/ws1/b.txt`]: { size: 250 },
  });
  const r = await reportFor(storage, { user_id: UID, purge_after: '2026-11-01T00:00:00Z' });
  assert.equal(r.folders, 1);
  assert.equal(r.files, 2);
  assert.equal(r.bytes, 350);
  assert.equal(r.userId, UID);
  assert.equal(r.purgeAfter, '2026-11-01T00:00:00Z');
});

// proNow: 목록을 뽑은 뒤 결제해 Pro가 된 계정 — is_pro_for가 true를 준다.
function fakeSb(candidates, storage, proNow = new Set()) {
  return {
    rpc: async (name, args) => {
      if (name === 'plan_purge_candidates') return { data: candidates, error: null };
      if (name === 'is_pro_for') return { data: proNow.has(args?.p_uid), error: null };
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
    storage: { from: () => storage },
  };
}

test('runCloudPurge: 기본은 dry-run — Storage에 아무것도 안 지운다', async () => {
  const storage = fakeStorage({ [`${UID}/ws1/a.txt`]: { size: 10 } });
  const sizeBefore = storage._store.size;
  const { reports, deleted } = await runCloudPurge({ sb: fakeSb([{ user_id: UID, purge_after: '2026-11-01' }], storage), log: () => {} });
  assert.equal(deleted, false);
  assert.equal(reports.length, 1);
  assert.equal(storage._store.size, sizeBefore, 'dry-run인데 객체가 지워졌다');
});

test('runCloudPurge: --confirm이 실제 대상 수와 다르면 삭제하지 않고 에러', async () => {
  const storage = fakeStorage({ [`${UID}/ws1/a.txt`]: { size: 10 } });
  await assert.rejects(
    () => runCloudPurge({ sb: fakeSb([{ user_id: UID, purge_after: '2026-11-01' }], storage), execute: true, confirm: 2, log: () => {} }),
    /confirm/,
  );
  assert.equal(storage._store.size, 1, '확인 수 불일치인데 지워졌다');
});

test('runCloudPurge: --execute + 정확한 --confirm이면 회사 폴더만 지우고 인프라는 남긴다', async () => {
  const storage = fakeStorage({
    [`${UID}/_device-lease.json`]: { size: 10 },
    [`${UID}/.tg-claims/t.json`]: { size: 10 },
    [`${UID}/ws1/a.txt`]: { size: 10 },
  });
  const { deleted, reports } = await runCloudPurge({ sb: fakeSb([{ user_id: UID, purge_after: '2026-11-01' }], storage), execute: true, confirm: 1, log: () => {} });
  assert.equal(deleted, true);
  assert.equal(reports[0].files, 1, '회사 폴더 파일 1개만 삭제 후보였어야 한다');
  assert.deepEqual([...storage._store.keys()].sort(), [`${UID}/.tg-claims/t.json`, `${UID}/_device-lease.json`], '인프라 파일은 남아야 한다');
});

test('runCloudPurge: 대상 0명이면 --execute --confirm=0도 안전하게 통과(아무것도 안 지움)', async () => {
  const storage = fakeStorage({});
  const { deleted, reports } = await runCloudPurge({ sb: fakeSb([], storage), execute: true, confirm: 0, log: () => {} });
  assert.equal(deleted, true);
  assert.equal(reports.length, 0);
});

// 보안 검수 H2(2026-09-29): 목록을 뽑은 뒤 삭제 전에 결제한 사용자의 자료를 지우면 안 된다.
test('runCloudPurge: 삭제 직전 Pro가 된 계정은 건너뛰고 자료를 남긴다', async () => {
  const storage = fakeStorage({ [`u1/ws1/a.txt`]: { size: 10 }, [`u2/ws1/b.txt`]: { size: 10 } });
  const sb = fakeSb([{ user_id: 'u1', purge_after: '2026-11-01' }, { user_id: 'u2', purge_after: '2026-11-01' }], storage, new Set(['u2']));
  const { deleted } = await runCloudPurge({ sb, execute: true, confirm: 2, log: () => {} });
  assert.equal(deleted, true);
  assert.deepEqual([...storage._store.keys()], ['u2/ws1/b.txt'], 'Pro가 된 u2의 자료는 남고 u1만 지워져야 한다');
});

test('runCloudPurge: 삭제 직전 재확인이 실패하면 그 계정을 지우지 않고 멈춘다', async () => {
  const storage = fakeStorage({ [`u1/ws1/a.txt`]: { size: 10 } });
  const sb = fakeSb([{ user_id: 'u1', purge_after: '2026-11-01' }], storage);
  const rpc = sb.rpc;
  sb.rpc = async (name, args) => (name === 'is_pro_for' ? { data: null, error: { message: 'timeout' } } : rpc(name, args));
  await assert.rejects(() => runCloudPurge({ sb, execute: true, confirm: 1, log: () => {} }), /timeout/);
  assert.equal(storage._store.size, 1, '재확인 실패인데 지워졌다');
});

// 재검수 LOW(2026-09-29): 재확인 값이 분명한 false가 아니면(null 등) 지우지 않는다 — 모호하면 보존.
test('runCloudPurge: 재확인 값이 false가 아니면(null) 건너뛴다', async () => {
  const storage = fakeStorage({ [`u1/ws1/a.txt`]: { size: 10 } });
  const sb = fakeSb([{ user_id: 'u1', purge_after: '2026-11-01' }], storage);
  const rpc = sb.rpc;
  sb.rpc = async (name, args) => (name === 'is_pro_for' ? { data: null, error: null } : rpc(name, args));
  await runCloudPurge({ sb, execute: true, confirm: 1, log: () => {} });
  assert.equal(storage._store.size, 1, '재확인 값이 모호한데 지워졌다');
});
