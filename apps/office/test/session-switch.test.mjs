// 계정 전환 배선(core/session.js) 행동 — 이 페이지에서 처음 읽은 계정과 다른 계정이 들어오면 다시 불러온다(10/4 3·4차 분리 검수).
// session.js는 Vite 환경값을 읽는 supabase.js를 들여와 노드에서 바로 못 불러오므로, 가져오기 줄을 지우고 가짜 Supabase·저장 범위를 넣어 그대로 실행한다
// (storage-scope.test.mjs·task-store.test.mjs와 같은 방식, 4차 검수 하네스 r4-session.mjs에서 옮김).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { isSameUserEcho, switchNeedsReload } from '../src/core/auth-events.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const sess = (id) => (id ? { user: { id, email: `${id}@x`, user_metadata: {} }, access_token: `t-${id}` } : null);

/** orgs(n): n번째 조직 목록 읽기의 응답(약속을 돌려주면 그때까지 기다린다) */
function boot(initial, { orgs = () => Promise.resolve({ data: [], error: null }) } = {}) {
  const log = { reload: 0, scopes: [] };
  let stored = initial, cb = null, n = 0, scope = null;
  const sb = {
    auth: { getSession: async () => ({ data: { session: sess(stored) } }), onAuthStateChange: (fn) => { cb = fn; } },
    from: () => ({ select: () => ({ eq: () => ({ is: () => orgs(++n) }) }) }),
  };
  const deps = {
    useSyncExternalStore: () => {}, SAMPLE: { SPACES: [{ key: 'me' }], ME: { id: 'sample' } },
    configured: true, getClient: async () => sb, devPasswordLogin: true, isDesktop: () => false,
    restore: () => null, persist: () => {}, setStorageScope: (u) => { scope = u; log.scopes.push(u); },
    isSameUserEcho, switchNeedsReload,
    location: { reload: () => { log.reload++; }, origin: 'http://x' },
    __imp: async (p) => (p === './store.js' ? { activateDraftScope() {} } : { activateSyncScope: async () => {} }),
  };
  const source = readFileSync(new URL('../src/core/session.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/import\('(\.\/(?:store|sync)\.js)'\)/g, "__imp('$1')");
  const module = { exports: {} };
  new Function(...Object.keys(deps), 'module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(deps), module, module.exports);
  const s = module.exports;
  const fire = async (event, id) => { if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') stored = id; if (event === 'SIGNED_OUT') stored = null; cb(event, sess(id)); await tick(); await tick(); };
  return { s, log, fire, scope: () => scope, stored: () => stored, setStored: (id) => { stored = id; } };
}

// 이유(3차 검수 HIGH): 로그아웃 뒤 다른 계정으로 로그인하면 문서함·파일 내용·회사 정보 등 모듈 캐시에 남은 앞 계정 데이터가 새 계정 화면에 보였다 —
// 다시 불러오고, 저장 범위는 새 계정으로 바꾸지 않는다(다시 불러온 페이지가 바꾼다). 4차 검수: 기준 계정을 로그아웃 때 지우면 이 테스트가 빨간불이어야 한다
test('A → 로그아웃 → B: 한 번 다시 불러오고 B 범위로 들어가지 않는다', async () => {
  const b = boot('A'); await b.s.initSession(); await tick();
  await b.fire('SIGNED_OUT', null);
  await b.fire('SIGNED_IN', 'B');
  assert.equal(b.log.reload, 1);
  assert.ok(!b.log.scopes.includes('B'), JSON.stringify(b.log.scopes));
});

// 이유: 이 페이지의 첫 로그인·같은 계정 다시 로그인·같은 사용자 되울림은 다시 불러오지 않는다(열린 창·입력 중인 내용을 잃지 않게)
test('첫 로그인·같은 계정 다시 로그인·되울림은 다시 불러오지 않는다', async () => {
  const b = boot(null); await b.s.initSession(); await tick();
  await b.fire('SIGNED_IN', 'A');
  await b.fire('SIGNED_OUT', null); await b.fire('SIGNED_IN', 'A');
  await b.fire('SIGNED_IN', 'A'); await b.fire('USER_UPDATED', 'A');
  assert.equal(b.log.reload, 0);
  await b.fire('SIGNED_IN', 'B');
  assert.equal(b.log.reload, 1, '그 뒤 다른 계정은 다시 불러온다');
  const again = boot('B'); await again.s.initSession(); await tick(); await again.fire('SIGNED_IN', 'B');
  assert.equal(again.log.reload, 0, '다시 불러온 페이지(저장소 B)에 B 방송 — 반복 없음');
});

// 이유(4차 검수 L1): 로그아웃 없이 A → B로 바로 바뀌면, 다시 불러오기 직전까지 끝나는 앞 계정 화면의 늦은 읽기가 A 초안에 B 목록을 쓸 수 있었다 —
// 저장 범위를 비우고(store.update가 거절) 화면을 내린 뒤 다시 불러온다
test('A → B 바로 전환: 다시 불러오기 직전에 저장 범위를 비우고 화면을 내린다', async () => {
  const b = boot('A'); await b.s.initSession(); await tick();
  await b.fire('SIGNED_IN', 'B');
  assert.equal(b.log.reload, 1);
  assert.equal(b.scope(), null);
  assert.equal(b.s.getMode(), 'loading');
});

// 이유(4차 검수 L2): 무시하는 두 사건(INITIAL_SESSION·TOKEN_REFRESHED)에 다른 계정이 실려 오면(페이지를 여는 사이 다른 탭이 로그인) 다시 불러오지 않았다
test('무시하는 사건에 다른 계정이 실려 오면 다시 불러온다', async () => {
  const b = boot('A'); await b.s.initSession(); await tick();
  await b.fire('TOKEN_REFRESHED', 'A');
  assert.equal(b.log.reload, 0, '같은 계정 토큰 갱신은 그대로');
  await b.fire('TOKEN_REFRESHED', 'B');
  assert.equal(b.log.reload, 1);
});

// 이유(4차 검수 L3): 탭 복귀 때 조직 목록을 확인하는 사이 로그아웃하면, 늦게 온 목록이 붙잡아 둔 옛 세션으로 apply를 불러 로그아웃한 기기에 A 화면이 되살아났다
test('탭 복귀 조직 확인 중 로그아웃하면 옛 세션으로 되살리지 않는다', async () => {
  let release = null;
  const b = boot('A', { orgs: (n) => (n === 2
    ? new Promise((r) => { release = () => r({ data: [{ role: 'member', org: { id: 'o2', name: 'New', slug: 'new' } }], error: null }); })
    : Promise.resolve({ data: [], error: null })) });
  await b.s.initSession(); await tick();
  const realNow = Date.now;
  try {
    const base = realNow(); Date.now = () => base + 61_000;
    await b.fire('SIGNED_IN', 'A'); // 탭 복귀 되울림 → 조직 목록 확인 시작(느림)
    await b.fire('SIGNED_OUT', null);
    assert.equal(b.s.getMode(), 'signedOut');
    release(); await tick(); await tick(); await tick();
    assert.equal(b.s.getMode(), 'signedOut', '늦은 조직 목록이 와도 로그아웃 그대로');
    assert.notEqual(b.s.ME.id, 'A');
  } finally { Date.now = realNow; }
});
