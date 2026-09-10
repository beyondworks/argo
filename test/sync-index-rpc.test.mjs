// 동기화 색인 RPC(argo_sync_index) 배선 — 행동 테스트. 실사고 2026-09-10: 새 기기가 storage.list(=storage.search,
// RLS 아래 버킷 전수 스캔 18~29초)로 회사를 찾다 30초 타임아웃에 걸려 영영 못 찾았다. 여기서 잠그는 계약:
//   ① 색인이 있으면 discover·tombstone 둘 다 list(storage.search)를 **한 번도** 부르지 않는다
//   ② RPC 불가(미배포 셀프호스트·오류)·형태 이상은 null → 종전 list 경로로 폴백(동작 ≥ 종전), 경고는 1회
//   ③ 서비스 모드(서비스키)는 RPC를 부르지 않는다(auth.uid() 없음)
// 배선(cycle이 같은 게이트로 색인을 두 소비자에게 나눠 주는지)은 test/sync-list-cadence.test.mjs가 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-sync-index-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';
process.env.ARGO_SYNC_OWNER = 'o'; // discoverRemote의 fixed 오너 — 기기 세션 파일 없이 세션 오너를 흉내
delete process.env.SUPABASE_SERVICE_ROLE_KEY; // 세션 모드(서비스키 없음) = hostedCredsOff() true
delete process.env.NEXT_PUBLIC_SUPABASE_URL;

// 세션 오너 'o'의 기기 세션 파일 — 색인은 세션 uid의 것이라 로더가 이 uid로 RPC 결과를 대조한다. 값은 전부 이 파일의 상수(실키 아님).
import { writeFileSync } from 'node:fs';
writeFileSync(join(ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon-test', refresh_token: 'rt-test', access_token: 'at-test', expires_at: 0, user: { id: 'o', email: '' } }), { mode: 0o600 });

const { _setSyncClientForTest, _tombstonesForTest, _syncIndexForTest } = await import('../src/sync.mjs');
const { syncTombstones, discoverRemote } = _tombstonesForTest;
const { loadSyncIndex, reset } = _syncIndexForTest;

/** fake Supabase — storage list/download 호출 수를 세고, rpc는 주입한 응답을 돌려준다. */
function fake({ rpc = { data: null, error: null }, store = {} } = {}) {
  const map = new Map(Object.entries(store));
  const bucket = {
    _listCalls: 0,
    async list(prefix) {
      bucket._listCalls++;
      const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
      const names = new Map();
      for (const k of map.keys()) {
        if (!k.startsWith(p)) continue;
        const rest = k.slice(p.length);
        const seg = rest.split('/')[0];
        const isFile = !rest.includes('/');
        if (!names.has(seg) || isFile) names.set(seg, isFile);
      }
      return { data: [...names].map(([name, isFile]) => ({ name, id: isFile ? 'f' : null })) };
    },
    async download(key) {
      if (!map.has(key)) return { data: null, error: { message: 'Object not found', status: 404 } };
      const buf = map.get(key);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload() { return { error: null }; },
    async remove() { return { error: null }; },
  };
  const sb = { _rpcCalls: 0, _bucket: bucket, storage: { from: () => bucket }, async rpc(name) { sb._rpcCalls++; assert.equal(name, 'argo_sync_index'); return rpc; } };
  return sb;
}

const warnCount = async (fn) => {
  const orig = console.warn; let n = 0;
  console.warn = () => { n++; };
  try { await fn(); } finally { console.warn = orig; }
  return n;
};

test('① 색인이 있으면 discover는 list를 부르지 않고 색인의 회사만 낸다(점 접두 폴더 제외)', async () => {
  const sb = fake({ rpc: { data: { owner: 'o', companies: ['co-1', '.tombstones', 'co-2', 'Bad Slug'], tombstones: [] }, error: null } });
  _setSyncClientForTest(sb); reset();
  const index = await loadSyncIndex();
  assert.deepEqual(index, { owner: 'o', companies: ['co-1', '.tombstones', 'co-2', 'Bad Slug'], tombstones: [] });
  const found = await discoverRemote([], index);
  assert.deepEqual(found, [{ owner: 'o', wsId: 'co-1' }, { owner: 'o', wsId: 'co-2' }], 'wsId 규칙(WS_ID_RE)에 안 맞는 이름은 걸러야 한다');
  assert.equal(sb._bucket._listCalls, 0, '색인이 있는데 storage.search(list)를 불렀다');
});

test('① 색인이 있으면 원격 tombstone도 list 없이 색인으로 적용한다', async () => {
  const sb = fake({ store: { 'o/.tombstones/co-9.json': Buffer.from(JSON.stringify({ wsId: 'co-9', at: 1000 })), 'o/.tombstones/BAD.json': Buffer.from(JSON.stringify({ wsId: 'BAD', at: 1000 })) } });
  _setSyncClientForTest(sb);
  const tombs = await syncTombstones('o', { index: { owner: 'o', companies: [], tombstones: ['co-9', 'BAD'] } }); // 'BAD' = 스토리지 키 인코딩은 그대로 두되(ASCII) wsId 규칙(소문자)에는 어긋나는 값
  assert.ok(tombs.has('co-9'), '색인의 tombstone이 적용되지 않았다');
  assert.ok(!tombs.has('BAD'), 'wsId 규칙(WS_ID_RE)에 안 맞는 tombstone이 적용됐다');
  assert.equal(sb._bucket._listCalls, 0, '색인이 있는데 .tombstones list를 불렀다');
  // 대조군: 색인 없이 같은 상황 → 종전대로 list 1회
  const sb2 = fake({ store: { 'o/.tombstones/co-9.json': Buffer.from(JSON.stringify({ wsId: 'co-9', at: 1000 })) } });
  _setSyncClientForTest(sb2);
  const tombs2 = await syncTombstones('o');
  assert.ok(tombs2.has('co-9'));
  assert.equal(sb2._bucket._listCalls, 1);
});

test('② RPC 오류(미배포 셀프호스트 등)는 null → list 폴백, 경고는 1회만', async () => {
  const sb = fake({ rpc: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.argo_sync_index' } }, store: { 'o/co-7/company.json': Buffer.from('{}') } });
  _setSyncClientForTest(sb); reset();
  const warns = await warnCount(async () => {
    assert.equal(await loadSyncIndex(), null);
    assert.equal(await loadSyncIndex(), null);
  });
  assert.equal(warns, 1, '같은 실패가 매 사이클 경고를 낸다');
  const found = await discoverRemote([], null);
  assert.deepEqual(found, [{ owner: 'o', wsId: 'co-7' }], '폴백 list 경로가 회사를 못 찾는다');
  assert.equal(sb._bucket._listCalls, 1);
});

test('① 색인의 오너가 이 사이클의 오너와 다르면(ARGO_SYNC_OWNER 오설정 등) 색인을 쓰지 않고 종전 list 경로(검수 MEDIUM-1)', async () => {
  const index = { owner: 'o', companies: ['co-1'], tombstones: ['co-4'] }; // co-4 — 앞 테스트가 적용한 co-9(로컬 마커 잔존)와 겹치지 않게
  const sb = fake({ store: { 'other/co-5/company.json': Buffer.from('{}') } });
  _setSyncClientForTest(sb);
  process.env.ARGO_SYNC_OWNER = 'other';
  try {
    const found = await discoverRemote([], index);
    assert.deepEqual(found, [{ owner: 'other', wsId: 'co-5' }], '오너가 다른 색인이 회사 목록에 붙었다');
    assert.equal(sb._bucket._listCalls, 1, '오너 불일치면 list 경로여야 한다');
    const tombs = await syncTombstones('other', { index });
    assert.ok(!tombs.has('co-4'), "오너가 다른 색인의 tombstone이 적용됐다");
  } finally { process.env.ARGO_SYNC_OWNER = 'o'; }
  // 서비스 모드(오너 게이트 없음)에서 다른 오너의 tombstone 조회에 남의 색인이 끼어들면 안 된다 — 종전 list로
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-test'; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  try {
    const sb3 = fake({ store: { 'other/.tombstones/co-3.json': Buffer.from(JSON.stringify({ wsId: 'co-3', at: 1000 })) } });
    _setSyncClientForTest(sb3);
    const tombs3 = await syncTombstones('other', { index: { owner: 'o', companies: [], tombstones: ['co-4'] } });
    assert.equal(sb3._bucket._listCalls, 1, '오너가 다른 색인으로 list를 건너뛰었다');
    assert.ok(tombs3.has('co-3') && !tombs3.has('co-4'));
  } finally { delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
  // RPC가 돌려준 owner가 세션 uid와 다르면 색인 자체를 버린다(다른 사용자 문맥으로 실행된 결과)
  _setSyncClientForTest(fake({ rpc: { data: { owner: 'someone-else', companies: ['co-1'], tombstones: [] }, error: null } })); reset();
  assert.equal(await loadSyncIndex(), null);
});

test('② rpc()가 던져도(네트워크·타임아웃) null — 사이클이 죽지 않는다', async () => {
  const sb = fake(); sb.rpc = async () => { throw new Error('fetch failed'); };
  _setSyncClientForTest(sb); reset();
  assert.equal(await loadSyncIndex(), null);
});

test('② 형태 검증 — 문자열 배열 두 개가 아니면 null(서버 값을 wsId로 그대로 쓰지 않는다)', async () => {
  for (const data of [null, {}, { owner: 'o', companies: 'co-1', tombstones: [] }, { owner: 'o', companies: ['co-1'], tombstones: null }, { owner: 'o', companies: [1], tombstones: [] }, { owner: 'o', companies: ['co-1'] }, { companies: ['co-1'], tombstones: [] }]) {
    _setSyncClientForTest(fake({ rpc: { data, error: null } })); reset();
    assert.equal(await loadSyncIndex(), null, `통과되면 안 되는 형태: ${JSON.stringify(data)}`);
  }
});

test('③ 서비스 모드(서비스키 env)는 RPC를 부르지 않는다', async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-test'; // 값은 이 테스트의 상수 — 실키 아님
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // 공개키 미빌드 = 자가호스트 = 서비스롤 허용
  try {
    const sb = fake({ rpc: { data: { owner: 'o', companies: ['co-1'], tombstones: [] }, error: null } });
    _setSyncClientForTest(sb); reset();
    assert.equal(await loadSyncIndex(), null);
    assert.equal(sb._rpcCalls, 0, '서비스 모드에서 RPC를 불렀다 — auth.uid()가 없어 늘 null이다');
  } finally {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});
